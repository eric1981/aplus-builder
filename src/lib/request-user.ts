/**
 * 调用者身份解析（安全加固）
 *
 * 身份由 `src/proxy.ts` 统一注入 `x-user-id`（会话 Cookie / Bearer token / 本机豁免）。
 * 各路由此前写作 `headers.get("x-user-id") || "admin"` —— 一旦某个路由绕过 proxy
 * （新增非 /api 前缀、内部调用、未来改动），缺头就会**降级成 admin**。
 * 这里统一改为：拿不到身份就返回 null，由调用方 401 拒绝（fail-closed）。
 */
import type { NextRequest } from "next/server";

/** 返回调用者 id；缺失或空串返回 null（调用方应回 401） */
export function callerId(request: NextRequest): string | null {
  const raw = request.headers.get("x-user-id");
  if (!raw) return null;
  const id = raw.trim();
  return id.length > 0 ? id : null;
}
