import { NextRequest, NextResponse } from "next/server";
import { getUserBySessionToken, SESSION_COOKIE, seedAdmin } from "@/lib/auth";
import { getUserById } from "@/lib/users";

/**
 * GET /api/auth/me
 * 返回当前登录用户。身份来源（proxy 已注入 x-user-id）：
 * - 会话 Cookie → 用户
 * - token / localhost admin → x-user-id
 */
export async function GET(request: NextRequest) {
  seedAdmin();

  // 1) 会话 Cookie
  const sessionUser = getUserBySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (sessionUser) {
    return NextResponse.json({
      user: { id: sessionUser.id, name: sessionUser.name, email: sessionUser.email, role: sessionUser.role },
    });
  }

  // 2) proxy 注入的身份（token 用户 / localhost admin）
  const userId = request.headers.get("x-user-id");
  if (userId) {
    const u = getUserById(userId);
    if (u) {
      return NextResponse.json({
        user: { id: u.id, name: u.name, email: u.email ?? null, role: u.role },
      });
    }
    // admin 是内置用户，不一定在库中（兜底）
    if (userId === "admin") {
      return NextResponse.json({ user: { id: "admin", name: "管理员", email: null, role: "admin" } });
    }
  }

  return NextResponse.json({ user: null }, { status: 401 });
}
