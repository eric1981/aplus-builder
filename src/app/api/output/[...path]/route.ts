import { readFileSync, existsSync } from "fs";
import { join, resolve, sep } from "path";
import { NextRequest, NextResponse } from "next/server";
import { userBase } from "@/lib/config";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  // 多用户隔离：x-user-id 由 proxy 注入；无则视为 admin（本地默认布局）
  const base = userBase(req.headers.get("x-user-id") || "admin");

  // 防目录遍历：拒绝 "."/".." 路径组件、反斜杠、控制字符和以 "/" 开头的绝对段。
  // 注意：段内允许 "/" —— 嵌套目录（客户/产品）经 encodeURIComponent 后会用 %2F 表示，
  // Next 解码为含斜杠的单个段；真正的越界由下方的 resolved 前缀校验兜底。
  if (!path || path.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }
  for (const seg of path) {
    if (
      !seg ||
      seg.startsWith("/") ||
      seg.includes("\\") ||
      seg.includes("\0") ||
      seg.split("/").some((p) => p === ".." || p === ".")
    ) {
      return new NextResponse("Bad request", { status: 400 });
    }
  }

  const filePath = resolve(join(base, ...path));

  // 双保险：解析后的路径必须仍在 base 之内
  if (!filePath.startsWith(base + sep)) {
    return new NextResponse("Bad request", { status: 400 });
  }

  if (!existsSync(filePath)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const buf = readFileSync(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
    json: "application/json",
  };

  const isHtmlLike = ext === "html" || ext === "htm";
  const headers: Record<string, string> = {
    "Content-Type": mimeMap[ext] || "application/octet-stream",
    // private：避免共享缓存把某租户的产出缓存后直接回给未认证请求（绕过新鉴权）
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  };
  if (isHtmlLike) {
    // 安全 P0-1：产出 HTML 由 agent 依据用户输入生成，视为不可信内容。
    // CSP sandbox 使其运行在不透明源中 —— 脚本仍可执行，但拿不到本应用 Cookie、
    // 也调不到同源 /api/admin/*，从而切断"客户投毒 HTML → 管理员打开 → 提权"链路。
    headers["Content-Security-Policy"] = "sandbox allow-scripts allow-popups allow-forms";
  }

  return new NextResponse(buf, { headers });
}
