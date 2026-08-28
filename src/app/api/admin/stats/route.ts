import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { getQuotaStatus } from "@/lib/limits";

/** GET /api/admin/stats — 配额、任务、用户总览 */
export async function GET(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  const quota = getQuotaStatus();
  const tasks = db
    .prepare(`SELECT status, COUNT(*) AS c FROM tasks GROUP BY status`)
    .all() as { status: string; c: number }[];
  const userCount = db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number };
  const taskCount = db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number };
  const sessionCount = db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number };

  return NextResponse.json({
    quota,
    tasks: Object.fromEntries(tasks.map((t) => [t.status, t.c])),
    totalTasks: taskCount.c,
    totalUsers: userCount.c,
    activeSessions: sessionCount.c,
  });
}
