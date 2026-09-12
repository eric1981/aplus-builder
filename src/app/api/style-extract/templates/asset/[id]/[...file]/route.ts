import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join, resolve, sep } from "path";
import { TEMPLATES_DIR, listVisibleTemplates } from "@/lib/style-templates";

/**
 * 模板静态资源（预览用）：/api/style-extract/templates/asset/[id]/[file]
 * 模板 HTML 引用相对图片（./xxx.jpg），预览时重写为绝对 URL 走这里。
 * 权限：模板 owner 本人或 admin。
 *
 * 安全 P0-3：此前只校验了 `id` 可见，但读取路径完全由 `file` 决定、与 id 无关 ——
 * 等于任何用户都能读 TEMPLATES_DIR 下**任意**文件（他人 *_prompt.txt 需求原文、
 * *_agent.log、*_run.sh、*_ref*.png 上传截图）。现改为：
 *   ① 找到可见模板，取该模板 id 作为归属锚点；
 *   ② 只允许读取「以该模板短 id 前缀命名」的文件（样例图即 <短id>-hero-01.jpg 形式）；
 *   ③ 只允许预览用静态图片 / css 扩展名（杜绝 prompt、日志、脚本等文本泄露）；
 *   ④ resolve 前缀兜底，禁止子目录与穿越。
 */

/** 预览允许的扩展名（刻意排除 html/svg —— 可执行脚本，同源直出会成为 XSS 面） */
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "css"]);

/**
 * 复刻过程的内部辅助文件后缀（参考截图 / prompt / agent 日志 / 启动脚本）。
 * 预览只需要模板引用的样例图，这些一律不外泄 —— 即使模板本身对所有用户可见。
 */
const INTERNAL_SUFFIX_RE = /_(ref\d*|prompt|agent|run|thumb)\b/i;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; file: string[] }> },
) {
  const { id, file } = await params;
  const userId = req.headers.get("x-user-id") || "admin";
  const fileName = (file || []).join("/");

  if (!id || !fileName) {
    return new NextResponse("Bad request", { status: 400 });
  }
  // 文件名不得含路径分隔符/穿越（文件名来自模板 HTML 的相对引用，本就不该有目录）
  if (
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("..") ||
    fileName.startsWith(".")
  ) {
    return new NextResponse("Bad request", { status: 400 });
  }

  // 权限：模板须对当前用户可见
  const tpl = listVisibleTemplates(userId).find((t) => t.id === id);
  if (!tpl) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 扩展名白名单
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED_EXT.has(ext)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 复刻内部辅助文件（参考截图/prompt/日志/脚本）不外泄
  if (INTERNAL_SUFFIX_RE.test(fileName)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 归属绑定：文件必须属于该模板（样例图以模板 id 前 8 位为前缀）
  if (!fileName.startsWith(tpl.id.slice(0, 8))) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const templatesRoot = resolve(TEMPLATES_DIR);
  const resolved = resolve(join(TEMPLATES_DIR, fileName));
  // 防穿越：解析后必须在 TEMPLATES_DIR 内
  if (!resolved.startsWith(templatesRoot + sep)) {
    return new NextResponse("Bad request", { status: 400 });
  }
  if (!existsSync(resolved)) return new NextResponse("Not found", { status: 404 });

  const buf = readFileSync(resolved);
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    gif: "image/gif", avif: "image/avif", css: "text/css",
  };
  return new NextResponse(buf, {
    headers: {
      "Content-Type": mimeMap[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
