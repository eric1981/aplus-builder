import { NextRequest, NextResponse } from "next/server";
import { getCustomer, getCustomerDir, updateCustomer } from "@/lib/customer-store";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { validateImageBlob } from "@/lib/upload-validate";
import { logAudit } from "@/lib/audit";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "未知错误";
}

/**
 * POST /api/customers/upload
 * Body: FormData with fields: id, type ("logo"|"model-ref"), file
 * Saves the file to <用户客户目录>/<filename> and updates profile.json
 */
export async function POST(request: NextRequest) {
  try {
    const userId = request.headers.get("x-user-id") || "admin";
    const formData = await request.formData();
    const id = formData.get("id") as string;
    const type = formData.get("type") as string; // "logo" or "model-ref"
    const file = formData.get("file") as Blob | null;

    if (!id || !type || !file) {
      return NextResponse.json({ error: "Missing id, type, or file" }, { status: 400 });
    }

    if (type !== "logo" && type !== "model-ref") {
      return NextResponse.json({ error: "type must be 'logo' or 'model-ref'" }, { status: 400 });
    }

    const profile = getCustomer(id, userId);
    if (!profile) {
      return NextResponse.json({ error: "客户不存在" }, { status: 404 });
    }

    const customerDir = getCustomerDir(id, userId);
    mkdirSync(customerDir, { recursive: true });

    // 校验：大小限制 + 按文件真实内容（magic bytes）判断格式，不信任客户端声明的 MIME
    const validated = await validateImageBlob(file);
    if (!validated) {
      return NextResponse.json({ error: "文件无效：仅支持 PNG/JPEG/WebP 图片，且不超过 15MB" }, { status: 400 });
    }
    const { buffer, ext } = validated;

    // 确定文件名
    const filename = type === "logo" ? `logo.${ext}` : `model-ref.${ext}`;

    // 写入文件
    const filePath = join(customerDir, filename);
    writeFileSync(filePath, buffer);

    // 更新 profile
    const updates: Partial<{ logo: string; modelRef: string }> = {};
    if (type === "logo") updates.logo = filename;
    else updates.modelRef = filename;
    const updated = updateCustomer(id, updates, userId);
    logAudit(userId, "customer.upload", { id, type, filename });

    return NextResponse.json({ ok: true, profile: updated });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
