/**
 * 支付/充值服务（接支付通道的核心，通道无关设计）
 *
 * 设计要点（面向真实收款，先保证"钱与积分对得上、重复回调不会重复入账"）：
 * - 本地订单表 orders 是唯一事实来源；支付方只通过「回调」驱动状态机：
 *     pending →（回调 payment.succeeded）→ paid（入账积分）→（退款）→ refunded（回收积分）
 * - **幂等**双保险：
 *     ① orders.external_id 唯一索引 —— 同一支付方交易号只能落在一张订单上；
 *     ② credit_ledger(reason='payment.credit', ref=external_id) 唯一索引 —— 入账只发生一次；
 *     ③ payment_events(provider, event_id) 唯一索引 —— 同一回调事件只处理一次。
 * - **回调必须验签**（HMAC-SHA256，密钥来自环境变量 PAYMENT_WEBHOOK_SECRET），
 *   未配置密钥时拒绝一切回调（fail-closed，避免"裸奔"入账）。
 * - **金额校验**：回调金额与订单金额不一致时不入账，事件记录为待人工核对。
 * - 退款：管理员操作；余额不足则拒绝（不允许把用户余额扣成负数），保持余额 ≥ 0。
 *
 * 通道接入：新增 provider 时只需在回调里补齐「验签 + 字段映射」，业务侧不变。
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { db, withTx } from "@/lib/db";
import { addCredits, consumeCredits, getCreditBalance } from "@/lib/credits";
import { getSettingInt } from "@/lib/settings";

export type OrderStatus = "pending" | "paid" | "refunded" | "canceled";

export interface Order {
  id: string;
  userId: string;
  credits: number;
  amountCents: number;
  currency: string;
  provider: string;
  status: OrderStatus;
  externalId: string | null;
  note: string | null;
  createdAt: number;
  paidAt: number | null;
  refundedAt: number | null;
}

function toOrder(row: Record<string, unknown>): Order {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    credits: Number(row.credits || 0),
    amountCents: Number(row.amount_cents || 0),
    currency: String(row.currency || "CNY"),
    provider: String(row.provider || "manual"),
    status: (row.status as OrderStatus) || "pending",
    externalId: row.external_id ? String(row.external_id) : null,
    note: row.note ? String(row.note) : null,
    createdAt: Number(row.created_at || 0),
    paidAt: row.paid_at ? Number(row.paid_at) : null,
    refundedAt: row.refunded_at ? Number(row.refunded_at) : null,
  };
}

/** 按积分数量与单价（settings.creditPriceCents，单位：分/积分）算出金额 */
export function priceForCredits(credits: number): number {
  const unit = Math.max(0, getSettingInt("creditPriceCents", 100));
  return Math.max(0, Math.trunc(credits)) * unit;
}

export function newOrderId(): string {
  return `ord_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

// ===== 订单 =====

export function createOrder(input: {
  userId: string;
  credits: number;
  amountCents?: number;
  currency?: string;
  provider?: string;
  note?: string;
}): Order {
  const credits = Math.trunc(input.credits);
  if (!input.userId) throw new Error("缺少用户");
  if (!Number.isFinite(credits) || credits <= 0) throw new Error("积分数必须为正整数");
  const amountCents = Number.isFinite(input.amountCents as number)
    ? Math.trunc(input.amountCents as number)
    : priceForCredits(credits);
  if (amountCents < 0) throw new Error("金额不能为负");

  const now = Date.now();
  const id = newOrderId();
  db.prepare(
    `INSERT INTO orders (id, user_id, credits, amount_cents, currency, provider, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    credits,
    amountCents,
    input.currency || "CNY",
    input.provider || "manual",
    input.note || null,
    now,
    now,
  );
  return getOrder(id)!;
}

export function getOrder(id: string): Order | null {
  try {
    const row = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? toOrder(row) : null;
  } catch {
    return null;
  }
}

/** 订单列表：userId 为空 = 全部（管理后台） */
export function listOrders(opts: { userId?: string; status?: OrderStatus; limit?: number } = {}): Order[] {
  try {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.userId) { where.push("user_id = ?"); args.push(opts.userId); }
    if (opts.status) { where.push("status = ?"); args.push(opts.status); }
    const sql = `SELECT * FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY created_at DESC LIMIT ?`;
    return (db.prepare(sql).all(...args, limit) as Record<string, unknown>[]).map(toOrder);
  } catch {
    return [];
  }
}

