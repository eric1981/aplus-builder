import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, mkdirSync } from "fs";
import { join, resolve, sep } from "path";

const OUTPUT_BASE = resolve(join("/Users", "eric", "Downloads", "aplus-builder"));

export async function POST(request: NextRequest) {
  try {
    const entries = await request.json();
    mkdirSync(OUTPUT_BASE, { recursive: true });

    let totalImages = 0;

    for (const entry of entries) {
      const dirName = entry.title
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s-]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 40) || "history";
      // entry.id 此前未清洗，可被注入 "../" 造成任意目录写入 —— 这里做与 title 同级的清洗
      const idPart = String(entry.id ?? "")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 20) || "entry";
      const dir = join(OUTPUT_BASE, `history-${dirName}-${idPart}`);
      // 双保险：目录必须在 OUTPUT_BASE 之内
      if (!resolve(dir).startsWith(OUTPUT_BASE + sep)) {
        return NextResponse.json({ ok: false, error: "非法路径" }, { status: 400 });
      }
      mkdirSync(dir, { recursive: true });

      let html = entry.html || "";

      // 从 HTML 中提取 base64 图片，保存为文件，替换为相对路径
      const imagesDir = join(dir, "images");
      const imgRegex = /<img[^>]+src="data:(image\/[^;]+);base64,([^"]+)"/g;
      let match;
      let imgIndex = 0;

      while ((match = imgRegex.exec(html)) !== null) {
        const mimeType = match[1];
        const base64Data = match[2];
        const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
        const imgName = `image_${String(imgIndex + 1).padStart(2, "0")}.${ext}`;

        try {
          const buf = Buffer.from(base64Data, "base64");
          mkdirSync(imagesDir, { recursive: true });
          writeFileSync(join(imagesDir, imgName), buf);
          totalImages++;

          // 替换 HTML 中的引用
          html = html.replace(match[0], match[0].replace(
            /src="data:[^"]+"/,
            `src="./images/${imgName}"`
          ));
        } catch {}
        imgIndex++;
      }

      // 保存 HTML（图片引用已替换为相对路径）
      writeFileSync(join(dir, "index.html"), html, "utf-8");

      // 保存变体 HTML
      if (entry.variants && Array.isArray(entry.variants)) {
        for (const v of entry.variants) {
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

    // 清理旧的 "无标题" 导出（之前没图片的）
    for (const entry of entries) {
      if (entry.title === "(无标题)") continue;
    }

    return NextResponse.json({ ok: true, count: entries.length, totalImages });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
