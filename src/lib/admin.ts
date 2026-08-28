/**
 * 管理后台鉴权：仅 admin 角色可访问（身份由 proxy 注入的 x-user-id 提供）。
 */
import { NextRequest } from "next/server";
import { getUserById } from "@/lib/users";
import { seedAdmin } from "@/lib/auth";

export function requireAdmin(
  request: NextRequest,
): { id: string; name: string } | null {
  seedAdmin(); // 确保 admin 记录存在（惰性）
  const userId = request.headers.get("x-user-id");
  if (!userId) return null;
  const u = getUserById(userId);
  if (!u || u.role !== "admin" || u.disabled) return null;
  return { id: u.id, name: u.name };
}
