import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { checkRateLimit, clientIp } from "@/lib/limits";

const GALLERY_DIR = join(process.cwd(), "public", "gallery");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function POST(request: NextRequest) {
  // 稳定性 P0：限流（Chrome 截图是同步阻塞操作，必须限流）
  if (!checkRateLimit(clientIp(request.headers))) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }

  try {
    const { html, name } = await request.json() as { html: string; name: string };

    // name 此前直接拼进文件路径，可注入 "../" 造成任意路径写入 —— 改为白名单校验
    if (!html || typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,60}$/.test(name)) {
      return NextResponse.json({ error: "Missing html or name" }, { status: 400 });
    }
    // 限制单次写入的 HTML 体积，防止超大文件写满磁盘
    if (html.length > 2_000_000) {
      return NextResponse.json({ error: "html too large" }, { status: 400 });
    }

    mkdirSync(GALLERY_DIR, { recursive: true });

    // Write HTML to temp file
    const tmpHtml = join(GALLERY_DIR, `${name}.html`);
    writeFileSync(tmpHtml, html, "utf-8");

    // Screenshot with Chrome headless
    const destPath = join(GALLERY_DIR, `${name}.png`);
    const result = spawnSync(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--screenshot=${destPath}`,
      "--window-size=450,800",
      `file://${tmpHtml}`,
    ], { timeout: 15000 });

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, path: `/gallery/${name}.png` });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
