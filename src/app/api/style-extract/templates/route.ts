import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { listVisibleTemplates, deleteTemplate, TEMPLATES_DIR } from "@/lib/style-templates";

/**
 * 风格模板列表（按当前用户可见：本人复刻 + admin 的；admin 可见全部）
 * GET         → { templates: [{ id, filename, thumb, createdAt, ownerId }] }
 * GET ?content=<id> → { html }（模板 HTML 内容，供预览）
 * DELETE ?id=xxx   → 删除（owner 本人或 admin）
 */
export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id") || "admin";

  // 预览内容：返回模板 HTML
  const contentId = request.nextUrl.searchParams.get("content");
  if (contentId) {
    try {
      const p = join(TEMPLATES_DIR, `${contentId}.html`);
      if (!existsSync(p)) return NextResponse.json({ error: "模板不存在" }, { status: 404 });
      return NextResponse.json({ html: readFileSync(p, "utf-8") });
    } catch {
      return NextResponse.json({ error: "读取失败" }, { status: 500 });
    }
  }

  try {
    const list = listVisibleTemplates(userId).map((t) => ({
      id: t.id,
      filename: t.filename,
      thumb: t.thumb,
      ownerId: t.ownerId,
      createdAt: t.createdAt,
    }));
    return NextResponse.json({ templates: list });
  } catch {
    return NextResponse.json({ templates: [] });
  }
}

export async function DELETE(request: NextRequest) {
  const userId = request.headers.get("x-user-id") || "admin";
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const r = deleteTemplate(id, userId);
  if (!r.ok) return NextResponse.json({ error: r.reason || "删除失败" }, { status: 403 });
  return NextResponse.json({ ok: true });
}
