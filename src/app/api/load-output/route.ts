import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve, sep } from "path";
import { gzipSync } from "zlib";
import { NextRequest, NextResponse } from "next/server";
import { userBase } from "@/lib/config";
import { taskStore } from "@/app/api/generate/task-store";

export async function GET(req: NextRequest) {
  const dirName = req.nextUrl.searchParams.get("dir");
  if (!dirName)
    return NextResponse.json({ error: "dir required" }, { status: 400 });

  const base = userBase(req.headers.get("x-user-id") || "admin");

  // 防目录遍历：dirName 允许含 "/"（客户/产品两级目录），但拒绝空段、"."、".." 和隐藏目录
  const parts = dirName.split("/");
  if (
    parts.length === 0 ||
    parts.some((p) => !p || p === "." || p === ".." || p.includes("\\") || p.includes("\0")) ||
    parts[0].startsWith(".")
  ) {
    return NextResponse.json({ error: "非法目录名" }, { status: 400 });
  }

  const dirPath = resolve(join(base, dirName));

  // 双保险：解析后的路径必须仍在 base 之内
  if (!dirPath.startsWith(base + sep)) {
    return NextResponse.json({ error: "非法目录名" }, { status: 400 });
  }

  if (!existsSync(dirPath))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    // 兼容三种结构：
    // 1) 标准：output/index.html + output/图片 + output/variant_N.html
    // 2) 旧结构：根目录 index.html + 图片 + variant_N.html
    // 3) 混合（手动补全产物）：index.html/variant 在根目录，图片在 output/ 子目录
    const outputDir = join(dirPath, "output");
    const hasOutput = existsSync(outputDir);

    // Load HTML：优先 output/index.html，其次根目录 index.html
    const htmlPath = [join(outputDir, "index.html"), join(dirPath, "index.html")]
      .find((p) => existsSync(p));
    const html = htmlPath ? readFileSync(htmlPath, "utf-8") : "";

    // 扫描范围：output/ 与根目录都收集（图片/变体可能分散在两处）
    const scanDirs = hasOutput ? [outputDir, dirPath] : [dirPath];

    // Load images as base64（按文件名去重）
    const seenImages = new Set<string>();
    const images: { name: string; base64: string; mime: string }[] = [];
    for (const d of scanDirs) {
      let files: string[] = [];
      try { files = readdirSync(d); } catch { continue; }
      const imageFiles = files.filter((f) =>
        /\.(jpg|jpeg|png|webp)$/i.test(f) && !seenImages.has(f),
      );
      for (const name of imageFiles) {
        seenImages.add(name);
        const buf = readFileSync(join(d, name));
        const ext = name.split(".").pop()?.toLowerCase() || "jpeg";
        const mime =
          ext === "png"
            ? "image/png"
            : ext === "webp"
              ? "image/webp"
              : "image/jpeg";
        images.push({ name, base64: buf.toString("base64"), mime });
      }
    }

    // Load variants（按文件名去重，数字顺序排序）
    const seenVariants = new Set<string>();
    const variants: { name: string; html: string }[] = [];
    for (const d of scanDirs) {
      let files: string[] = [];
      try { files = readdirSync(d); } catch { continue; }
      const variantFiles = files
        .filter((f) => /^variant_\d+\.html$/.test(f) && !seenVariants.has(f))
        .sort();
      for (const f of variantFiles) {
        seenVariants.add(f);
        variants.push({
          name: f
            .replace(".html", "")
            .replace("_", " ")
            .replace(/\b\w/g, (c) => c.toUpperCase()),
          html: readFileSync(join(d, f), "utf-8"),
        });
      }
    }

    const payload = {
      html,
      images,
      variants,
      prediction: taskStore.getPredictionByDir(dirName),
    };
    const json = JSON.stringify(payload);

    // 远程/隧道访问（如 ngrok）带宽有限：gzip 压缩可把 base64 图片响应从 ~24MB 压到 ~4MB，
    // 并允许浏览器/前端缓存，避免每次预览都全量重传。
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // 产出目录名唯一且内容不变，可安全缓存 10 分钟
      "Cache-Control": "private, max-age=600",
      "Vary": "Cookie",
    };
    if (json.length > 1024) {
      headers["Content-Encoding"] = "gzip";
      return new NextResponse(gzipSync(json), { headers });
    }
    return new NextResponse(json, { headers });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
