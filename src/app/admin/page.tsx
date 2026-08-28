"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "../../lib/apiFetch";
import { useAuth, logout } from "../../lib/auth-client";

interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: string;
  taskCount: number;
}

interface Stats {
  quota: { daily: number; monthly: number; dailyLimit: number; monthlyLimit: number };
  tasks: Record<string, number>;
  totalTasks: number;
  totalUsers: number;
  activeSessions: number;
}

interface AuditEntry {
  id: number;
  ts: string;
  user: string;
  action: string;
  detail: Record<string, unknown> | null;
}

export default function AdminPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [tab, setTab] = useState<"users" | "audit">("users");

  // 新建用户表单
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" as "admin" | "user" });
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [uRes, sRes, aRes] = await Promise.all([
        apiFetch("/api/admin/users"),
        apiFetch("/api/admin/stats"),
        apiFetch("/api/admin/audit?limit=50"),
      ]);
      if (uRes.status === 403 || uRes.status === 401) {
        router.replace("/login");
        return;
      }
      const u = await uRes.json();
      const s = await sRes.json();
      const a = await aRes.json();
      setUsers(u.users || []);
      setStats(s);
      setAudit(a.entries || []);
    } catch {}
  }, [router]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (user.role !== "admin") {
      router.replace("/");
      return;
    }
    // 延迟到宏任务执行，避免 effect 内同步 setState
    const t = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(t);
  }, [loading, user, router, load]);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ type: "err", text: data.error || "创建失败" });
        return;
      }
      setMsg({ type: "ok", text: `已创建用户：${data.user.name}（${data.user.email}）` });
      setForm({ name: "", email: "", password: "", role: "user" });
      load();
    } catch {
      setMsg({ type: "err", text: "网络错误" });
    }
  };

  const patchUser = async (id: string, body: Record<string, unknown>) => {
    setMsg(null);
    try {
      const res = await apiFetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ type: "err", text: data.error || "操作失败" });
        return;
      }
      setMsg({ type: "ok", text: "操作成功" });
      load();
    } catch {
      setMsg({ type: "err", text: "网络错误" });
    }
  };

  const resetPassword = async (u: AdminUser) => {
    const pwd = window.prompt(`为 ${u.name} 设置新密码（至少 8 位）：`);
    if (!pwd) return;
    await patchUser(u.id, { password: pwd });
  };

  const removeUser = async (u: AdminUser) => {
    if (!window.confirm(`确认删除用户 ${u.name}？其任务/客户数据会保留在库中。`)) return;
    setMsg(null);
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setMsg({ type: "err", text: d.error || "删除失败" });
        return;
      }
      setMsg({ type: "ok", text: `已删除 ${u.name}` });
      load();
    } catch {
      setMsg({ type: "err", text: "网络错误" });
    }
  };

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  if (loading || !user || user.role !== "admin") {
    return <div className="min-h-screen flex items-center justify-center text-muted text-sm">加载中…</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-50 bg-white border-b border-border">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-muted hover:text-accent text-xs">←</Link>
            <h1 className="font-semibold">管理后台</h1>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-text-muted text-xs">{user.name}（{user.role}）</span>
            <button onClick={handleLogout} className="text-xs text-red-500 hover:text-red-700">退出登录</button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {msg && (
          <div className={`p-3 rounded-lg text-sm ${msg.type === "ok" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
            {msg.text}
          </div>
        )}

        {/* 总览 */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-border p-4">
              <p className="text-xs text-text-muted">今日配额</p>
              <p className="text-xl font-semibold mt-1">{stats.quota.daily}<span className="text-sm font-normal text-text-muted">/{stats.quota.dailyLimit}</span></p>
            </div>
            <div className="bg-white rounded-xl border border-border p-4">
              <p className="text-xs text-text-muted">本月配额</p>
              <p className="text-xl font-semibold mt-1">{stats.quota.monthly}<span className="text-sm font-normal text-text-muted">/{stats.quota.monthlyLimit}</span></p>
            </div>
            <div className="bg-white rounded-xl border border-border p-4">
              <p className="text-xs text-text-muted">任务总数</p>
              <p className="text-xl font-semibold mt-1">{stats.totalTasks}</p>
            </div>
            <div className="bg-white rounded-xl border border-border p-4">
              <p className="text-xs text-text-muted">用户 / 会话</p>
              <p className="text-xl font-semibold mt-1">{stats.totalUsers}<span className="text-sm font-normal text-text-muted"> / {stats.activeSessions}</span></p>
            </div>
          </div>
        )}

        {/* Tab */}
        <div className="flex gap-2">
          {(["users", "audit"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium border ${tab === t ? "bg-accent text-accent-on border-accent" : "bg-white text-muted border-border"}`}>
              {t === "users" ? "用户管理" : "审计日志"}
            </button>
          ))}
        </div>

        {tab === "users" && (
          <div className="space-y-6">
            {/* 创建用户 */}
            <form onSubmit={createUser} className="bg-white rounded-xl border border-border p-5 space-y-3">
              <h2 className="font-semibold text-sm">创建用户</h2>
              <div className="grid md:grid-cols-4 gap-3">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="姓名" required className="px-3 py-2 border border-border rounded-lg text-sm" />
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="邮箱" required className="px-3 py-2 border border-border rounded-lg text-sm" />
                <input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="初始密码（≥8位）" required minLength={8} className="px-3 py-2 border border-border rounded-lg text-sm" />
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "admin" | "user" })}
                  className="px-3 py-2 border border-border rounded-lg text-sm bg-white">
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
              <button type="submit" className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">创建</button>
            </form>

            {/* 用户列表 */}
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-text-muted">
                  <tr>
                    <th className="px-4 py-2">用户</th>
                    <th className="px-4 py-2">角色</th>
                    <th className="px-4 py-2">任务数</th>
                    <th className="px-4 py-2">状态</th>
                    <th className="px-4 py-2">创建时间</th>
                    <th className="px-4 py-2">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.map((u) => (
                    <tr key={u.id} className={u.disabled ? "opacity-50" : ""}>
                      <td className="px-4 py-2">
                        <div className="font-medium">{u.name}</div>
                        <div className="text-xs text-text-muted">{u.email || u.id}</div>
                      </td>
                      <td className="px-4 py-2">{u.role === "admin" ? "管理员" : "用户"}</td>
                      <td className="px-4 py-2">{u.taskCount}</td>
                      <td className="px-4 py-2">{u.disabled ? "已禁用" : "正常"}</td>
                      <td className="px-4 py-2 text-xs text-text-muted">{new Date(u.createdAt).toLocaleDateString("zh-CN")}</td>
                      <td className="px-4 py-2">
                        <div className="flex gap-2 text-xs">
                          {u.role !== "admin" && (
                            <>
                              <button onClick={() => patchUser(u.id, { disabled: !u.disabled })}
                                className="text-amber-600 hover:text-amber-800">{u.disabled ? "启用" : "禁用"}</button>
                              <button onClick={() => patchUser(u.id, { role: u.role === "admin" ? "user" : "admin" })}
                                className="text-blue-600 hover:text-blue-800">改角色</button>
                              <button onClick={() => removeUser(u)} className="text-red-500 hover:text-red-700">删除</button>
                            </>
                          )}
                          <button onClick={() => resetPassword(u)} className="text-text-muted hover:text-accent">重置密码</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "audit" && (
          <div className="bg-white rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-text-muted">
                <tr>
                  <th className="px-4 py-2">时间</th>
                  <th className="px-4 py-2">用户</th>
                  <th className="px-4 py-2">动作</th>
                  <th className="px-4 py-2">详情</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">{new Date(a.ts).toLocaleString("zh-CN")}</td>
                    <td className="px-4 py-2">{a.user}</td>
                    <td className="px-4 py-2 font-mono text-xs">{a.action}</td>
                    <td className="px-4 py-2 text-xs text-text-muted">{a.detail ? JSON.stringify(a.detail) : ""}</td>
                  </tr>
                ))}
                {audit.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-muted">暂无记录</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
