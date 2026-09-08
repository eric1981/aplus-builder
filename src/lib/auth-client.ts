"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "./apiFetch";

export interface ClientUser {
  id: string;
  name: string;
  email: string | null;
  role: "admin" | "user";
  credits?: number;
}

// 全局 auth 通知：登录/登出后触发，所有 useAuth 订阅者重新拉取
const authSubscribers = new Set<() => void>();

/** 通知所有 useAuth 订阅者重新拉取当前用户（登录成功/登出后调用） */
export function refreshAuth(): void {
  authSubscribers.forEach((fn) => fn());
}

/** 获取当前登录用户（localhost 下恒为 admin） */
export function useAuth() {
  const [user, setUser] = useState<ClientUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = useCallback(async () => {
    try {
      const r = await apiFetch("/api/auth/me");
      if (r.ok) {
        const d = await r.json();
        setUser(d.user || null);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMe();
    // 订阅全局刷新（登录/登出后）
    const handler = () => fetchMe();
    authSubscribers.add(handler);
    return () => { authSubscribers.delete(handler); };
  }, [fetchMe]);

  return { user, loading };
}

/** 登出：通知所有订阅者刷新身份 */
export async function logout(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {}
  refreshAuth();
}
