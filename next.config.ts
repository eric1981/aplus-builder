import type { NextConfig } from "next";

/**
 * 全局安全响应头（安全加固）。
 *
 * 说明：这里刻意**不加**严格 CSP —— Next 的运行时依赖内联脚本，贸然收紧会白屏。
 * 因此只加不破坏功能的几项；HTML 类响应的脚本隔离由各路由自行用 CSP sandbox 处理
 * （如 /api/output 的产出 HTML）。
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
    ];
  },
};

export default nextConfig;
