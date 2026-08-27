import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve, sep } from "path";
import { NextRequest, NextResponse } from "next/server";
import { userBase } from "@/lib/config";

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
    // 支持 output/ 子目录和根目录两种结构
    const scanDir = existsSync(join(dirPath, "output")) ? join(dirPath, "output") : dirPath;

    // Load HTML
    const htmlPath = join(scanDir, "index.html");
    const html = existsSync(htmlPath)
      ? readFileSync(htmlPath, "utf-8")
      : "";

    // Load images as base64
    const files = readdirSync(scanDir);
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
