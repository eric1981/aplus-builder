/**
 * 积分余额服务（真实扣减 + 流水账）
 *
 * - 余额存 users.credits（真实数字，不是前端假积分）
 * - 每次消耗/发放写 credit_ledger 流水（带变动后余额快照，便于审计与分销分成）
 * - 扣分单价由 settings 配置（creditCost*），管理员可在后台调整
 */
import { db, withTx } from "@/lib/db";
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
 * 扣减与流水在**同一事务**内完成：任一步失败则整体回滚，不会出现"扣了分没流水"。
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
    return withTx<CreditResult>(() => {
      // 原子扣减：仅当余额足够（余额不可能为负）
      const r = db
        .prepare(`UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?`)
        .run(amount, userId, amount);
      if (Number(r.changes) === 0) {
        return { ok: false, reason: "积分不足", balance: getCreditBalance(userId), needed: amount };
      }
      const balance = getCreditBalance(userId);
      db.prepare(
        `INSERT INTO credit_ledger (user_id, delta, reason, balance, ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(userId, -amount, reason, balance, ref || null, Date.now());
      return { ok: true, balance, delta: -amount };
    });
  } catch {
    return { ok: false, reason: "积分扣减失败", balance: getCreditBalance(userId), needed: amount };
  }
}

/**
 * 发放积分（管理员充值 / 初始赠送 / 支付回调 / 退款）。写正流水。
 *
 * 入账与流水同事务；带 `ref` 的幂等类原因（payment.credit / task.refund）
 * 命中唯一索引时会整体回滚并返回 `ok:false` —— 同一笔外部流水或同一任务
 * 不会重复入账（支付回调重放安全）。
 */
export function addCredits(
  userId: string,
  amount: number,
  reason: string,
  ref?: string,
): { balance: number; ok: boolean } {
  if (amount <= 0) return { balance: getCreditBalance(userId), ok: true };
  try {
    return withTx(() => {
      db.prepare(`UPDATE users SET credits = credits + ? WHERE id = ?`).run(amount, userId);
      const balance = getCreditBalance(userId);
      db.prepare(
        `INSERT INTO credit_ledger (user_id, delta, reason, balance, ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(userId, amount, reason, balance, ref || null, Date.now());
      return { balance, ok: true };
    });
  } catch {
    // 幂等冲突（重复入账）会走到这里：事务已回滚，余额未被改动
    return { balance: getCreditBalance(userId), ok: false };
  }
}

/**
 * 任务失败/超时/取消时退还该任务实际消耗的积分（幂等：同一 taskId 只退一次）。
 *
 * 退还额直接取流水里该任务的实际扣减额（而非当前单价），
 * 因此管理员事后调整单价也不会算错退款。
 */
export function refundTaskCredits(
  userId: string,
  taskId: string,
): { refunded: number; balance: number } {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(-delta), 0) AS amount FROM credit_ledger
         WHERE user_id = ? AND ref = ? AND delta < 0
           AND reason IN ('task.detail', 'task.single', 'style_extract')`,
      )
      .get(userId, taskId) as { amount: number } | undefined;
    const amount = Math.max(0, Math.trunc(Number(row?.amount || 0)));
    if (amount === 0) return { refunded: 0, balance: getCreditBalance(userId) };
    const r = addCredits(userId, amount, "task.refund", taskId);
    return { refunded: r.ok ? amount : 0, balance: r.balance };
  } catch {
    return { refunded: 0, balance: getCreditBalance(userId) };
  }
}

/**
 * 对账：让流水合计与真实余额一致。
 * 余额始终是权威值，差额写一条 `ledger.adjust` 流水（收敛后不再产生新行，可重复执行）。
 */
export function reconcileCreditLedger(): { userId: string; adjusted: number }[] {
  const out: { userId: string; adjusted: number }[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT u.id AS id, u.credits AS credits,
                COALESCE((SELECT SUM(l.delta) FROM credit_ledger l WHERE l.user_id = u.id), 0) AS ledger
         FROM users u`,
      )
      .all() as { id: string; credits: number; ledger: number }[];
    for (const r of rows) {
      const balance = Number(r.credits || 0);
      const diff = balance - Number(r.ledger || 0);
      if (diff === 0) continue;
      withTx(() => {
        db.prepare(
          `INSERT INTO credit_ledger (user_id, delta, reason, balance, ref, created_at)
           VALUES (?, ?, 'ledger.adjust', ?, ?, ?)`,
        ).run(r.id, diff, balance, "reconcile", Date.now());
      });
      out.push({ userId: r.id, adjusted: diff });
    }
  } catch {}
  return out;
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
