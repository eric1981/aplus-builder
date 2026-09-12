import { NextRequest, NextResponse } from "next/server";
import { authenticateUser, createSession, SESSION_COOKIE, LOGOUT_COOKIE, seedAdmin } from "@/lib/auth";
import { checkRateLimit, clientIp } from "@/lib/limits";
import { getSettingInt } from "@/lib/settings";
import { logAudit } from "@/lib/audit";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 天（秒）

export async function POST(request: NextRequest) {
  // 登录限流（防暴力破解）：IP 维度
  if (!checkRateLimit(`login-ip:${clientIp(request.headers)}`)) {
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

  // 账号维度限流（安全 H1）：IP 可伪造/轮换，账号不能 ——
  // 阈值取全局限流的三分之一（下限 5），避免把目标账号锁死的同时挡住高频爆破。
  const accountLimit = Math.max(5, Math.floor((getSettingInt("rateLimitPerMinute", 30) || 30) / 3));
  if (!checkRateLimit(`login-acct:${email.toLowerCase()}`, accountLimit)) {
    logAudit("unknown", "auth.login_throttled", { email });
    return NextResponse.json({ error: "该账号尝试过于频繁，请稍后再试" }, { status: 429 });
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
