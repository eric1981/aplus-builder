import { NextRequest, NextResponse } from "next/server";
import { authenticateUser, createSession, SESSION_COOKIE, LOGOUT_COOKIE, seedAdmin } from "@/lib/auth";
import { checkRateLimit, clientIp } from "@/lib/limits";
import { logAudit } from "@/lib/audit";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 天（秒）

export async function POST(request: NextRequest) {
  // 登录限流（防暴力破解）
  if (!checkRateLimit(`login:${clientIp(request.headers)}`)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }

  seedAdmin(); // 惰性创建初始管理员

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
  }
  const email = (body?.email || "").trim();
  const password = body?.password || "";
  if (!email || !password) {
    return NextResponse.json({ error: "请输入邮箱和密码" }, { status: 400 });
  }

  const user = authenticateUser(email, password);
  if (!user) {
    logAudit("unknown", "auth.login_failed", { email });
    return NextResponse.json({ error: "邮箱或密码错误" }, { status: 401 });
  }

  const { token } = createSession(user.id);
  logAudit(user.id, "auth.login", { email });

  const res = NextResponse.json({
    ok: true,
    user: { id: user.id, name: user.name, role: user.role },
  });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  // 登录成功：清除登出标记
  res.cookies.set(LOGOUT_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
