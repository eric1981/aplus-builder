/**
 * 用户管理（登录体系）：存储于 SQLite users 表。
 *
 * 两种身份来源：
 * 1. Web 登录：email + password（管理员在 /admin 创建，scrypt 散列）
 * 2. API token：AUTH_USERS 环境变量种子（或用户记录里的 token 列），供脚本调用
 *
 * "admin" 同时也是本地默认用户（localhost 免登录，数据沿用旧布局）。
 */
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { hashPassword, hashOpaqueToken } from "@/lib/auth";
import { getSettingInt } from "@/lib/settings";

export interface User {
  id: string;
  name: string;
  email?: string | null;
  /** 是否已配置 API token（仅存哈希，明文不可回读，安全 H8） */
  hasToken: boolean;
  role: "admin" | "user";
  disabled: boolean;
  /** 每用户配额（null = 不限，跟随全局） */
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  /** 积分余额（真实扣减） */
  credits: number;
  /** 是否为代理（分销） */
  isAgent?: boolean;
  /** 代理专属码 */
  agentCode?: string | null;
  createdAt: string;
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    name: String(row.name),
    email: row.email ? String(row.email) : null,
    hasToken: !!(row.token_hash || row.token),
    role: (row.role as User["role"]) || "user",
    disabled: Boolean(Number(row.disabled || 0)),
    dailyLimit: row.daily_limit == null ? null : Number(row.daily_limit),
    monthlyLimit: row.monthly_limit == null ? null : Number(row.monthly_limit),
    credits: Number(row.credits || 0),
    isAgent: Boolean(Number(row.is_agent || 0)),
    agentCode: row.agent_code ? String(row.agent_code) : null,
    createdAt: String(row.created_at || ""),
  };
}

// ===== 查询 =====

/**
 * 按 API token 查用户（安全 H8：库中只存 SHA-256 哈希）。
 * 兼容旧库里的明文 token：命中后**就地升级**为哈希并清掉明文列，
 * 因此老脚本无需改配置即可继续用。
 */
export function findUserByToken(token: string): User | null {
  if (!token) return null;
  try {
    const hash = hashOpaqueToken(token);
    let row = db
      .prepare(`SELECT * FROM users WHERE token_hash = ?`)
      .get(hash) as Record<string, unknown> | undefined;

    if (!row) {
      // 兼容期：旧明文 token 命中 → 升级为哈希（明文立即清除）
      const legacy = db
        .prepare(`SELECT * FROM users WHERE token = ? AND token IS NOT NULL AND token != ''`)
        .get(token) as Record<string, unknown> | undefined;
      if (legacy) {
        try {
          db.prepare(`UPDATE users SET token_hash = ?, token = '' WHERE id = ?`).run(hash, legacy.id);
          console.log(`[auth] API token 已升级为哈希存储：${String(legacy.id)}`);
        } catch {}
        row = legacy;
      }
    }

    if (!row || Number(row.disabled)) return null;
    return rowToUser(row);
  } catch {
    return null;
  }
}

/** 生成新的 API token：返回明文（仅此一次），库中只存哈希 */
export function rotateUserToken(userId: string): string {
  const u = getUserById(userId);
  if (!u) throw new Error("用户不存在");
  const raw = randomBytes(24).toString("hex");
  db.prepare(`UPDATE users SET token_hash = ?, token = '' WHERE id = ?`).run(hashOpaqueToken(raw), userId);
  return raw;
}

/** 是否已配置 API token（管理后台展示用，不回显明文） */
export function hasApiToken(userId: string): boolean {
  try {
    const row = db
      .prepare(`SELECT (token_hash IS NOT NULL OR (token IS NOT NULL AND token != '')) AS has FROM users WHERE id = ?`)
      .get(userId) as { has: number } | undefined;
    return Number(row?.has || 0) === 1;
  } catch {
    return false;
  }
}

