/**
 * 前端 fetch 封装：自动附带 Bearer token（若配置了 NEXT_PUBLIC_AUTH_TOKEN）。
 *
 * 服务端校验见 src/proxy.ts。配置方式：
 *   AUTH_TOKEN=xxx              （服务端）
 *   NEXT_PUBLIC_AUTH_TOKEN=xxx  （前端，与 AUTH_TOKEN 取相同值）
 */
const TOKEN =
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AUTH_TOKEN : undefined;

export function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set("Authorization", `Bearer ${TOKEN}`);
  return fetch(input, { ...init, headers });
}
