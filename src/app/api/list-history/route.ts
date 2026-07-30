import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

const OUTPUT_BASE = join(
  process.env.HOME || "/Users/eric",
  "Downloads",
  "aplus-builder",
);

export async function GET() {
  try {
    const entries = readdirSync(OUTPUT_BASE, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dirPath = join(OUTPUT_BASE, d.name);
        const stat = statSync(dirPath);
        const hasHtml = existsSync(join(dirPath, "index.html"));

        const files = readdirSync(dirPath);
        const imageFiles = files.filter((f) =>
          /\.(jpg|jpeg|png|webp)$/i.test(f),
        );
        const variantFiles = files
          .filter((f) => /^variant_\d+\.html$/.test(f))
          .sort();

        return {
          dirName: d.name,
          timestamp: stat.mtimeMs,
          imageCount: imageFiles.length,
          variantNames: variantFiles.map((f) => f.replace(".html", "")),
          hasHtml,
        };
      })
      .filter((d) => d.hasHtml && d.imageCount > 0)
      .sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json({ entries });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
