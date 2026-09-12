import { NextRequest, NextResponse } from "next/server";
import { createOrder, listOrders, priceForCredits } from "@/lib/payments";
import { getCreditBalance } from "@/lib/credits";
import { getSetting, getSettingInt } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { callerId as resolveCallerId } from "@/lib/request-user";

/**
 * 用户侧充值接口
 * GET  → 我的账单：余额 + 积分单价 + 历史订单
 * POST → 创建充值订单（{ credits } 或 { amountCents }）
 *
 * 说明：订单创建后由所选支付通道完成收款，收款结果只能通过
 * /api/payments/webhook（验签）或管理员后台手工确认来落地，客户端无法自行"标记已付"。
 */
export async function GET(request: NextRequest) {
  const userId = resolveCallerId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized: 缺少身份信息" }, { status: 401 });
  return NextResponse.json({
    balance: getCreditBalance(userId),
    creditPriceCents: getSettingInt("creditPriceCents", 100),
    minTopupCredits: getSettingInt("minTopupCredits", 10),
    provider: getSetting("paymentProvider") || "manual",
    orders: listOrders({ userId, limit: 50 }),
  });
}

export async function POST(request: NextRequest) {
  const userId = resolveCallerId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized: 缺少身份信息" }, { status: 401 });

  let body: { credits?: number; amountCents?: number; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
  }

  const unit = Math.max(1, getSettingInt("creditPriceCents", 100));
  const minCredits = Math.max(1, getSettingInt("minTopupCredits", 10));
  let credits = Number.isFinite(body.credits as number) ? Math.trunc(body.credits as number) : 0;
  if (!credits && Number.isFinite(body.amountCents as number)) {
    credits = Math.floor(Math.trunc(body.amountCents as number) / unit);
  }
  if (credits < minCredits) {
    return NextResponse.json(
      { error: `最少充值 ${minCredits} 积分（当前填写 ${credits}）` },
      { status: 400 },
    );
  }
  // 上限保护：避免误填超大数字造成异常订单
  if (credits > 1_000_000) {
    return NextResponse.json({ error: "单笔充值积分过大" }, { status: 400 });
  }

  try {
    const order = createOrder({
      userId,
      credits,
      amountCents: priceForCredits(credits),
      provider: getSetting("paymentProvider") || "manual",
      note: typeof body.note === "string" ? body.note.slice(0, 200) : undefined,
    });
    logAudit(userId, "payment.order_create", { orderId: order.id, credits, amountCents: order.amountCents });
    return NextResponse.json({ ok: true, order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "下单失败" }, { status: 400 });
  }
}
