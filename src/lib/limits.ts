/**
 * 稳定性 P0：任务配额（成本熔断）+ 请求限流。
 *
 * - 全局配额：按「日 / 月」任务数预算（quota 表计数），限额来自设置中心
 *   （settings.maxDailyTasks / maxMonthlyTasks，管理后台可改）
 * - 每用户配额：users.daily_limit / monthly_limit（NULL = 不限制），
 *   按 tasks 表当日/当月创建数计数
 * - 限流：内存滑动窗口（60 秒），对昂贵的写接口生效（生成/风格复刻/画廊截图）
 *
 * 注意：单实例假设——并发读改写由 Node 单线程 + 同步 SQLite 保证串行。
 */
import { db } from "@/lib/db";
import { getSettingInt } from "@/lib/settings";

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

/** 尝试消耗 1 个任务配额（全局 + 每用户）；超限返回原因（HTTP 429） */
export function consumeQuota(userId: string = "admin"): QuotaResult {
  const now = new Date();
  const d = fmtDate(now);
  const m = fmtMonth(now);
  const maxDaily = getSettingInt("maxDailyTasks", 200);
  const maxMonthly = getSettingInt("maxMonthlyTasks", 2000);

  // ---- 全局配额（quota 表）----
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

  if (dayCount >= maxDaily) {
    return { ok: false, reason: `今日任务配额已用尽（${dayCount}/${maxDaily}），请明日再试`, daily: dayCount, monthly: monthCount };
  }
  if (monthCount >= maxMonthly) {
    return { ok: false, reason: `本月任务配额已用尽（${monthCount}/${maxMonthly}），请联系管理员`, daily: dayCount, monthly: monthCount };
  }

  // ---- 每用户配额（users.daily_limit / monthly_limit）----
  const user = db
    .prepare(`SELECT daily_limit, monthly_limit FROM users WHERE id = ?`)
    .get(userId) as { daily_limit: number | null; monthly_limit: number | null } | undefined;
  if (user && (user.daily_limit != null || user.monthly_limit != null)) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const uDay =
      (db
        .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND created_at >= ?`)
        .get(userId, dayStart) as { c: number }).c || 0;
    const uMonth =
      (db
        .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND created_at >= ?`)
        .get(userId, monthStart) as { c: number }).c || 0;
    const dl = user.daily_limit != null ? Number(user.daily_limit) : null;
    const ml = user.monthly_limit != null ? Number(user.monthly_limit) : null;
    if (dl != null && uDay >= dl) {
      return { ok: false, reason: `你的今日配额已用尽（${uDay}/${dl}），请联系管理员`, daily: dayCount, monthly: monthCount };
    }
    if (ml != null && uMonth >= ml) {
      return { ok: false, reason: `你的本月配额已用尽（${uMonth}/${ml}），请联系管理员`, daily: dayCount, monthly: monthCount };
    }
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

/** 只读查看全局配额使用情况 */
export function getQuotaStatus(): { daily: number; monthly: number; dailyLimit: number; monthlyLimit: number } {
  const now = new Date();
  const d = fmtDate(now);
  const m = fmtMonth(now);
  const row = db
    .prepare(`SELECT day_count, month, month_count FROM quota WHERE day = ?`)
    .get(d) as { day_count: number; month: string; month_count: number } | undefined;
  const dayCount = Number(row?.day_count || 0);
  const monthCount = row && row.month === m ? Number(row.month_count || 0) : 0;
  return {
    daily: dayCount,
    monthly: monthCount,
    dailyLimit: getSettingInt("maxDailyTasks", 200),
    monthlyLimit: getSettingInt("maxMonthlyTasks", 2000),
  };
}

/** 每用户今日/本月用量（管理后台展示） */
export function getUserQuotaUsage(userId: string): { daily: number; monthly: number } {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const c = (sql: string, ts: number) =>
    (db.prepare(sql).get(userId, ts) as { c: number }).c || 0;
  return {
    daily: c(`SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND created_at >= ?`, dayStart),
    monthly: c(`SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND created_at >= ?`, monthStart),
  };
}

// ===== 限流（内存滑动窗口，单实例）=====

const rateHits = new Map<string, number[]>();

/** 检查并记录一次调用；返回 false 表示超限（HTTP 429） */
export function checkRateLimit(key: string): boolean {
  if (!key) return true;
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = (rateHits.get(key) || []).filter((t) => t > windowStart);
  const limit = getSettingInt("rateLimitPerMinute", 30) || 1;
  if (hits.length >= limit) {
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
