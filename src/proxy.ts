import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 全站 /api 认证闸门（Next.js 16 的 proxy 文件约定，替代旧版 middleware）。
 *
 * 策略：
 * - `/api/output/*` 豁免：预览 iframe 内的 <img> 无法携带 Authorization 头，
 *   且该端点经路径校验（见 route 实现）后只能读取 ~/Downloads/aplus-builder 下的产出文件。
 * - 配置了 `AUTH_TOKEN` 时：其余所有 /api 请求必须携带
 *   `Authorization: Bearer <AUTH_TOKEN>`（localhost 本地访问仍放行，避免前端漏配 token 时本地功能静默损坏）。
 * - 未配置 `AUTH_TOKEN` 时：仅放行 Host 为 localhost / 127.0.0.1 / ::1 的请求，
 *   通过局域网/公网 IP 直接访问一律 401 —— 防止服务意外暴露在网络上。
 *
 * 注意：不依赖 request.nextUrl.hostname —— 在 next start 自托管模式下它会被规范化为
 * "localhost"，无法区分真实来源；原始 Host 请求头才是可靠的判断依据。
 *
 * 启用远程访问时，需同时设置两个环境变量（取相同值）：
 *   AUTH_TOKEN=xxx              → 服务端校验
 *   NEXT_PUBLIC_AUTH_TOKEN=xxx  → 注入前端请求头（见 src/lib/apiFetch.ts）
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

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // iframe 预览加载产出图片（img 标签无法携带 Authorization 头）
  if (pathname.startsWith("/api/output/")) {
    return withSecurityHeaders(NextResponse.next());
  }

  const isLocal = LOCAL_HOSTNAMES.has(
    extractHostname(request.headers.get("host") || ""),
  );

  if (AUTH_TOKEN) {
    const auth = request.headers.get("authorization") || "";
    if (auth === `Bearer ${AUTH_TOKEN}` || isLocal) {
      return withSecurityHeaders(NextResponse.next());
    }
    return withSecurityHeaders(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
  }

  if (isLocal) {
    return withSecurityHeaders(NextResponse.next());
  }

  return withSecurityHeaders(
    NextResponse.json(
      { error: "Unauthorized: 请配置 AUTH_TOKEN 环境变量以允许远程访问" },
      { status: 401 },
    ),
  );
}

export const config = {
  matcher: "/api/:path*",
};
