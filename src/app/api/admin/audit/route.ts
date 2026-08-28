import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";

/** GET /api/admin/audit?limit=100 — 最近审计记录 */
export async function GET(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") || 100), 500);
  const rows = db
    .prepare(`SELECT id, ts, user_id, action, detail FROM audit_log ORDER BY id DESC LIMIT ?`)
    .all(limit) as { id: number; ts: string; user_id: string; action: string; detail: string | null }[];

  return NextResponse.json({
    entries: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      user: r.user_id,
      action: r.action,
      detail: r.detail ? JSON.parse(r.detail) : null,
    })),
  });
}
