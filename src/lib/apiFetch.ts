/**
 * 前端 fetch 封装。
 *
 * 安全 P0-7：这里此前会读取 `NEXT_PUBLIC_AUTH_TOKEN` 并自动附带
 * `Authorization: Bearer <token>`。但 `NEXT_PUBLIC_*` 会被编译进浏览器 JS bundle，
 * 而 proxy 中该 token 等价 admin —— 等于把管理员凭据公开发布给所有访客。
 * 该通道已移除：浏览器侧一律走会话 Cookie（HttpOnly），
 * 脚本/服务端调用请直接用 `Authorization: Bearer <AUTH_USERS 中的 token>` 自行发请求。
 */
export function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init);
}
