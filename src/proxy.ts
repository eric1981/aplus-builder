import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { findUserByToken } from "@/lib/users";
import { getUserBySessionToken, SESSION_COOKIE, LOGOUT_COOKIE } from "@/lib/auth";
import { getSettingBool } from "@/lib/settings";
import { canonicalEncodedPath, verifyAssetPath } from "@/lib/asset-signing";

/**
 * 全站 /api 认证闸门（Next.js 16 的 proxy 文件约定，替代旧版 middleware）。
 *
 * 身份解析优先级：
 * 1. 会话 Cookie（Web 登录，HttpOnly）→ 对应用户
 * 2. Bearer token（用户注册表 / 旧版 AUTH_TOKEN）→ 对应用户 / admin
 * 3. localhost 访问 → admin（本地默认用户，数据沿用旧布局）
 * 4. 其余 → 401
 *
 * `/api/output/*` 豁免认证（iframe 预览 <img> 无法携带 Authorization 头），
 * 但带会话 Cookie 或 token 时按用户隔离读取 —— 解决了多用户预览图隔离问题。
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

/** 从请求解析登录用户：优先会话 Cookie，其次 Bearer token */
function resolveUser(request: NextRequest): { userId: string } | null {
  // 1) 会话 Cookie（Web 登录）
  const sessionUser = getUserBySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (sessionUser) return { userId: sessionUser.id };

  // 2) Bearer token
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const tokenUser = findUserByToken(auth.slice(7));
    if (tokenUser) return { userId: tokenUser.id };
    if (AUTH_TOKEN && auth === `Bearer ${AUTH_TOKEN}`) return { userId: "admin" };
  }
  return null;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 登录/登出端点：自身处理认证（登录已限流），不套鉴权闸
  if (pathname.startsWith("/api/auth/login") || pathname.startsWith("/api/auth/logout")) {
    return withSecurityHeaders(NextResponse.next());
  }

  // 支付回调：支付方是外部系统，无法携带用户会话 —— 改为**凭 HMAC 签名建立身份**
  // （route 内部 verifySignature 校验，未配置 PAYMENT_WEBHOOK_SECRET 时 fail-closed 503）。
  // 除该路径外的支付接口（下单/查单/退款）一律仍要求登录。
  if (pathname === "/api/payments/webhook") {
    return withSecurityHeaders(NextResponse.next());
  }

  const isLocal = LOCAL_HOSTNAMES.has(
    extractHostname(request.headers.get("host") || ""),
  );
  // 本机免登录豁免（默认关闭）。安全 H2：Host 头由客户端可控，仅凭它判断"本机"
  // 等于给公网留后门（发 Host: localhost 即成为 admin）。因此额外要求：
  //   ① 环境变量 ALLOW_LOCALHOST_ADMIN=1 —— 必须有主机访问权才能设置，
  //      光靠管理后台的开关（DB）不足以开启；
  //   ② 未携带 x-real-ip（反代/隧道通常会写该头）→ 视为经过转发，不算本机；
  //   ③ 未点过登出。
  // 注意：Next 会自行注入 x-forwarded-for（等于对端地址），因此**不能**用它的存在性
  // 当反代信号；且若隧道与本站同机，远端请求也可能呈现为本机 —— 公网可达的部署请勿开启。
  const localExempt =
    isLocal &&
    getSettingBool("trustLocalhost") &&
    process.env.ALLOW_LOCALHOST_ADMIN === "1" &&
    !request.headers.get("x-real-ip") &&
    !request.cookies.get(LOGOUT_COOKIE);

  // 产出文件（图片 / HTML / 清单）：默认必须登录，并按用户目录隔离。
  //
  // 安全 P0-1：这里此前是「免认证 + 未登录回落 admin」，等于任何人都能读取
  // OUTPUT_BASE 下所有租户的文件（产品原图、prompt.txt、input-meta.json…）。
  // 现在未登录时只放行一种情况：服务端自己签发的公开图签名 URL
  // （首页作品墙 /api/hero-images 返回的模特场景图），其余一律 401。
  if (pathname.startsWith("/api/output/")) {
    const user = resolveUser(request);
    if (user) return allowAs(request, user.userId);

    const encodedPath = canonicalEncodedPath(pathname.slice("/api/output/".length));
    const isPublicImage = /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(encodedPath);
    if (isPublicImage && verifyAssetPath(encodedPath, request.nextUrl.searchParams.get("sig"))) {
      // 签名有效：以公开图归属方（品牌方，默认 admin）身份读取
      return allowAs(request, process.env.HERO_IMAGE_USER || "admin");
    }

    return withSecurityHeaders(
      NextResponse.json(
        { error: "Unauthorized: 请先登录（公开图需使用服务端签发的签名链接）" },
        { status: 401 },
      ),
    );
  }

  // 首页悬浮模特图：随机取品牌方（HERO_IMAGE_USER，默认 admin）的公开产出，
  // 服务端限定范围，前端不可指定 userId，免认证
  if (pathname.startsWith("/api/hero-images")) {
    return allowAs(request, "admin");
  }

  const user = resolveUser(request);
  if (user) return allowAs(request, user.userId);

  // 本机访问且未登出 = admin（本地单用户场景，行为与之前完全一致）
  if (localExempt) {
    return allowAs(request, "admin");
  }

  return withSecurityHeaders(
    NextResponse.json(
      { error: "Unauthorized: 请先登录（或使用有效的 API token）" },
      { status: 401 },
    ),
  );
}

export const config = {
  matcher: "/api/:path*",
};
