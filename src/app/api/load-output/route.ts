import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";

const OUTPUT_BASE = join(
  process.env.HOME || "/Users/eric",
  "Downloads",
  "aplus-builder",
);

export async function GET(req: NextRequest) {
  const dirName = req.nextUrl.searchParams.get("dir");
  if (!dirName)
    return NextResponse.json({ error: "dir required" }, { status: 400 });

  const dirPath = join(OUTPUT_BASE, dirName);
  if (!existsSync(dirPath))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    // Load HTML
    const htmlPath = join(dirPath, "index.html");
    const html = existsSync(htmlPath)
      ? readFileSync(htmlPath, "utf-8")
      : "";

    // Load images as base64
    const files = readdirSync(dirPath);
    const imageFiles = files.filter((f) =>
      /\.(jpg|jpeg|png|webp)$/i.test(f),
    );
    const images = imageFiles.map((name) => {
      const buf = readFileSync(join(dirPath, name));
      const ext = name.split(".").pop()?.toLowerCase() || "jpeg";
      const mime =
        ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : "image/jpeg";
      return { name, base64: buf.toString("base64"), mime };
    });

    // Load variants
    const variantFiles = files
      .filter((f) => /^variant_\d+\.html$/.test(f))
      .sort();
    const variants = variantFiles.map((f) => ({
      name: f
        .replace(".html", "")
        .replace("_", " ")
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      html: readFileSync(join(dirPath, f), "utf-8"),
    }));

    return NextResponse.json({ html, images, variants });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
