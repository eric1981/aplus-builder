/**
 * 用户注册表（稳定性 P1）：token → 用户 的映射，存储于 SQLite users 表。
 *
 * 种子来源：环境变量 AUTH_USERS（JSON 数组），首启时写入数据库；此后以库为准。
 * 例：AUTH_USERS='[{"id":"alice","name":"Alice","token":"tk_alice_xxx"},{"id":"bob","name":"Bob","token":"tk_bob_xxx"}]'
 *
 * 说明：
 * - "admin" 是内置的本地默认用户（localhost 访问），不需要 token，数据沿用旧布局
 * - 对外开放时给每个用户发放独立 token；proxy 用 token 解析出 x-user-id 注入各路由
 */
import { db } from "@/lib/db";

export interface User {
  id: string;
  name: string;
  /** API token（Bearer） */
  token: string;
  /** admin 为内置本地用户 */
  role?: "admin" | "user";
}

function seedFromEnv(): User[] {
  const raw = process.env.AUTH_USERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as User[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((u) => u && u.id && u.token)
      .map((u) => ({ ...u, role: u.role || "user" }));
  } catch {
    return [];
  }
}

/** 首启种子：users 表为空且配置了 AUTH_USERS 时写入 */
export function seedUsersFromEnv() {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as
      | { c: number }
      | undefined;
    if (Number(row?.c || 0) > 0) return;
    const seed = seedFromEnv();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO users (id, name, token, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const u of seed) {
      ins.run(u.id, u.name || u.id, u.token, u.role || "user", new Date().toISOString());
    }
  } catch {}
}

/** 按 token 查用户；未匹配返回 null */
export function findUserByToken(token: string): User | null {
  if (!token) return null;
  try {
    const row = db
      .prepare(`SELECT id, name, token, role FROM users WHERE token = ?`)
      .get(token) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      token: String(row.token),
      role: (row.role as User["role"]) || "user",
    };
  } catch {
    return null;
  }
}

/** 列出所有非 admin 用户（供管理端使用） */
export function listUsers(): User[] {
  try {
    const rows = db
      .prepare(`SELECT id, name, token, role FROM users ORDER BY created_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      token: String(r.token),
      role: (r.role as User["role"]) || "user",
    }));
  } catch {
    return [];
  }
}

seedUsersFromEnv();
