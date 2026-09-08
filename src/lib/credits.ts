/**
 * 积分余额服务（真实扣减 + 流水账）
 *
 * - 余额存 users.credits（真实数字，不是前端假积分）
 * - 每次消耗/发放写 credit_ledger 流水（带变动后余额快照，便于审计与分销分成）
 * - 扣分单价由 settings 配置（creditCost*），管理员可在后台调整
 */
import { db } from "@/lib/db";
import { getSettingInt } from "@/lib/settings";

export type CreditResult =
  | { ok: true; balance: number; delta: number }
  | { ok: false; reason: string; balance: number; needed: number };

/** 读取用户当前余额 */
export function getCreditBalance(userId: string): number {
  try {
    const row = db
      .prepare(`SELECT credits FROM users WHERE id = ?`)
      .get(userId) as { credits: number } | undefined;
    return Number(row?.credits || 0);
  } catch {
    return 0;
  }
}

/**
 * 消耗积分（真实扣减）。余额不足返回 ok:false（调用方返回 402/429）。
 * @param reason 流水原因，如 task.detail / task.single / style_extract
 * @param ref 关联 id（taskId 等）
 */
export function consumeCredits(
  userId: string,
  amount: number,
  reason: string,
  ref?: string,
): CreditResult {
  if (amount <= 0) return { ok: true, balance: getCreditBalance(userId), delta: 0 };
  try {
    // 原子扣减：仅当余额足够
    const r = db
      .prepare(`UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?`)
      .run(amount, userId, amount);
    if (Number(r.changes) === 0) {
      return { ok: false, reason: "积分不足", balance: getCreditBalance(userId), needed: amount };
    }
    const balance = getCreditBalance(userId);
    // 流水（变动后余额快照）
    db.prepare(
      `INSERT INTO credit_ledger (user_id, delta, reason, balance, ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, -amount, reason, balance, ref || null, Date.now());
    return { ok: true, balance, delta: -amount };
  } catch {
    return { ok: false, reason: "积分扣减失败", balance: getCreditBalance(userId), needed: amount };
  }
}

/**
 * 发放积分（管理员充值 / 初始赠送 / 未来支付回调）。写正流水。
 */
export function addCredits(
  userId: string,
  amount: number,
  reason: string,
  ref?: string,
): { balance: number } {
  if (amount <= 0) return { balance: getCreditBalance(userId) };
  try {
    db.prepare(`UPDATE users SET credits = credits + ? WHERE id = ?`).run(amount, userId);
    const balance = getCreditBalance(userId);
    db.prepare(
      `INSERT INTO credit_ledger (user_id, delta, reason, balance, ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, amount, reason, balance, ref || null, Date.now());
    return { balance };
  } catch {
    return { balance: getCreditBalance(userId) };
  }
}

/** 用户积分流水（管理后台/代理中心用，倒序） */
export function listCreditLedger(
  userId: string,
  limit = 100,
): { delta: number; reason: string; balance: number; ref: string | null; created_at: number }[] {
  try {
    return db
      .prepare(
        `SELECT delta, reason, balance, ref, created_at FROM credit_ledger
         WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(userId, limit) as { delta: number; reason: string; balance: number; ref: string | null; created_at: number }[];
  } catch {
    return [];
  }
}

/** 按 reason 取扣分单价（settings 可配） */
export function creditCostFor(reason: string): number {
  const map: Record<string, string> = {
    "task.detail": "creditCostDetail",
    "task.single": "creditCostSingle",
    "style_extract": "creditCostStyleExtract",
  };
  const key = map[reason];
  return key ? getSettingInt(key, 1) : 1;
}
