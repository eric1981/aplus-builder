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
import { hashPassword } from "@/lib/auth";

export interface User {
  id: string;
  name: string;
  email?: string | null;
  /** API token（Bearer） */
  token: string;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: string;
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    name: String(row.name),
    email: row.email ? String(row.email) : null,
    token: row.token ? String(row.token) : "",
    role: (row.role as User["role"]) || "user",
    disabled: Boolean(Number(row.disabled || 0)),
    createdAt: String(row.created_at || ""),
  };
}

// ===== 查询 =====

/** 按 token 查用户；未匹配返回 null */
export function findUserByToken(token: string): User | null {
  if (!token) return null;
  try {
    const row = db
      .prepare(`SELECT * FROM users WHERE token = ?`)
      .get(token) as Record<string, unknown> | undefined;
    if (!row || Number(row.disabled)) return null;
    return rowToUser(row);
  } catch {
    return null;
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
): User {
  const cleanEmail = email.toLowerCase().trim();
  const existing = db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(cleanEmail) as { id: string } | undefined;
  if (existing) throw new Error(`邮箱已存在：${cleanEmail}`);

  const id = sanitizeUserId(name);
  if (getUserById(id)) throw new Error(`用户 ID 已存在：${id}`);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, name, email, token, password_hash, role, disabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    name.trim(),
    cleanEmail,
    randomBytes(16).toString("hex"),
    hashPassword(password),
    role,
    now,
  );
  return getUserById(id)!;
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
      `INSERT OR IGNORE INTO users (id, name, token, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const u of parsed) {
      if (!u?.id || !u?.token) continue;
      ins.run(u.id, u.name || u.id, u.token, u.role || "user", new Date().toISOString());
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
