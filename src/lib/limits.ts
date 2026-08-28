/**
 * 稳定性 P0：任务配额（成本熔断）+ 请求限流。
 *
 * - 配额：全局按「日 / 月」两个维度的任务数预算，持久化在 SQLite quota 表。
 *   环境变量：MAX_DAILY_TASKS（默认 200）、MAX_MONTHLY_TASKS（默认 2000）。
 * - 限流：内存滑动窗口（60 秒），对昂贵的写接口生效（生成/风格复刻/画廊截图）。
 *   环境变量：RATE_LIMIT_PER_MINUTE（默认 30）。
 *
 * 注意：单实例假设——并发读改写由 Node 单线程 + 同步 SQLite 保证串行；
 * 多实例部署需换成共享存储（Redis/数据库主从）。
 */
import { db } from "@/lib/db";

export const MAX_DAILY_TASKS = parseInt(process.env.MAX_DAILY_TASKS || "200", 10) || 200;
export const MAX_MONTHLY_TASKS = parseInt(process.env.MAX_MONTHLY_TASKS || "2000", 10) || 2000;
export const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "30", 10) || 30;

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtMonth(d: Date): string {
  return fmtDate(d).slice(0, 7);
}

export type QuotaResult =
  | { ok: true; daily: number; monthly: number }
  | { ok: false; reason: string; daily: number; monthly: number };

/** 尝试消耗 1 个任务配额；超限返回原因（HTTP 429） */
export function consumeQuota(): QuotaResult {
  const now = new Date();
  const d = fmtDate(now);
  const m = fmtMonth(now);

  const row = db
    .prepare(`SELECT day_count, month, month_count FROM quota WHERE day = ?`)
    .get(d) as { day_count: number; month: string; month_count: number } | undefined;
  let dayCount = Number(row?.day_count || 0);
  let monthCount = Number(row?.month_count || 0);
  let month = String(row?.month || m);
  if (month !== m) {
    monthCount = 0;
    month = m;
  }

  if (dayCount >= MAX_DAILY_TASKS) {
    return { ok: false, reason: `今日任务配额已用尽（${dayCount}/${MAX_DAILY_TASKS}），请明日再试`, daily: dayCount, monthly: monthCount };
  }
  if (monthCount >= MAX_MONTHLY_TASKS) {
    return { ok: false, reason: `本月任务配额已用尽（${monthCount}/${MAX_MONTHLY_TASKS}），请联系管理员`, daily: dayCount, monthly: monthCount };
  }

  dayCount++;
  monthCount++;
  db.prepare(
    `INSERT INTO quota (day, day_count, month, month_count) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       day_count = excluded.day_count,
       month = excluded.month,
       month_count = excluded.month_count`,
  ).run(d, dayCount, month, monthCount);
  return { ok: true, daily: dayCount, monthly: monthCount };
}

/** 只读查看当前配额使用情况 */
export function getQuotaStatus(): { daily: number; monthly: number; dailyLimit: number; monthlyLimit: number } {
  const now = new Date();
  const d = fmtDate(now);
  const m = fmtMonth(now);
  const row = db
    .prepare(`SELECT day_count, month, month_count FROM quota WHERE day = ?`)
    .get(d) as { day_count: number; month: string; month_count: number } | undefined;
  const dayCount = Number(row?.day_count || 0);
  const monthCount = row && row.month === m ? Number(row.month_count || 0) : 0;
  return { daily: dayCount, monthly: monthCount, dailyLimit: MAX_DAILY_TASKS, monthlyLimit: MAX_MONTHLY_TASKS };
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
