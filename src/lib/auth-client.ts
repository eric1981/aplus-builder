"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./apiFetch";

export interface ClientUser {
  id: string;
  name: string;
  email: string | null;
  role: "admin" | "user";
}

/** 获取当前登录用户（localhost 下恒为 admin） */
export function useAuth() {
  const [user, setUser] = useState<ClientUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setUser(d.user || null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  return { user, loading };
}

/** 登出 */
export async function logout(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {}
}
