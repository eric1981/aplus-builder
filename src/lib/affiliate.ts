/**
 * 分销（affiliate）服务：绑定关系 + 代理收益统计（Phase 1：追踪记账，不结算）
 *
 * - 单层：客户（user）→ 代理（agent）
 * - 绑定来源：qr（扫码注册，未来）/ manual（管理员手动）
 * - 收益 = 名下客户累计消耗积分 × 分成比例（settings.agentCommissionPercent）
 *   暂为记账展示，不涉及真实资金结算
 */
import { db } from "@/lib/db";
import { getSettingInt } from "@/lib/settings";

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

/** 绑定/改绑：客户 → 代理（管理员手动） */
export function setReferral(userId: string, agentId: string | null, note?: string): void {
  if (!agentId) {
    db.prepare(`DELETE FROM referrals WHERE user_id = ?`).run(userId);
    return;
  }
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
                COALESCE((SELECT SUM(l.delta) FROM credit_ledger l
                          WHERE l.user_id = r.user_id AND l.delta < 0), 0) AS consumed
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

/** 代理收益汇总：客户数 + 总消耗 + 按比例折算收益（记账值） */
export function agentSummary(agentId: string): {
  clientCount: number;
  totalConsumed: number;
  commissionPercent: number;
  estimatedEarning: number; // 积分口径（非真实货币）
  clients: ReturnType<typeof listAgentClients>;
} {
  const clients = listAgentClients(agentId);
  const totalConsumed = clients.reduce((s, c) => s + c.consumed, 0);
  const pct = Math.max(0, Math.min(100, getSettingInt("agentCommissionPercent", 10)));
  return {
    clientCount: clients.length,
    totalConsumed,
    commissionPercent: pct,
    estimatedEarning: Math.round((totalConsumed * pct) / 100),
    clients,
  };
}

/** 所有代理列表（管理后台分销 tab） */
export function listAgents(): { id: string; name: string; email: string | null; code: string; clientCount: number }[] {
  try {
    return db
      .prepare(
        `SELECT u.id, u.name, u.email, u.agent_code,
                (SELECT COUNT(*) FROM referrals r WHERE r.agent_id = u.id) AS client_count
         FROM users u WHERE u.is_agent = 1 ORDER BY u.created_at ASC`,
      )
      .all() as { id: string; name: string; email: string | null; code: string; clientCount: number }[];
  } catch {
    return [];
  }
}

/** 未绑定代理的普通用户（管理后台下拉用） */
export function listUnboundUsers(): { id: string; name: string }[] {
  try {
    return db
      .prepare(
        `SELECT u.id, u.name FROM users u
         WHERE u.role = 'user' AND u.id NOT IN (SELECT user_id FROM referrals)
         ORDER BY u.created_at ASC`,
      )
      .all() as { id: string; name: string }[];
  } catch {
    return [];
  }
}
