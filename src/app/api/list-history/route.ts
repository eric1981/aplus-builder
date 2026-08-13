import { readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import { NextResponse } from "next/server";

const OUTPUT_BASE = join(
  process.env.HOME || "/Users/eric",
  "Downloads",
  "aplus-builder",
);

const IMAGE_RE = /\.(jpg|jpeg|png|webp)$/i;
const VARIANT_RE = /^variant_\d+\.html$/;

function scanDir(absPath: string, prefix: string): {
  dirName: string;
  timestamp: number;
  imageCount: number;
  variantNames: string[];
  hasHtml: boolean;
  /** 第一张产出图相对 OUTPUT_BASE 的路径（用于列表缩略图），无图时为 null */
  firstImage: string | null;
} | null {
  const hasHtml = existsSync(join(absPath, "output", "index.html"))
    || existsSync(join(absPath, "index.html"));
  if (hasHtml) {
    const scanPath = existsSync(join(absPath, "output")) ? join(absPath, "output") : absPath;
    const files = readdirSync(scanPath);
    const imageFiles = files.filter((f) => IMAGE_RE.test(f)).sort();
    const variantFiles = files.filter((f) => VARIANT_RE.test(f)).sort();
    return {
      dirName: prefix,
      timestamp: statSync(absPath).mtimeMs,
      imageCount: imageFiles.length,
      variantNames: variantFiles.map((f) => f.replace(".html", "")),
      hasHtml: true,
      firstImage:
        imageFiles.length > 0 ? relative(OUTPUT_BASE, join(scanPath, imageFiles[0])) : null,
    };
  }
  return null;
}

export async function GET() {
  try {
    const entries: Array<{
      dirName: string;
      timestamp: number;
      imageCount: number;
      variantNames: string[];
      hasHtml: boolean;
      firstImage: string | null;
    }> = [];

    if (!existsSync(OUTPUT_BASE)) {
      return NextResponse.json({ entries: [] });
    }

    const topLevel = readdirSync(OUTPUT_BASE, { withFileTypes: true });

    for (const entry of topLevel) {
      if (!entry.isDirectory()) continue;
      const topPath = join(OUTPUT_BASE, entry.name);

      // 老格式：一级目录就是产品目录
      const product = scanDir(topPath, entry.name);
      if (product) {
        entries.push(product);
        continue;
      }

      // 新格式：一级目录是客户，二级是产品
      const subDirs = readdirSync(topPath, { withFileTypes: true });
      for (const sub of subDirs) {
        if (!sub.isDirectory()) continue;
        const subPath = join(topPath, sub.name);
        const item = scanDir(subPath, `${entry.name}/${sub.name}`);
        if (item) entries.push(item);
      }
    }

    entries
      .filter((d) => d.hasHtml && d.imageCount > 0)
      .sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json({ entries });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
