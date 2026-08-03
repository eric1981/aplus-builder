import { NextRequest, NextResponse } from "next/server";
import { readdirSync, existsSync } from "fs";
import { join, basename } from "path";

const TEMPLATES_DIR = join(process.cwd(), "customer-templates");

export async function GET(_request: NextRequest) {
  try {
    if (!existsSync(TEMPLATES_DIR)) {
      return NextResponse.json({ templates: [] });
    }
    const files = readdirSync(TEMPLATES_DIR)
      .filter(f => f.endsWith(".html") && !f.startsWith("."))
      .map(f => ({
        id: basename(f, ".html"),
        filename: f,
      }));
    return NextResponse.json({ templates: files });
  } catch {
    return NextResponse.json({ templates: [] });
  }
}
