import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { checkRateLimit, clientIp } from "@/lib/limits";
import { screenshotPage } from "@/lib/screenshot";
import { requireAdmin } from "@/lib/admin";
import { logAudit } from "@/lib/audit";

/** 截图产物：品牌样张（/gallery/*.png 由品牌配置引用），放 public 供前台直接使用 */
const GALLERY_DIR = join(process.cwd(), "public", "gallery");
/**
 * 中间 HTML 目录（安全 H3）：必须在非公开目录。
 * 此前把用户提交的 HTML 写进 public/gallery/<name>.html —— 该文件被 Next 静态服务
 * 同源免认证直出（proxy matcher 只覆盖 /api/*），等于任意登录用户可植入公开的
 * 脚本页面（存储型 XSS）。现在写到这里，截完即删。
 */
const GALLERY_TMP_DIR = join(process.cwd(), "data", "gallery-tmp");

export async function POST(request: NextRequest) {
  // 安全 H3：本接口会覆盖共享的品牌样张（/gallery/editorial.png 等），
  // 属运营资产维护动作，限管理员调用（此前任何登录用户都能覆盖首页图）。
  const admin = requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: "无权限：仅管理员可重建画廊样张" }, { status: 403 });
  }

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
    mkdirSync(GALLERY_TMP_DIR, { recursive: true });

    // 中间 HTML 写到非公开目录（随机名，避免并发/覆盖）
    const tmpHtml = join(GALLERY_TMP_DIR, `${randomBytes(8).toString("hex")}.html`);
    writeFileSync(tmpHtml, html, "utf-8");

    const destPath = join(GALLERY_DIR, `${name}.png`);
    let ok = false;
    try {
      // Screenshot with Chrome headless（异步，不阻塞事件循环）
      ok = await screenshotPage({ htmlPath: tmpHtml, destPath });
    } finally {
      // 截完立即删除中间 HTML，磁盘上不留可被直出的页面
      try { unlinkSync(tmpHtml); } catch {}
    }

    if (!ok) {
      return NextResponse.json({ error: "Chrome 截图失败" }, { status: 500 });
    }

    logAudit(admin.id, "admin.gallery_capture", { name });
    return NextResponse.json({ ok: true, path: `/gallery/${name}.png` });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