/** 列出所有用户（管理后台） */
export function listUsers(): (User & { taskCount: number })[] {
  try {
    const rows = db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id) AS task_count
         FROM users u ORDER BY u.created_at ASC`,
      )
      .all() as (Record<string, unknown> & { task_count: number })[];
    return rows.map((r) => ({ ...rowToUser(r), taskCount: Number(r.task_count || 0) }));
  } catch {
    return [];
  }
}

export function getUserById(id: string): User | null {
  try {
    const row = db
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToUser(row) : null;
  } catch {
    return null;
  }
}

// ===== 管理操作（仅 admin）=====

/** 管理员创建用户（email + 密码，可 Web 登录）；token 随机生成供 API 调用 */
export function createUserWithPassword(
  name: string,
  email: string,
  password: string,
  role: "admin" | "user" = "user",
): { user: User; apiToken: string } {
  const cleanEmail = email.toLowerCase().trim();
  const existing = db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(cleanEmail) as { id: string } | undefined;
  if (existing) throw new Error(`邮箱已存在：${cleanEmail}`);

  const id = sanitizeUserId(name);
  if (getUserById(id)) throw new Error(`用户 ID 已存在：${id}`);

  const now = new Date().toISOString();
  // 初始积分：settings.newUserCredits 可配（默认 20），管理员可在后台调整
  const initialCredits = Math.max(0, getSettingInt("newUserCredits", 20));
  // API token：明文只在返回值里出现一次，库中仅存哈希（安全 H8）
  const apiToken = randomBytes(24).toString("hex");
  db.prepare(
    `INSERT INTO users (id, name, email, token, token_hash, password_hash, role, disabled, credits, created_at)
     VALUES (?, ?, ?, '', ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    name.trim(),
    cleanEmail,
    hashOpaqueToken(apiToken),
    hashPassword(password),
    role,
    initialCredits,
    now,
  );
  // 初始积分流水（可审计）
  try {
    db.prepare(
      `INSERT INTO credit_ledger (user_id, delta, reason, balance, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, initialCredits, "signup.bonus", initialCredits, Date.now());
  } catch {}
  return { user: getUserById(id)!, apiToken };
}

/** 重置密码（新密码由管理员转交用户） */
export function resetUserPassword(id: string, newPassword: string): void {
  const u = getUserById(id);
  if (!u) throw new Error("用户不存在");
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(newPassword), id);
}

/** 启用/禁用用户（禁用后 Web 与 API 均不可用） */
export function setUserDisabled(id: string, disabled: boolean): void {
  const u = getUserById(id);
  if (!u) throw new Error("用户不存在");
  if (u.role === "admin") throw new Error("不能禁用管理员");
  db.prepare(`UPDATE users SET disabled = ? WHERE id = ?`).run(disabled ? 1 : 0, id);
}

export function setUserRole(id: string, role: "admin" | "user"): void {
  const u = getUserById(id);
  if (!u) throw new Error("用户不存在");
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id);
}

/** 设置每用户配额（null = 不限，跟随全局） */
export function setUserQuota(id: string, dailyLimit: number | null, monthlyLimit: number | null): void {
  const u = getUserById(id);
  if (!u) throw new Error("用户不存在");
  db.prepare(`UPDATE users SET daily_limit = ?, monthly_limit = ? WHERE id = ?`).run(
    dailyLimit == null ? null : Math.max(0, Math.floor(dailyLimit)),
    monthlyLimit == null ? null : Math.max(0, Math.floor(monthlyLimit)),
    id,
  );
}

/** 删除用户（连带会话；任务与客户数据保留在库中可按 user_id 追溯） */
export function deleteUser(id: string): void {
  const u = getUserById(id);
  if (!u) throw new Error("用户不存在");
  if (u.role === "admin") throw new Error("不能删除管理员");
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

// ===== 种子 =====

/** 首启种子：users 表为空且配置了 AUTH_USERS 时写入（API token 用户） */
export function seedUsersFromEnv() {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as
      | { c: number }
      | undefined;
    if (Number(row?.c || 0) > 0) return;
    const raw = process.env.AUTH_USERS;
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      id: string; name: string; token: string; role?: string;
    }[];
    const ins = db.prepare(
      `INSERT OR IGNORE INTO users (id, name, token, token_hash, role, created_at) VALUES (?, ?, '', ?, ?, ?)`,
    );
    for (const u of parsed) {
      if (!u?.id || !u?.token) continue;
      // 只存哈希；AUTH_USERS 里的明文由运维自己保存
      ins.run(u.id, u.name || u.id, hashOpaqueToken(u.token), u.role || "user", new Date().toISOString());
    }
  } catch {}
}

// ===== 内部 =====

function sanitizeUserId(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || `u${Date.now().toString(36)}`
  );
}

seedUsersFromEnv();
