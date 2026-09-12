/**
 * 分销（affiliate）服务：绑定关系 + 代理收益统计（Phase 1：追踪记账，不结算）
 *
 * - 单层：客户（user）→ 代理（agent）
 * - 绑定来源：qr（扫码注册，未来）/ manual（管理员手动）
 * - 收益：**逐笔固化**。客户每次消耗积分时，按"当时"的比例写一条 commission_ledger
 *   （base_amount / rate / amount / consumption_ref），汇总只读该表。
 *   这样管理员事后调整分成比例，不会篡改历史收益（此前是实时用当前比例重算）。
 * - 消耗已退款（refundOnFailure）→ 对应佣金置 reversed=1，不再计入收益
 * - 暂为记账展示，不涉及真实资金结算
 */
import { db } from "@/lib/db";
import { getSettingInt } from "@/lib/settings";

/** 计入佣金基数的消耗原因（排除 admin.deduct 等管理动作与充值） */
export const CONSUMPTION_REASONS = ["task.detail", "task.single", "style_extract"] as const;

function isConsumptionReason(reason: string): boolean {
  return (CONSUMPTION_REASONS as readonly string[]).includes(reason);
}

/** 当前分成比例（写入侧已限 0–100，这里再兜底夹取一次） */
export function currentCommissionPercent(): number {
  return Math.max(0, Math.min(100, getSettingInt("agentCommissionPercent", 10)));
}

export interface Referral {
  userId: string;
  userName: string;
  agentId: string;
  source: "qr" | "manual" | string;
  note: string | null;
  createdAt: number;
}

/** 标记用户为代理（自动生成专属码） */
export function setAgentFlag(userId: string, isAgent: boolean): { agentCode?: string } {
  const existing = db
    .prepare(`SELECT agent_code FROM users WHERE id = ?`)
    .get(userId) as { agent_code: string | null } | undefined;
  if (isAgent) {
    // 有码保留，无码生成（8 位大写字母数字，避开易混淆字符）
    let code = existing?.agent_code || "";
    if (!code) {
      do {
        code = Array.from({ length: 8 }, () =>
          "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)],
        ).join("");
      } while (db.prepare(`SELECT id FROM users WHERE agent_code = ?`).get(code));
      db.prepare(`UPDATE users SET is_agent = 1, agent_code = ? WHERE id = ?`).run(code, userId);
    } else {
      db.prepare(`UPDATE users SET is_agent = 1 WHERE id = ?`).run(userId);
    }
    return { agentCode: code };
  }
  db.prepare(`UPDATE users SET is_agent = 0 WHERE id = ?`).run(userId);
  return {};
}

/** 绑定/改绑：客户 → 代理（管理员手动）。带校验，防止自绑定/绑到非代理/成环 */
export function setReferral(userId: string, agentId: string | null, note?: string): void {
  if (!agentId) {
    db.prepare(`DELETE FROM referrals WHERE user_id = ?`).run(userId);
    return;
  }
  if (agentId === userId) throw new Error("不能把客户绑定到自己");

  const agent = db
    .prepare(`SELECT is_agent, disabled FROM users WHERE id = ?`)
    .get(agentId) as { is_agent: number; disabled: number } | undefined;
  if (!agent) throw new Error("代理不存在");
  if (Number(agent.disabled)) throw new Error("该代理已被禁用");
  if (!Number(agent.is_agent)) throw new Error("目标用户尚未标记为代理，请先在分销管理中标记");

  const client = db
    .prepare(`SELECT role, disabled FROM users WHERE id = ?`)
    .get(userId) as { role: string; disabled: number } | undefined;
  if (!client) throw new Error("客户不存在");
  if (client.role === "admin") throw new Error("不能把管理员绑定为代理客户");

  // 防成环：若目标代理本身是当前客户的代理客户（A→B 且 B→A），拒绝
  const reverse = db
    .prepare(`SELECT agent_id FROM referrals WHERE user_id = ?`)
    .get(agentId) as { agent_id: string } | undefined;
  if (reverse?.agent_id === userId) throw new Error("会形成互相绑定，已拒绝");

  const now = Date.now();
  db.prepare(
    `INSERT INTO referrals (user_id, agent_id, source, note, created_at, updated_at)
     VALUES (?, ?, 'manual', ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       source = excluded.source,
       note = excluded.note,
       updated_at = excluded.updated_at`,
  ).run(userId, agentId, note || null, now, now);
}

/**
 * 计提佣金（消耗成功时调用）：按**当时**比例固化一条佣金流水。
 * 幂等：同一客户 + 同一消耗 ref 只计提一次（重复调用静默忽略）。
 */
