import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";

/** GET /api/admin/audit?limit=100 — 最近审计记录 */
export async function GET(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  // limit 钳制（安全 Medium）：limit=-1 在 SQLite 中表示"无上限"，会整表导出审计日志
  const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;
  const rows = db
    .prepare(`SELECT id, ts, user_id, action, detail FROM audit_log ORDER BY id DESC LIMIT ?`)
    .all(limit) as { id: number; ts: string; user_id: string; action: string; detail: string | null }[];

  return NextResponse.json({
    entries: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      user: r.user_id,
      action: r.action,
      detail: (() => {
        if (!r.detail) return null;
        try { return JSON.parse(r.detail); } catch { return { _raw: r.detail }; }   // 脏数据不再 500
      })(),
    })),
  });
}
