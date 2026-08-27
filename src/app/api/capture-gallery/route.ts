import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { checkRateLimit, clientIp } from "@/lib/limits";
import { screenshotPage } from "@/lib/screenshot";

const GALLERY_DIR = join(process.cwd(), "public", "gallery");

export async function POST(request: NextRequest) {
  // 稳定性 P0：限流（截图走 Chrome，必须限流）
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

    // Screenshot with Chrome headless（异步，不阻塞事件循环）
    const destPath = join(GALLERY_DIR, `${name}.png`);
    const ok = await screenshotPage({ htmlPath: tmpHtml, destPath });

    if (!ok) {
      return NextResponse.json({ error: "Chrome 截图失败" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, path: `/gallery/${name}.png` });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
