import { NextRequest, NextResponse } from "next/server";
import {
  verifySignature,
  webhookConfigured,
  recordEvent,
  markEventApplied,
  markOrderPaid,
  refundOrder,
  getOrder,
} from "@/lib/payments";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/payments/webhook — 支付方回调（通道无关）
 *
 * 安全与幂等：
 * - **验签**：HMAC-SHA256(rawBody, PAYMENT_WEBHOOK_SECRET)，常量时间比较；
 *   未配置密钥时直接 503（fail-closed，绝不裸奔入账）
 * - **幂等**：payment_events(provider, event_id) 唯一索引 + orders.external_id 唯一索引
 *   + credit_ledger(reason='payment.credit', ref=external_id) 唯一索引，三重防重放
 * - **金额校验**：回调金额与订单金额不一致 → 不入账，落事件待人工核对
 * - 该路由在 proxy 中豁免会话鉴权（支付方无法携带用户 Cookie），身份凭签名建立
 *
 * 请求体（约定格式，通道适配时映射到该结构即可）：
 * {
 *   "event_id": "evt_123",            // 支付方事件号（幂等键，建议必填）
 *   "type": "payment.succeeded",      // payment.succeeded | refund.succeeded
 *   "order_id": "ord_xxx",            // 本地订单号
 *   "external_id": "wx_42000...",     // 支付方交易号（入账幂等键）
 *   "amount_cents": 10000             // 实付金额（分）
 * }
 * 签名头：x-payment-signature: <hex>（也兼容 sha256=<hex> 前缀）
 */
export async function POST(request: NextRequest) {
  if (!webhookConfigured()) {
    return NextResponse.json(
      { error: "支付回调未配置：请设置环境变量 PAYMENT_WEBHOOK_SECRET" },
      { status: 503 },
    );
  }

  const raw = await request.text();
  const signature =
    request.headers.get("x-payment-signature") ||
    request.headers.get("x-signature") ||
    request.headers.get("x-pay-signature");

  const signatureOk = verifySignature(raw, signature);

  let body: {
    event_id?: string;
    type?: string;
    order_id?: string;
    external_id?: string;
    amount_cents?: number;
    provider?: string;
  } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    recordEvent({
      provider: body.provider || "unknown",
      eventType: "invalid_json",
      signatureOk,
      applied: false,
      reason: "报文不是合法 JSON",
      payload: raw,
    });
    return NextResponse.json({ error: "报文格式错误" }, { status: 400 });
  }

  const provider = (body.provider || request.headers.get("x-payment-provider") || "generic").slice(0, 32);
  const eventType = (body.type || "").slice(0, 64);
  const orderId = (body.order_id || "").slice(0, 64);
  const externalId = (body.external_id || "").slice(0, 128) || undefined;

  // 验签失败：记录但不做任何业务改动
  if (!signatureOk) {
    recordEvent({
      provider,
      eventId: body.event_id,
      eventType: eventType || "unknown",
      orderId,
      externalId,
      amountCents: body.amount_cents,
      signatureOk: false,
      applied: false,
      reason: "签名校验失败",
      payload: raw,
    });
    logAudit("unknown", "payment.signature_invalid", { provider, orderId });
    return NextResponse.json({ error: "签名校验失败" }, { status: 401 });
  }

  if (!eventType || !orderId) {
    recordEvent({
      provider,
      eventId: body.event_id,
      eventType: eventType || "unknown",
      orderId,
      signatureOk: true,
      applied: false,
      reason: "缺少 type 或 order_id",
      payload: raw,
    });
    return NextResponse.json({ error: "缺少 type 或 order_id" }, { status: 400 });
  }

  const order = getOrder(orderId);
  if (!order) {
    recordEvent({
      provider, eventId: body.event_id, eventType, orderId, externalId,
      amountCents: body.amount_cents, signatureOk: true, applied: false,
      reason: "订单不存在", payload: raw,
    });
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }

  // 幂等：同一事件号只处理一次（重复回调直接成功返回，避免支付方重试风暴）
  const isNew = recordEvent({
    provider,
    eventId: body.event_id,
    eventType,
    orderId,
    externalId,
    amountCents: body.amount_cents,
    signatureOk: true,
    applied: false,
    payload: raw,
  });
  if (!isNew) {
    return NextResponse.json({ ok: true, duplicated: true });
  }

  if (eventType === "payment.succeeded") {
    // 金额校验：不一致则不入账（防少付/篡改）
    if (
      typeof body.amount_cents === "number" &&
      Number.isFinite(body.amount_cents) &&
      Math.trunc(body.amount_cents) !== order.amountCents
    ) {
      recordEvent({
        provider, eventId: body.event_id, eventType: "payment.amount_mismatch", orderId, externalId,
        amountCents: body.amount_cents, signatureOk: true, applied: false,
        reason: `金额不符：订单 ${order.amountCents} 分，回调 ${body.amount_cents} 分`,
      });
      markEventApplied(provider, body.event_id);
      logAudit(order.userId, "payment.amount_mismatch", { orderId, expected: order.amountCents, got: body.amount_cents });
      return NextResponse.json({ ok: false, error: "金额与订单不一致，已记录待人工核对" }, { status: 409 });
    }

    const res = markOrderPaid(orderId, { externalId, provider });
    if (!res.ok) {
      recordEvent({
        provider, eventId: body.event_id, eventType: "payment.not_applied", orderId, externalId,
        signatureOk: true, applied: false, reason: res.reason,
      });
      return NextResponse.json({ ok: false, error: res.reason }, { status: 409 });
    }
    markEventApplied(provider, body.event_id);
    logAudit(order.userId, "payment.paid", {
      orderId, credits: order.credits, amountCents: order.amountCents, externalId, credited: res.credited,
    });
    return NextResponse.json({ ok: true, credited: res.credited });
  }

  if (eventType === "refund.succeeded") {
    const res = refundOrder(orderId, `通道退款回调（${provider}）`);
    if (res.ok) markEventApplied(provider, body.event_id);
    logAudit(order.userId, res.ok ? "payment.refunded" : "payment.refund_failed", {
      orderId, reason: res.reason, revoked: res.revoked, by: "webhook",
    });
    if (!res.ok) {
      recordEvent({
        provider, eventId: body.event_id, eventType: "refund.not_applied", orderId, externalId,
        signatureOk: true, applied: false, reason: res.reason,
      });
      return NextResponse.json({ ok: false, error: res.reason }, { status: 409 });
    }
    return NextResponse.json({ ok: true, revoked: res.revoked });
  }

  // 其他事件类型：已记录，忽略
  return NextResponse.json({ ok: true, ignored: eventType });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
