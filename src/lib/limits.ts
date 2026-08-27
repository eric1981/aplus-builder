/**
 * 稳定性 P0：任务配额（成本熔断）+ 请求限流。
 *
 * - 配额：全局按「日 / 月」两个维度的任务数预算，持久化在 data/quota.json（原子写入），
 *   进程重启不丢失。这是对外公开时的成本熔断：预算耗尽即拒绝新任务。
 *   环境变量：MAX_DAILY_TASKS（默认 200）、MAX_MONTHLY_TASKS（默认 2000）。
 * - 限流：内存滑动窗口（60 秒），对昂贵的写接口生效（生成/风格复刻/画廊截图）。
 *   环境变量：RATE_LIMIT_PER_MINUTE（默认 30）。
 *
 * 注意：单实例假设——并发读改写由 Node 单线程 + 同步 fs 保证串行；
 * 多实例部署需换成共享存储（Redis/数据库）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const QUOTA_FILE = join(DATA_DIR, "quota.json");

export const MAX_DAILY_TASKS = parseInt(process.env.MAX_DAILY_TASKS || "200", 10) || 200;
export const MAX_MONTHLY_TASKS = parseInt(process.env.MAX_MONTHLY_TASKS || "2000", 10) || 2000;
export const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "30", 10) || 30;

interface QuotaState {
  day: string; // YYYY-MM-DD
  dayCount: number;
  month: string; // YYYY-MM
  monthCount: number;
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtMonth(d: Date): string {
  return fmtDate(d).slice(0, 7);
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readQuota(): QuotaState {
  try {
    if (existsSync(QUOTA_FILE)) {
      const parsed = JSON.parse(readFileSync(QUOTA_FILE, "utf-8")) as QuotaState;
      if (parsed && typeof parsed.dayCount === "number") return parsed;
    }
  } catch {}
  return { day: fmtDate(new Date()), dayCount: 0, month: fmtMonth(new Date()), monthCount: 0 };
}

function writeQuotaAtomic(q: QuotaState) {
  ensureDataDir();
  const tmp = QUOTA_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(q, null, 2), "utf-8");
  renameSync(tmp, QUOTA_FILE);
}

export type QuotaResult =
  | { ok: true; daily: number; monthly: number }
  | { ok: false; reason: string; daily: number; monthly: number };

/** 尝试消耗 1 个任务配额；超限返回原因（HTTP 429） */
export function consumeQuota(): QuotaResult {
  const q = readQuota();
  const now = new Date();
  const d = fmtDate(now);
  const m = fmtMonth(now);
  if (q.day !== d) { q.day = d; q.dayCount = 0; }
  if (q.month !== m) { q.month = m; q.monthCount = 0; }
  if (q.dayCount >= MAX_DAILY_TASKS) {
    return { ok: false, reason: `今日任务配额已用尽（${q.dayCount}/${MAX_DAILY_TASKS}），请明日再试`, daily: q.dayCount, monthly: q.monthCount };
  }
  if (q.monthCount >= MAX_MONTHLY_TASKS) {
    return { ok: false, reason: `本月任务配额已用尽（${q.monthCount}/${MAX_MONTHLY_TASKS}），请联系管理员`, daily: q.dayCount, monthly: q.monthCount };
  }
  q.dayCount++;
  q.monthCount++;
  writeQuotaAtomic(q);
  return { ok: true, daily: q.dayCount, monthly: q.monthCount };
}

/** 只读查看当前配额使用情况 */
export function getQuotaStatus(): { daily: number; monthly: number; dailyLimit: number; monthlyLimit: number } {
  const q = readQuota();
  const now = new Date();
  if (q.day !== fmtDate(now)) q.dayCount = 0;
  if (q.month !== fmtMonth(now)) q.monthCount = 0;
  return { daily: q.dayCount, monthly: q.monthCount, dailyLimit: MAX_DAILY_TASKS, monthlyLimit: MAX_MONTHLY_TASKS };
}

// ===== 限流（内存滑动窗口，单实例）=====

const rateHits = new Map<string, number[]>();

/** 检查并记录一次调用；返回 false 表示超限（HTTP 429） */
export function checkRateLimit(key: string): boolean {
  if (!key) return true;
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = (rateHits.get(key) || []).filter((t) => t > windowStart);
  if (hits.length >= RATE_LIMIT_PER_MINUTE) {
    rateHits.set(key, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(key, hits);
  return true;
}

/**
 * 从请求中提取限流 key：
 * - 优先取 x-forwarded-for（反代/隧道后第一个 IP）
 * - 无则退化为 Host（此时限流退化为全局限制，仍能起到成本保护作用）
 */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || "unknown";
  return headers.get("host") || "unknown";
}
