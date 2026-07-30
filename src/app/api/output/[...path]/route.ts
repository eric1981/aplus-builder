import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";

const OUTPUT_BASE = join(
  process.env.HOME || "/Users/eric",
  "Downloads",
  "aplus-builder",
);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const filePath = join(OUTPUT_BASE, ...path);

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
    },
  });
}