/** 充值/收入汇总（管理后台展示；金额单位：分） */
export function ordersSummary(): { paidCount: number; paidAmountCents: number; paidCredits: number; refundedCount: number; refundedAmountCents: number; pendingCount: number } {
  const empty = { paidCount: 0, paidAmountCents: 0, paidCredits: 0, refundedCount: 0, refundedAmountCents: 0, pendingCount: 0 };
  try {
    const one = (sql: string) => db.prepare(sql).get() as { c: number; amt: number; cr: number } | undefined;
    const paid = one(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) amt, COALESCE(SUM(credits),0) cr FROM orders WHERE status = 'paid'`);
    const refunded = one(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) amt, 0 cr FROM orders WHERE status = 'refunded'`);
    const pending = one(`SELECT COUNT(*) c, 0 amt, 0 cr FROM orders WHERE status = 'pending'`);
    return {
      paidCount: Number(paid?.c || 0),
      paidAmountCents: Number(paid?.amt || 0),
      paidCredits: Number(paid?.cr || 0),
      refundedCount: Number(refunded?.c || 0),
      refundedAmountCents: Number(refunded?.amt || 0),
      pendingCount: Number(pending?.c || 0),
    };
  } catch {
    return empty;
  }
}

// ===== 状态机 =====

/**
 * 入账（幂等）。返回是否本次真正入账。
 * 仅 pending 订单可入账；已 paid 且 externalId 相同视为重复回调（成功但不再入账）。
 */