export function accrueCommission(
  clientId: string,
  baseAmount: number,
  reason: string,
  ref?: string,
): void {
  try {
    if (!isConsumptionReason(reason)) return;
    const amount = Math.trunc(baseAmount);
    if (amount <= 0) return;

    const agent = getReferralAgent(clientId);
    if (!agent) return;
    if (agent.agentId === clientId) return; // 自绑定（防御，正常情况下已被 setReferral 拒绝）
    const agentRow = db
      .prepare(`SELECT is_agent, disabled FROM users WHERE id = ?`)
      .get(agent.agentId) as { is_agent: number; disabled: number } | undefined;
    if (!agentRow || !Number(agentRow.is_agent) || Number(agentRow.disabled)) return;

    const rate = currentCommissionPercent();
    const commission = Math.round((amount * rate) / 100);
    if (commission <= 0) return;

    db.prepare(
      `INSERT INTO commission_ledger
         (agent_id, client_id, consumption_ref, reason, base_amount, rate, amount, reversed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(agent.agentId, clientId, ref || null, reason, amount, rate, commission, Date.now());
  } catch {
    // 唯一索引冲突（已计提）或库异常：不影响主流程
  }
}

/** 消耗已退款 → 撤销对应佣金计提（保留流水，置 reversed=1） */
export function reverseCommission(clientId: string, ref?: string): void {
  if (!ref) return;
  try {
    db.prepare(
      `UPDATE commission_ledger SET reversed = 1
       WHERE client_id = ? AND consumption_ref = ? AND reversed = 0`,
    ).run(clientId, ref);
  } catch {}
}

/** 查某客户的代理（无则 null） */
export function getReferralAgent(userId: string): { agentId: string; agentName: string; source: string } | null {
  try {
    const row = db
      .prepare(
        `SELECT r.agent_id, u.name AS agent_name, r.source
         FROM referrals r LEFT JOIN users u ON u.id = r.agent_id
         WHERE r.user_id = ?`,
      )
      .get(userId) as { agent_id: string; agent_name: string; source: string } | undefined;
    if (!row) return null;
    return { agentId: row.agent_id, agentName: row.agent_name || row.agent_id, source: row.source };
  } catch {
    return null;
  }
}

/** 代理名下客户列表（含各自的消耗统计） */
export function listAgentClients(agentId: string): {
  userId: string;
  userName: string;
  email: string | null;
  source: string;
  boundAt: number;
  consumed: number; // 累计消耗积分（负数和的绝对值）
  currentBalance: number;
}[] {
  try {
    const rows = db
      .prepare(
        `SELECT r.user_id, u.name AS user_name, u.email, u.credits,
                r.source, r.created_at,
                COALESCE((SELECT SUM(-l.delta) FROM credit_ledger l
                          WHERE l.user_id = r.user_id AND l.delta < 0
                            AND l.reason IN ('task.detail','task.single','style_extract')), 0) AS consumed
         FROM referrals r LEFT JOIN users u ON u.id = r.user_id
         WHERE r.agent_id = ?
         ORDER BY r.created_at DESC`,
      )
      .all(agentId) as {
      user_id: string;
      user_name: string;
      email: string | null;
      credits: number;
      source: string;
      created_at: number;
      consumed: number;
    }[];
    return rows.map((r) => ({
      userId: r.user_id,
      userName: r.user_name || r.user_id,
      email: r.email ?? null,
      source: r.source,
      boundAt: Number(r.created_at || 0),
      consumed: Math.abs(Number(r.consumed || 0)),
      currentBalance: Number(r.credits || 0),
    }));
  } catch {
    return [];
  }
}

/**
 * 代理收益汇总：客户数 + 总消耗 + **已固化佣金合计**（记账值）
 *
 * estimatedEarning 现在是 commission_ledger 里已计提且未撤销的佣金合计，
 * 不再用"当前比例 × 历史消耗"实时重算。
 */
export function agentSummary(agentId: string): {
  clientCount: number;
  totalConsumed: number;
  commissionPercent: number;
  estimatedEarning: number; // 已计提佣金（积分口径，非真实货币）
  clients: ReturnType<typeof listAgentClients>;
} {
  const clients = listAgentClients(agentId);
  const totalConsumed = clients.reduce((s, c) => s + c.consumed, 0);
  let accrued = 0;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS earnings, COALESCE(SUM(base_amount), 0) AS base
         FROM commission_ledger WHERE agent_id = ? AND reversed = 0`,
      )
      .get(agentId) as { earnings: number; base: number } | undefined;
    accrued = Number(row?.earnings || 0);
  } catch {}
  return {
    clientCount: clients.length,
    totalConsumed,
    commissionPercent: currentCommissionPercent(),
    estimatedEarning: accrued,
    clients,
  };
}

/** 所有代理列表（管理后台分销 tab） */
export function listAgents(): { id: string; name: string; email: string | null; code: string; clientCount: number }[] {
  try {
    return db
      .prepare(
        `SELECT u.id, u.name, u.email, u.agent_code AS code,
                (SELECT COUNT(*) FROM referrals r WHERE r.agent_id = u.id) AS client_count
         FROM users u WHERE u.is_agent = 1 ORDER BY u.created_at ASC`,
      )
      .all() as { id: string; name: string; email: string | null; code: string; clientCount: number }[];
  } catch {
    return [];
  }
}

/** 未绑定代理的普通用户（管理后台下拉用；代理不再作为可绑定客户） */
export function listUnboundUsers(): { id: string; name: string }[] {
  try {
    return db
      .prepare(
        `SELECT u.id, u.name FROM users u
         WHERE u.role = 'user' AND u.is_agent = 0
           AND u.id NOT IN (SELECT user_id FROM referrals)
         ORDER BY u.created_at ASC`,
      )
      .all() as { id: string; name: string }[];
  } catch {
    return [];
  }
}
