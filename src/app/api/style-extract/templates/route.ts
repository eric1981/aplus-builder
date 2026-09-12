import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join, basename, resolve, sep } from "path";
import { listVisibleTemplates, deleteTemplate, ensureThumbnail, TEMPLATES_DIR } from "@/lib/style-templates";
import { checkRateLimit } from "@/lib/limits";
import { callerId as resolveCallerId } from "@/lib/request-user";

// 模块级去重：避免并发请求重复触发同一模板截图
const thumbPending = new Set<string>();
const MAX_LAZY_PER_REQUEST = 4;

/**
 * 风格模板列表（按当前用户可见：本人复刻 + admin 的；admin 可见全部）
 * GET         → { templates: [{ id, filename, thumb, createdAt, ownerId }] }
 * GET ?content=<id> → { html }（模板 HTML 内容，供预览）
 * DELETE ?id=xxx   → 删除（owner 本人或 admin）
 */
export async function GET(request: NextRequest) {
  const userId = resolveCallerId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized: 缺少身份信息" }, { status: 401 });

  // 预览内容：返回模板 HTML
  // 安全 P0-2：此前直接把 contentId 拼进 join()，且不校验归属 ——
  // 可用 "../.." 读任意 .html，或直接读他人模板。现改为：
  //   ① 只认「当前用户可见」的模板 id；② 路径取自 DB 记录的 filename（不信任客户端）；③ resolve 前缀兜底。
  const contentId = request.nextUrl.searchParams.get("content");
  if (contentId) {
    const tpl = listVisibleTemplates(userId).find((t) => t.id === contentId);
    if (!tpl) return NextResponse.json({ error: "模板不存在" }, { status: 404 });
    try {
      const p = resolve(join(TEMPLATES_DIR, basename(tpl.filename)));
      if (!p.startsWith(resolve(TEMPLATES_DIR) + sep)) {
        return NextResponse.json({ error: "非法路径" }, { status: 400 });
      }
      if (!existsSync(p)) return NextResponse.json({ error: "模板不存在" }, { status: 404 });
      return NextResponse.json({ html: readFileSync(p, "utf-8") });
    } catch {
      return NextResponse.json({ error: "读取失败" }, { status: 500 });
    }
  }

  // 该端点会触发 Chrome 截图（懒生成缩略图），必须限流
  if (!checkRateLimit(`templates:${userId}`)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }

  try {
    const isAdminCaller = userId === "admin";
    const list = listVisibleTemplates(userId).map((t) => ({
      id: t.id,
      filename: t.filename,
      thumb: t.thumb,
      // 安全：不再向普通用户暴露他人 ownerId；前端只需区分"平台模板/我的模板"
      isPlatform: t.ownerId === "admin",
      createdAt: t.createdAt,
      ...(isAdminCaller ? { ownerId: t.ownerId } : {}),
    }));

    // 懒生成缩略图：无缩略图且模板文件在 → 后台补截图（不阻塞响应，刷新后可见）
    const missing = list.filter((t) => !t.thumb && existsSync(join(TEMPLATES_DIR, `${t.id}.html`)));
    for (const t of missing.slice(0, MAX_LAZY_PER_REQUEST)) {
      if (thumbPending.has(t.id)) continue;
      thumbPending.add(t.id);
      ensureThumbnail(t.id)
        .catch(() => {})
        .finally(() => thumbPending.delete(t.id));
    }

    return NextResponse.json({ templates: list });
  } catch {
    return NextResponse.json({ templates: [] });
  }
}

export async function DELETE(request: NextRequest) {
  const userId = resolveCallerId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized: 缺少身份信息" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const r = deleteTemplate(id, userId);
  if (!r.ok) return NextResponse.json({ error: r.reason || "删除失败" }, { status: 403 });
  return NextResponse.json({ ok: true });
}