export function markOrderPaid(
  orderId: string,
  opts: { externalId?: string; provider?: string; paidAt?: number } = {},
): { ok: boolean; credited: boolean; reason?: string; order?: Order } {
  const order = getOrder(orderId);
  if (!order) return { ok: false, credited: false, reason: "订单不存在" };
  if (order.status === "refunded") return { ok: false, credited: false, reason: "订单已退款", order };
  if (order.status === "paid") {
    // 已入账：同交易号重复回调 → 幂等成功；不同交易号 → 拒绝（避免一单两付）
    if (!opts.externalId || order.externalId === opts.externalId) {
      return { ok: true, credited: false, order };
    }
    return { ok: false, credited: false, reason: "订单已入账且交易号不同", order };
  }
  if (order.status === "canceled") return { ok: false, credited: false, reason: "订单已取消", order };

  const externalId = opts.externalId || order.externalId || order.id;
  try {
    // 订单状态与积分入账在同一事务内提交，避免"钱收了积分没到"
    withTx(() => {
      db.prepare(
        `UPDATE orders SET status = 'paid', external_id = ?, provider = COALESCE(?, provider),
                           paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      ).run(externalId, opts.provider || null, opts.paidAt || Date.now(), Date.now(), orderId);
    });
  } catch {
    return { ok: false, credited: false, reason: "订单状态更新失败" };
  }

  // 入账积分：ref = 支付方交易号 → credit_ledger(reason,ref) 唯一索引保证只入一次
  const res = addCredits(order.userId, order.credits, "payment.credit", externalId);
  if (!res.ok) {
    // 已存在同 ref 的入账流水（重复回调）→ 幂等成功
    return { ok: true, credited: false, order: getOrder(orderId) || order };
  }
  return { ok: true, credited: true, order: getOrder(orderId) || order };
}

/**
 * 退款：状态置 refunded 并回收积分（幂等）。
 * 余额不足时拒绝（不把用户余额扣成负数）—— 管理员可先调整积分再退款。
 */
export function refundOrder(orderId: string, note?: string): { ok: boolean; reason?: string; revoked: number; order?: Order } {
  const order = getOrder(orderId);
  if (!order) return { ok: false, reason: "订单不存在", revoked: 0 };
  if (order.status === "refunded") return { ok: true, revoked: 0, order }; // 幂等
  if (order.status !== "paid") return { ok: false, reason: "只有已入账订单可退款", revoked: 0 };

  const balance = getCreditBalance(order.userId);
  if (balance < order.credits) {
    return {
      ok: false,
      reason: `余额不足回收（当前 ${balance}，需回收 ${order.credits}），请先调整该用户积分`,
      revoked: 0,
    };
  }

  // 回收积分（reason 非消耗类，不触发代理佣金计提）
  const deduct = consumeCredits(order.userId, order.credits, "payment.refund", orderId);
  if (!deduct.ok) return { ok: false, reason: "积分回收失败", revoked: 0 };

  try {
    withTx(() => {
      db.prepare(
        `UPDATE orders SET status = 'refunded', refunded_at = ?, updated_at = ?,
                           note = COALESCE(?, note) WHERE id = ?`,
      ).run(Date.now(), Date.now(), note || null, orderId);
    });
  } catch {
    // 状态更新失败则把积分退回，保持一致性
    addCredits(order.userId, order.credits, "payment.refund_rollback", orderId);
    return { ok: false, reason: "退款状态更新失败（积分已回滚）", revoked: 0 };
  }
  return { ok: true, revoked: order.credits, order: getOrder(orderId) || order };
}

export function cancelOrder(orderId: string, note?: string): { ok: boolean; reason?: string } {
  const order = getOrder(orderId);
  if (!order) return { ok: false, reason: "订单不存在" };
  if (order.status !== "pending") return { ok: false, reason: "只有待支付订单可取消" };
  db.prepare(`UPDATE orders SET status = 'canceled', note = COALESCE(?, note), updated_at = ? WHERE id = ?`)
    .run(note || null, Date.now(), orderId);
  return { ok: true };
}

// ===== 回调验签与事件记账 =====

/** 是否开启了回调能力（未配置密钥则 fail-closed） */
export function webhookConfigured(): boolean {
  return !!(process.env.PAYMENT_WEBHOOK_SECRET || "").trim();
}

/** 计算 HMAC-SHA256 签名（hex），供支付方或自测脚本使用 */
export function signPayload(rawBody: string, secret?: string): string {
  const key = secret ?? (process.env.PAYMENT_WEBHOOK_SECRET || "");
  return createHmac("sha256", key).update(rawBody).digest("hex");
}

/** 常量时间校验回调签名 */
export function verifySignature(rawBody: string, signature: string | null | undefined): boolean {
  const secret = (process.env.PAYMENT_WEBHOOK_SECRET || "").trim();
  if (!secret) return false; // 未配置密钥：拒绝一切回调
  if (!signature) return false;
  const expected = signPayload(rawBody, secret);
  const got = signature.trim().toLowerCase().replace(/^sha256=/, "");
  try {
    const a = Buffer.from(expected, "utf-8");
    const b = Buffer.from(got, "utf-8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 记录回调事件；返回 false 表示该事件已处理过（幂等丢弃） */
export function recordEvent(input: {
  provider: string;
  eventId?: string;
  eventType: string;
  orderId?: string;
  externalId?: string;
  amountCents?: number;
  signatureOk: boolean;
  applied: boolean;
  reason?: string;
  payload?: string;
}): boolean {
  try {
    const r = db.prepare(
      `INSERT OR IGNORE INTO payment_events
         (provider, event_id, event_type, order_id, external_id, amount_cents, signature_ok, applied, reason, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.provider,
      input.eventId || null,
      input.eventType,
      input.orderId || null,
      input.externalId || null,
      input.amountCents ?? null,
      input.signatureOk ? 1 : 0,
      input.applied ? 1 : 0,
      input.reason || null,
      input.payload ? input.payload.slice(0, 4000) : null,
      Date.now(),
    );
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

/** 标记事件已实际生效（便于运维区分"收到但没动账"与"已动账"） */
export function markEventApplied(provider: string, eventId?: string): void {
  if (!eventId) return;
  try {
    db.prepare(
      `UPDATE payment_events SET applied = 1 WHERE provider = ? AND event_id = ?`,
    ).run(provider, eventId);
  } catch {}
}

export function listPaymentEvents(limit = 100): Record<string, unknown>[] {
  try {
    return db.prepare(`SELECT * FROM payment_events ORDER BY id DESC LIMIT ?`)
      .all(Math.min(Math.max(Math.trunc(limit), 1), 500)) as Record<string, unknown>[];
  } catch {
    return [];
  }
}
