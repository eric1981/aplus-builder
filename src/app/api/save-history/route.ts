import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, mkdirSync } from "fs";
import { join, resolve, sep } from "path";
import { userBase } from "@/lib/config";
import { checkRateLimit } from "@/lib/limits";
import { callerId as resolveCallerId } from "@/lib/request-user";

/** 上限（安全 H6）：此前无任何限制，单请求即可打满磁盘 / 阻塞事件循环 */
const MAX_ENTRIES = 50;
const MAX_HTML_BYTES = 5_000_000;      // 单条 HTML
const MAX_IMAGES_PER_ENTRY = 200;      // 单条最多落盘图片数
const MAX_IMAGE_BYTES = 15_000_000;    // 单张图片
const MAX_VARIANTS = 20;

export async function POST(request: NextRequest) {
  try {
    const userId = resolveCallerId(request);
    if (!userId) return NextResponse.json({ error: "Unauthorized: 缺少身份信息" }, { status: 401 });
    if (!checkRateLimit(`save-history:${userId}`)) {
      return NextResponse.json({ ok: false, error: "请求过于频繁，请稍后再试" }, { status: 429 });
    }

    const entries = await request.json();
    if (!Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json({ ok: false, error: "entries 必须是非空数组" }, { status: 400 });
    }
    if (entries.length > MAX_ENTRIES) {
      return NextResponse.json({ ok: false, error: `单次最多导出 ${MAX_ENTRIES} 条` }, { status: 413 });
    }
    const base = userBase(userId);
    mkdirSync(base, { recursive: true });

    let totalImages = 0;
    let totalSkipped = 0;

    for (const entry of entries) {
      const dirName = entry.title
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s-]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 40) || "history";
      // entry.id 此前未清洗，可被注入 "../" 造成任意目录写入 —— 这里做与 title 同级的清洗
      const idPart = String(entry.id ?? "")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 20) || "entry";
      const dir = join(base, `history-${dirName}-${idPart}`);
      // 双保险：目录必须在 base 之内
      if (!resolve(dir).startsWith(base + sep)) {
        return NextResponse.json({ ok: false, error: "非法路径" }, { status: 400 });
      }
      mkdirSync(dir, { recursive: true });

      let html = typeof entry.html === "string" ? entry.html : "";
      if (html.length > MAX_HTML_BYTES) {
        return NextResponse.json({ ok: false, error: `单条 HTML 过大（上限 ${MAX_HTML_BYTES} 字符）` }, { status: 413 });
      }

      // 从 HTML 中提取 base64 图片，保存为文件，替换为相对路径
      const imagesDir = join(dir, "images");
      const imgRegex = /<img[^>]+src="data:(image\/[^;]+);base64,([^"]+)"/g;
      let imgIndex = 0;
      let imgSkipped = 0;

      // 一次性替换（回调），避免在循环里对整串做 replace 造成 O(n²)
      html = html.replace(imgRegex, (full: string, mimeType: string, base64Data: string) => {
        if (imgIndex >= MAX_IMAGES_PER_ENTRY) { imgSkipped++; return full; }
        const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
        const imgName = `image_${String(imgIndex + 1).padStart(2, "0")}.${ext}`;
        try {
          const buf = Buffer.from(base64Data, "base64");
          if (buf.length > MAX_IMAGE_BYTES) { imgSkipped++; return full; }
          mkdirSync(imagesDir, { recursive: true });
          writeFileSync(join(imagesDir, imgName), buf);
          totalImages++;
          imgIndex++;
          return full.replace(/src="data:[^"]+"/, `src="./images/${imgName}"`);
        } catch {
          imgSkipped++;
          return full;
        }
      });

      totalSkipped += imgSkipped;

      // 保存 HTML（图片引用已替换为相对路径）
      writeFileSync(join(dir, "index.html"), html, "utf-8");

      // 保存变体 HTML
      if (entry.variants && Array.isArray(entry.variants)) {
        for (const v of entry.variants.slice(0, MAX_VARIANTS)) {
          const vName = v.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "-").slice(0, 30);
          writeFileSync(join(dir, `variant-${vName}.html`), v.html || "", "utf-8");
        }
      }

      // 元数据
      const meta = {
        id: entry.id,
        title: entry.title,
        created: entry.created,
        htmlSize: html.length,
        imageCount: imgIndex,
        variantCount: entry.variants?.length || 0,
      };
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
    }

    return NextResponse.json({ ok: true, count: entries.length, totalImages, skippedImages: totalSkipped });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
