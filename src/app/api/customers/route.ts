import { NextRequest, NextResponse } from "next/server";
import { listCustomers, createCustomer, updateCustomer, deleteCustomer } from "@/lib/customer-store";
import { listVisibleTemplates } from "@/lib/style-templates";
import { logAudit } from "@/lib/audit";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "未知错误";
}

function userIdOf(request: NextRequest): string {
  return request.headers.get("x-user-id") || "admin";
}

/**
 * 允许客户端更新的字段白名单（安全 P0-4）。
 * 此前 PUT 把整个请求体透传给 updateCustomer（mass assignment）：客户端可任意写入
 * 任意字段，其中 customTemplateId 会进入 customer-templates 文件路径与 agent prompt，
 * logo/modelRef 会决定 customers/assets 读取哪个文件。现在只挑白名单字段。
 */
const UPDATABLE_FIELDS = [
  "name", "logo", "modelRef", "template", "sizeChartCsv", "requirements",
  "defaultStyle", "defaultModel", "customTemplateId", "notes",
] as const;

/** 文件名类字段：不得含路径分隔符或穿越片段（这些值会参与文件读取） */
const FILE_NAME_FIELDS = new Set(["logo", "modelRef", "template"]);

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(listCustomers(userIdOf(request)));
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = userIdOf(request);
    const { name } = await request.json();
    if (!name?.trim()) return NextResponse.json({ error: "客户名称不能为空" }, { status: 400 });
    const profile = createCustomer(name.trim(), userId);
    logAudit(userId, "customer.create", { id: profile.id, name: profile.name });
    return NextResponse.json(profile, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const userId = userIdOf(request);
    const body = await request.json();
    const { id } = body;
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    // 只接受白名单字段（id / createdAt / updatedAt 等一律忽略）
    const updates: Record<string, string> = {};
    for (const key of UPDATABLE_FIELDS) {
      if (!(key in body)) continue;
      const raw = (body as Record<string, unknown>)[key];
      if (raw === null || raw === undefined) continue;
      if (typeof raw !== "string") {
        return NextResponse.json({ error: `字段 ${key} 类型错误` }, { status: 400 });
      }
      if (raw.length > 20000) {
        return NextResponse.json({ error: `字段 ${key} 内容过长` }, { status: 400 });
      }
      if (FILE_NAME_FIELDS.has(key) && /[/\\]|\.\./.test(raw)) {
        return NextResponse.json({ error: `字段 ${key} 含非法路径字符` }, { status: 400 });
      }
      updates[key] = raw;
    }
    if (updates.name !== undefined && !updates.name.trim()) {
      return NextResponse.json({ error: "客户名称不能为空" }, { status: 400 });
    }
    // 定制模板：格式校验 + 必须是当前用户可见的模板（防越权指定他人模板或路径片段）
    if (updates.customTemplateId) {
      const tplId = updates.customTemplateId;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tplId)) {
        return NextResponse.json({ error: "模板 ID 格式非法" }, { status: 400 });
      }
      if (!listVisibleTemplates(userId).some((t) => t.id === tplId)) {
        return NextResponse.json({ error: "模板不存在或无权使用" }, { status: 403 });
      }
    }

    const updated = updateCustomer(id, updates, userId);
    logAudit(userId, "customer.update", { id, fields: Object.keys(updates) });
    return NextResponse.json(updated);
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const userId = userIdOf(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    deleteCustomer(id, userId);
    logAudit(userId, "customer.delete", { id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
