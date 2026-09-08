import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { TEMPLATES_DIR, listVisibleTemplates } from "@/lib/style-templates";

/**
 * 模板静态资源（预览用）：/api/style-extract/templates/asset/[id]/[file]
 * 模板 HTML 引用相对图片（./xxx.jpg），预览时重写为绝对 URL 走这里。
 * 权限：模板 owner 本人或 admin。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; file: string[] }> },
) {
  const { id, file } = await params;
  const userId = req.headers.get("x-user-id") || "admin";
  const fileName = (file || []).join("/");
  if (!id || !fileName || fileName.includes("..") || fileName.includes("\\")) {
    return new NextResponse("Bad request", { status: 400 });
  }
  // 权限：模板可见才可读资源
  const visible = listVisibleTemplates(userId);
  if (!visible.some((t) => t.id === id)) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const resolved = join(TEMPLATES_DIR, fileName);
  // 防穿越：解析后必须在 TEMPLATES_DIR 内
  if (!resolved.startsWith(TEMPLATES_DIR + "/")) {
    return new NextResponse("Bad request", { status: 400 });
  }
  if (!existsSync(resolved)) return new NextResponse("Not found", { status: 404 });
  const buf = readFileSync(resolved);
  const ext = resolved.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    css: "text/css", html: "text/html", svg: "image/svg+xml",
  };
  return new NextResponse(buf, {
    headers: { "Content-Type": mimeMap[ext] || "application/octet-stream", "Cache-Control": "public, max-age=3600" },
  });
}
