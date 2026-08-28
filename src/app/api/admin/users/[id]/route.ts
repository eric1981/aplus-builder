import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { getUserById, setUserDisabled, setUserRole, resetUserPassword, deleteUser } from "@/lib/users";
import { logAudit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });
  const { id } = await params;

  const target = getUserById(id);
  if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  if (target.role === "admin" && id !== admin.id) {
    return NextResponse.json({ error: "不能修改其他管理员" }, { status: 403 });
  }

  let body: { disabled?: boolean; role?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
  }

  try {
    if (typeof body.disabled === "boolean") {
      setUserDisabled(id, body.disabled);
      logAudit(admin.id, "admin.user_disable", { target: id, disabled: body.disabled });
    }
    if (body.role === "admin" || body.role === "user") {
      setUserRole(id, body.role);
      logAudit(admin.id, "admin.user_role", { target: id, role: body.role });
    }
    if (body.password) {
      if (body.password.length < 8) {
        return NextResponse.json({ error: "密码至少 8 位" }, { status: 400 });
      }
      resetUserPassword(id, body.password);
      logAudit(admin.id, "admin.user_reset_password", { target: id });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });
  const { id } = await params;

  const target = getUserById(id);
  if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  if (target.role === "admin") {
    return NextResponse.json({ error: "不能删除管理员" }, { status: 403 });
  }

  deleteUser(id);
  logAudit(admin.id, "admin.user_delete", { target: id });
  return NextResponse.json({ ok: true });
}
