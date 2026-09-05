import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, resolve, sep, relative } from "path";
import { gzipSync } from "zlib";
import { spawnSync } from "child_process";
import { NextRequest, NextResponse } from "next/server";
import { userBase } from "@/lib/config";
import { taskStore } from "@/app/api/generate/task-store";

/** 预览缩略图最长边（原图 2400px → 800px，base64 体积约 1/8，隧道/远程访问大幅提速） */
const THUMB_MAX = 800;
/** 缩略图目录名（与原图同目录） */
const THUMBS_DIR = "thumbs";

/** 惰性生成缩略图：sips 缩放原图到 <原图目录>/thumbs/，失败时回退原图路径 */
function ensureThumb(originDir: string, name: string): string {
  try {
    const thumbsDir = join(originDir, THUMBS_DIR);
    mkdirSync(thumbsDir, { recursive: true });
    const thumbPath = join(thumbsDir, name);
    if (existsSync(thumbPath)) return thumbPath;
    const src = join(originDir, name);
    const ext = (name.split(".").pop() || "").toLowerCase();
    const out = ext === "png" ? thumbPath : join(thumbsDir, `${name.slice(0, name.lastIndexOf("."))}.jpg`);
    const r = spawnSync("sips", ["-Z", String(THUMB_MAX), "-s", "format", ext === "png" ? "png" : "jpeg", src, "--out", out], { timeout: 15000 });
    if (r.status === 0 && existsSync(out)) return out;
    // 尝试读取预期输出（png 同名 / jpg 换扩展名）
    if (existsSync(thumbPath)) return thumbPath;
    return src;
  } catch {
    return join(originDir, name);
  }
}

/** 读取图片为 base64，优先缩略图（预览提速），返回原图相对路径供下载 */
function readImageBase64(originDir: string, name: string, base: string): { name: string; base64: string; mime: string; path: string } {
  const src = ensureThumb(originDir, name);
  const buf = readFileSync(src);
  const ext = (src.split(".").pop() || "jpeg").toLowerCase();
  const mime =
    ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : "image/jpeg";
  // 原图相对 userBase 的路径（下载用）：<dirName>/output/<name>
  const rel = relative(base, join(originDir, name));
  return { name, base64: buf.toString("base64"), mime, path: rel };
}

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

    // Load images as base64（按文件名去重；优先缩略图，远程访问大幅提速）
    const seenImages = new Set<string>();
    const images: { name: string; base64: string; mime: string; path: string }[] = [];
    for (const d of scanDirs) {
      let files: string[] = [];
      try { files = readdirSync(d); } catch { continue; }
      const imageFiles = files.filter((f) =>
        /\.(jpg|jpeg|png|webp)$/i.test(f) && !seenImages.has(f),
      );
      for (const name of imageFiles) {
        seenImages.add(name);
        images.push(readImageBase64(d, name, base));
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

    // ── 用户输入回顾：input-meta.json（文字）+ input/ 图片（base64 缩略图）──
    let inputMeta: Record<string, unknown> | null = null;
    const inputImages: { key: string; name: string; base64: string; mime: string }[] = [];
    try {
      const metaPath = join(dirPath, "input-meta.json");
      if (existsSync(metaPath)) {
        inputMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
      } else {
        // 存量任务无 meta：从目录名推断产品名（去用户前缀与 taskId 短码）
        const baseName = dirName.split("/").pop() || "";
        const guessed = baseName.replace(/-[0-9a-f]{8}$/, "").trim();
        if (guessed) {
          inputMeta = { productName: guessed };
        }
      }
      const inputDir = join(dirPath, "input");
      if (existsSync(inputDir)) {
        // meta 里记录的 key → 文件名映射；无 meta 时按文件名后缀猜测
        const known = [
          ["product", "productImage", "产品图"],
          ["model_ref", "modelImage", "模特参考"],
          ["logo", "logoImage", "Logo"],
        ] as const;
        for (const [prefix, metaKey, label] of known) {
          const metaName = inputMeta ? String((inputMeta as Record<string, unknown>)[metaKey] || "") : "";
          const candidates = metaName ? [metaName] : readdirSync(inputDir).filter((f) => f.startsWith(prefix) && /\.(jpg|jpeg|png|webp)$/i.test(f));
          for (const name of candidates) {
            const p = join(inputDir, name);
            if (!existsSync(p)) continue;
            const img = readImageBase64(inputDir, name, base);
            inputImages.push({ key: label, name: img.name, base64: img.base64, mime: img.mime });
            break; // 每类只取一张
          }
        }
      }
    } catch {}

    const payload = {
      html,
      images,
      variants,
      prediction: taskStore.getPredictionByDir(dirName),
      input: {
        meta: inputMeta,
        images: inputImages,
      },
    };
    const json = JSON.stringify(payload);

    // 远程/隧道访问（如 ngrok）带宽有限：gzip 压缩可把 base64 图片响应从 ~24MB 压到 ~4MB，
    // 并允许浏览器/前端缓存，避免每次预览都全量重传。
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // 不缓存：前端自带内存缓存（同会话秒开）+ 请求带 _t 时间戳防浏览器缓存旧响应
      "Cache-Control": "no-store",
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
