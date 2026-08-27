/**
 * 用户注册表（稳定性 P1）：token → 用户 的映射。
 *
 * 数据来源（优先级从高到低）：
 * 1. 环境变量 AUTH_USERS：JSON 数组，如
 *    AUTH_USERS='[{"id":"alice","name":"Alice","token":"tk_alice_xxx"},{"id":"bob","name":"Bob","token":"tk_bob_xxx"}]'
 * 2. data/users.json（首启时由 AUTH_USERS 种子生成；此后以文件为准，可用它增删用户）
 *
 * 说明：
 * - "admin" 是内置的本地默认用户（localhost 访问），不需要 token，数据沿用旧布局
 * - 对外开放时给每个用户发放独立 token；proxy 用 token 解析出 x-user-id 注入各路由
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";

export interface User {
  id: string;
  name: string;
  /** API token（Bearer） */
  token: string;
  /** admin 为内置本地用户 */
  role?: "admin" | "user";
}

const DATA_DIR = join(process.cwd(), "data");
const USERS_FILE = join(DATA_DIR, "users.json");

function seedFromEnv(): User[] {
  const raw = process.env.AUTH_USERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as User[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u) => u && u.id && u.token).map((u) => ({
      ...u,
      role: u.role || "user",
    }));
  } catch {
    return [];
  }
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function writeAtomic(users: User[]) {
  ensureDir();
  const tmp = USERS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(users, null, 2), "utf-8");
  renameSync(tmp, USERS_FILE);
}

let users: User[] | null = null;

function loadUsers(): User[] {
  if (users) return users;
  try {
    if (existsSync(USERS_FILE)) {
      const parsed = JSON.parse(readFileSync(USERS_FILE, "utf-8")) as User[];
      if (Array.isArray(parsed)) {
        users = parsed;
        return users;
      }
    }
  } catch {}
  // 首启：用 AUTH_USERS 种子并落盘，便于之后在文件里增删用户
  users = seedFromEnv();
  try {
    writeAtomic(users);
  } catch {}
  return users;
}

/** 按 token 查用户；未匹配返回 null */
export function findUserByToken(token: string): User | null {
  if (!token) return null;
  return loadUsers().find((u) => u.token === token) || null;
}

/** 列出所有非 admin 用户（供管理端使用） */
export function listUsers(): User[] {
  return loadUsers();
}
