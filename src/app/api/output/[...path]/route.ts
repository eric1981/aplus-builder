import { readFileSync, existsSync } from "fs";
import { join, resolve, sep } from "path";
import { NextRequest, NextResponse } from "next/server";

const OUTPUT_BASE = resolve(
  join(process.env.HOME || "/Users/eric", "Downloads", "aplus-builder"),
);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;

  // 防目录遍历：拒绝任何 "."/".."/分隔符/控制字符段
  if (!path || path.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }
  for (const seg of path) {
    if (
      !seg ||
      seg === "." ||
      seg === ".." ||
      seg.includes("/") ||
      seg.includes("\\") ||
      seg.includes("\0")
    ) {
      return new NextResponse("Bad request", { status: 400 });
    }
  }

  const filePath = resolve(join(OUTPUT_BASE, ...path));

  // 双保险：解析后的路径必须仍在 OUTPUT_BASE 之内
  if (!filePath.startsWith(OUTPUT_BASE + sep)) {
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

  return new NextResponse(buf, {
    headers: {
      "Content-Type": mimeMap[ext] || "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
