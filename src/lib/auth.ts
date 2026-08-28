/**
 * 认证核心（手搓登录体系，零新依赖）：
 * - 密码：node:crypto scrypt 散列 + 随机盐，timingSafeEqual 比对
 * - 会话：不透明 token（randomBytes 32）→ 库中只存 SHA-256 哈希
 * - Cookie 由路由层设置（HttpOnly + SameSite=Lax）
 * - 初始管理员：从 ADMIN_EMAIL/ADMIN_PASSWORD 环境变量种子，未配置则生成随机密码并打印一次
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto";
import { db } from "@/lib/db";

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  role: "admin" | "user";
  disabled: boolean;
}

export const SESSION_COOKIE = "aplus_session";
/** 登出标记：种下后即使 localhost 也要求重新登录（否则本地豁免会绕过登出） */
export const LOGOUT_COOKIE = "aplus_logged_out";
/** 会话有效期：30 天 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ===== 密码 =====

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [salt, hashHex] = stored.split(":");
    if (!salt || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ===== 会话 =====

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 创建会话，返回不透明 token（库中只存哈希） */
export function createSession(userId: string): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash(token), userId, Date.now(), expiresAt, Date.now());
  return { token, expiresAt };
}

/** 按会话 token 解析用户；无效/过期/禁用返回 null */
export function getUserBySessionToken(token: string | null | undefined): AuthUser | null {
  if (!token) return null;
  try {
    const row = db
      .prepare(
        `SELECT s.user_id, s.expires_at, u.id, u.name, u.email, u.role, u.disabled
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash(token)) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (Number(row.expires_at || 0) < Date.now()) {
      db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash(token));
      return null;
    }
    if (Number(row.disabled)) return null;
    // 滑动续期
    db.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`).run(Date.now(), tokenHash(token));
    return {
      id: String(row.user_id),
      name: String(row.name),
      email: row.email ? String(row.email) : null,
      role: (row.role as AuthUser["role"]) || "user",
      disabled: Boolean(Number(row.disabled)),
    };
  } catch {
    return null;
  }
}

export function deleteSession(token: string | null | undefined) {
  if (!token) return;
  try {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash(token));
  } catch {}
}

/** 清理过期会话（可定时/启动时调用） */
export function cleanupSessions() {
  try {
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());
  } catch {}
}

// ===== 登录 =====

/** 按邮箱+密码认证；失败返回 null */
export function authenticateUser(email: string, password: string): AuthUser | null {
  if (!email || !password) return null;
  try {
    const row = db
      .prepare(`SELECT id, name, email, role, disabled, password_hash FROM users WHERE email = ?`)
      .get(email.toLowerCase().trim()) as Record<string, unknown> | undefined;
    if (!row || !row.password_hash) return null;
    if (Number(row.disabled)) return null;
    if (!verifyPassword(password, String(row.password_hash))) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      email: String(row.email),
      role: (row.role as AuthUser["role"]) || "user",
      disabled: false,
    };
  } catch {
    return null;
  }
}

// ===== 初始管理员 =====

/** 首启创建管理员：ADMIN_EMAIL/ADMIN_PASSWORD 环境变量，未配置则随机生成并打印 */
export function seedAdmin() {
  try {
    const email = (process.env.ADMIN_EMAIL || "admin@local").toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD;

    if (password) {
      // 显式配置了 ADMIN_PASSWORD：每次启动强制执行（同时可作为密码恢复手段）
      db.prepare(
        `INSERT INTO users (id, name, email, token, password_hash, role, disabled, created_at)
         VALUES ('admin', '管理员', ?, ?, ?, 'admin', 0, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email,
           password_hash = excluded.password_hash,
           role = 'admin',
           disabled = 0`,
      ).run(email, randomBytes(16).toString("hex"), hashPassword(password), new Date().toISOString());
      console.log(`[auth] 管理员就绪：${email}（密码来自 ADMIN_PASSWORD）`);
      return;
    }

    // 未配置 ADMIN_PASSWORD：仅在无管理员时创建随机密码并打印一次
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND password_hash IS NOT NULL`,
      )
      .get() as { c: number } | undefined;
    if (Number(row?.c || 0) > 0) return;

    const generated = randomBytes(9).toString("base64url");
    db.prepare(
      `INSERT INTO users (id, name, email, token, password_hash, role, disabled, created_at)
       VALUES ('admin', '管理员', ?, ?, ?, 'admin', 0, ?)`,
    ).run(email, randomBytes(16).toString("hex"), hashPassword(generated), new Date().toISOString());
    console.log(`\n[auth] 已创建初始管理员：${email} / ${generated}`);
    console.log(`[auth] 请尽快登录修改密码（或设置 ADMIN_PASSWORD 环境变量后重建）。\n`);
  } catch {}
}
