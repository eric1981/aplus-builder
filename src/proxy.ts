import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { findUserByToken } from "@/lib/users";

/**
 * 全站 /api 认证闸门（Next.js 16 的 proxy 文件约定，替代旧版 middleware）。
 *
 * 认证与用户识别（稳定性 P1：多用户 token 体系）：
 * - Bearer token 命中用户注册表（data/users.json，可用 AUTH_USERS env 种子）→
 *   以 x-user-id 请求头注入下游路由，实现数据按用户隔离。
 * - 兼容旧配置：AUTH_TOKEN 匹配 → 视为 admin。
 * - localhost 访问 → 视为 admin（本地默认用户，数据沿用旧布局）。
 * - `/api/output/*` 豁免认证：预览 iframe 内的 <img> 无法携带 Authorization 头；
 *   该端点经路径校验后只能读取产出目录，且带 x-user-id 时按用户隔离读取。
 *
 * 注意：不依赖 request.nextUrl.hostname —— 在 next start 自托管模式下它会被规范化为
 * "localhost"，无法区分真实来源；原始 Host 请求头才是可靠的判断依据。
 */
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** 从 Host 头提取主机名（兼容 IPv6 方括号与端口） */
function extractHostname(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end !== -1 ? h.slice(0, end + 1) : h;
  }
  return h.split(":")[0];
}

function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

/** 放行并把用户身份注入 x-user-id 请求头 */
function allowAs(request: NextRequest, userId: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-user-id", userId);
  return withSecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // iframe 预览加载产出图片（img 标签无法携带 Authorization 头）——免认证
  if (pathname.startsWith("/api/output/")) {
    const auth = request.headers.get("authorization") || "";
    const tokenUser = auth.startsWith("Bearer ")
      ? findUserByToken(auth.slice(7))
      : null;
    // 带有效 token 则按用户隔离，否则 admin（本地默认布局）
    return allowAs(request, tokenUser?.id || "admin");
  }

  const isLocal = LOCAL_HOSTNAMES.has(
    extractHostname(request.headers.get("host") || ""),
  );

  // 优先：用户注册表 token
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const tokenUser = findUserByToken(auth.slice(7));
    if (tokenUser) return allowAs(request, tokenUser.id);
    // 兼容旧配置：AUTH_TOKEN 等价于 admin
    if (AUTH_TOKEN && auth === `Bearer ${AUTH_TOKEN}`) {
      return allowAs(request, "admin");
    }
  }

  // 本机访问 = admin（本地单用户场景，行为与之前完全一致）
  if (isLocal) {
    return allowAs(request, "admin");
  }

  return withSecurityHeaders(
    NextResponse.json(
      { error: "Unauthorized: 请使用有效的 API token（AUTH_USERS）访问" },
      { status: 401 },
    ),
  );
}

export const config = {
  matcher: "/api/:path*",
};
