import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { listUsers, createUserWithPassword } from "@/lib/users";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });
  const users = listUsers().map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.createdAt,
    taskCount: u.taskCount,
  }));
  return NextResponse.json({ users });
}

export async function POST(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  let body: { name?: string; email?: string; password?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
  }
  const name = (body?.name || "").trim();
  const email = (body?.email || "").trim();
  const password = body?.password || "";
  const role = body?.role === "admin" ? "admin" : "user";
  if (!name || !email || password.length < 8) {
    return NextResponse.json({ error: "请填写名称、邮箱，且密码至少 8 位" }, { status: 400 });
  }

  try {
    const user = createUserWithPassword(name, email, password, role);
    logAudit(admin.id, "admin.user_create", { target: user.id, email });
    return NextResponse.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "创建失败" }, { status: 400 });
  }
}
