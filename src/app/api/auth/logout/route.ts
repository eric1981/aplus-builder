import { NextRequest, NextResponse } from "next/server";
import { deleteSession, SESSION_COOKIE, LOGOUT_COOKIE } from "@/lib/auth";

/**
 * 是否通过 HTTPS 访问（安全 Medium：会话 Cookie 的 Secure 标志）。
 * 不能用 NODE_ENV 判断 —— 纯 HTTP（局域网 IP / http 隧道）下带 Secure 的 Cookie 会被
 * 浏览器直接丢弃，导致登录静默失效；这里以请求实际协议为准。
 */
function isSecureRequest(request: NextRequest): boolean {
  return (
    request.nextUrl.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}


export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  deleteSession(token);
  const res = NextResponse.json({ ok: true });
  // 清除会话 Cookie
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });
  // 种下登出标记：即便 localhost 豁免，登出后也要求重新登录（7 天）
  res.cookies.set(LOGOUT_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
