import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import {
  listOrders,
  ordersSummary,
  listPaymentEvents,
  createOrder,
  markOrderPaid,
  refundOrder,
  cancelOrder,
  priceForCredits,
  type OrderStatus,
} from "@/lib/payments";
import { getUserById } from "@/lib/users";
import { logAudit } from "@/lib/audit";

/**
 * 订单与收款管理（admin）
 *
 * GET  ?status=&userId=&limit=&events=1
 *      → 订单列表 + 汇总（已收金额/退款/待确认）+ 可选回调事件流
 * POST { action }
 *      - create  : { userId, credits, note? } 建充值单（线下收款/开票场景）
 *      - markPaid: { orderId, externalId?, note? } 人工确认到账（幂等）
 *      - refund  : { orderId, note? } 退款并回收积分（幂等；余额不足则拒绝）
 *      - cancel  : { orderId, note? } 取消待支付订单
 */
export async function GET(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  const sp = request.nextUrl.searchParams;
  const statusRaw = sp.get("status") || "";
  const status = (["pending", "paid", "refunded", "canceled"] as const).includes(statusRaw as OrderStatus)
    ? (statusRaw as OrderStatus)
    : undefined;
  const rawLimit = Number(sp.get("limit") ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;

  return NextResponse.json({
    orders: listOrders({ status, userId: sp.get("userId") || undefined, limit }),
    summary: ordersSummary(),
    events: sp.get("events") === "1" ? listPaymentEvents(limit) : undefined,
  });
}

export async function POST(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  let body: { action?: string; userId?: string; credits?: number; amountCents?: number; orderId?: string; externalId?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "create": {
        const userId = (body.userId || "").trim();
        if (!userId) return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
        if (!getUserById(userId)) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
        const credits = Math.trunc(Number(body.credits || 0));
        if (!Number.isFinite(credits) || credits <= 0 || credits > 1_000_000) {
          return NextResponse.json({ error: "积分数不合法" }, { status: 400 });
        }
        const amountCents = Number.isFinite(body.amountCents as number)
          ? Math.max(0, Math.trunc(body.amountCents as number))
          : priceForCredits(credits);
        const order = createOrder({ userId, credits, amountCents, provider: "manual", note: body.note });
        logAudit(admin.id, "admin.order_create", { orderId: order.id, userId, credits, amountCents });
        return NextResponse.json({ ok: true, order });
      }

      case "markPaid": {
        const orderId = (body.orderId || "").trim();
        if (!orderId) return NextResponse.json({ error: "缺少 orderId" }, { status: 400 });
        const res = markOrderPaid(orderId, { externalId: body.externalId, provider: "manual" });
        logAudit(admin.id, res.ok ? "admin.order_mark_paid" : "admin.order_mark_paid_failed", {
          orderId, credited: res.credited, reason: res.reason, externalId: body.externalId,
        });
        if (!res.ok) return NextResponse.json({ error: res.reason || "确认失败" }, { status: 409 });
        return NextResponse.json({ ok: true, credited: res.credited, order: res.order });
      }

      case "refund": {
        const orderId = (body.orderId || "").trim();
        if (!orderId) return NextResponse.json({ error: "缺少 orderId" }, { status: 400 });
        const res = refundOrder(orderId, body.note);
        logAudit(admin.id, res.ok ? "admin.order_refund" : "admin.order_refund_failed", {
          orderId, revoked: res.revoked, reason: res.reason,
        });
        if (!res.ok) return NextResponse.json({ error: res.reason || "退款失败" }, { status: 409 });
        return NextResponse.json({ ok: true, revoked: res.revoked, order: res.order });
      }

      case "cancel": {
        const orderId = (body.orderId || "").trim();
        if (!orderId) return NextResponse.json({ error: "缺少 orderId" }, { status: 400 });
        const res = cancelOrder(orderId, body.note);
        logAudit(admin.id, "admin.order_cancel", { orderId, ok: res.ok, reason: res.reason });
        if (!res.ok) return NextResponse.json({ error: res.reason || "取消失败" }, { status: 409 });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "未知操作" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
  }
}
