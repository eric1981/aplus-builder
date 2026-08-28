import { NextRequest, NextResponse } from "next/server";
import { deleteSession, SESSION_COOKIE, LOGOUT_COOKIE } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  deleteSession(token);
  const res = NextResponse.json({ ok: true });
  // 清除会话 Cookie
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  // 种下登出标记：即便 localhost 豁免，登出后也要求重新登录（7 天）
  res.cookies.set(LOGOUT_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
