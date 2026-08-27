import { NextRequest, NextResponse } from "next/server";
import { getCustomer, getCustomerFilePath } from "@/lib/customer-store";
import { readFileSync } from "fs";
import { extname } from "path";

/**
 * GET /api/customers/assets?id=<customerId>&type=logo|model-ref
 * 返回客户图片资产的 data URL
 */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const type = request.nextUrl.searchParams.get("type");
  const userId = request.headers.get("x-user-id") || "admin";

  if (!id || !type) {
    return NextResponse.json({ error: "Missing id or type" }, { status: 400 });
  }

  let profile: ReturnType<typeof getCustomer>;
  try {
    profile = getCustomer(id, userId);
  } catch {
    return NextResponse.json({ error: "非法客户 ID" }, { status: 400 });
  }
  if (!profile) {
    return NextResponse.json({ error: "客户不存在" }, { status: 404 });
  }

  const filename = type === "logo" ? profile.logo : type === "model-ref" ? profile.modelRef : null;
  if (!filename) {
    return NextResponse.json({ dataUrl: null });
  }

  const fp = getCustomerFilePath(id, filename, userId);
  if (!fp) {
    return NextResponse.json({ dataUrl: null });
  }

  const ext = extname(fp).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const b64 = readFileSync(fp).toString("base64");
  return NextResponse.json({ dataUrl: `data:${mime};base64,${b64}`, mime });
}
