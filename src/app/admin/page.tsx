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
  dailyLimit: number | null;
  monthlyLimit: number | null;
  credits: number;
  isAgent: boolean;
  agentCode: string | null;
  usage: { daily: number; monthly: number };
}

interface SettingItem {
  key: string;
  label: string;
  group: string;
  type: "number" | "boolean" | "select";
  options?: string[];
  env?: string;
  default: string | number | boolean;
  unit?: string;
  restartRequired?: boolean;
  description?: string;
  value: string;
  source: "db" | "env" | "default";
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
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [tab, setTab] = useState<"users" | "audit" | "settings" | "affiliate">(
    () => (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "affiliate" ? "affiliate" : "users"),
  );

  // 分销管理
  const [agents, setAgents] = useState<{
    id: string; name: string; email: string | null; code: string;
    clientCount: number; totalConsumed: number; estimatedEarning: number;
  }[]>([]);
  const [unboundUsers, setUnboundUsers] = useState<{ id: string; name: string }[]>([]);
  const [affiliateLoaded, setAffiliateLoaded] = useState(false);
  const [bindSel, setBindSel] = useState<Record<string, string>>({}); // userId → 选中 agentId

  // 新建用户表单
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" as "admin" | "user" });
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [uRes, sRes, aRes, stRes] = await Promise.all([
        apiFetch("/api/admin/users"),
        apiFetch("/api/admin/stats"),
        apiFetch("/api/admin/audit?limit=50"),
        apiFetch("/api/admin/settings"),
      ]);
      if (uRes.status === 403 || uRes.status === 401) {
        router.replace("/login");
        return;
      }
      const u = await uRes.json();
      const s = await sRes.json();
      const a = await aRes.json();
      const st = await stRes.json();
      setUsers(u.users || []);
      setStats(s);
      setAudit(a.entries || []);
      setSettings(st.settings || []);
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

  // 每用户配额编辑（空 = 不限）
  const editUserQuota = async (u: AdminUser) => {
    const daily = window.prompt(`设置 ${u.name} 的每日配额（空 = 不限）：`, u.dailyLimit == null ? "" : String(u.dailyLimit));
    if (daily === null) return;
    const monthly = window.prompt(`设置 ${u.name} 的每月配额（空 = 不限）：`, u.monthlyLimit == null ? "" : String(u.monthlyLimit));
    if (monthly === null) return;
    await patchUser(u.id, {
      dailyLimit: daily.trim() === "" ? null : Number(daily),
      monthlyLimit: monthly.trim() === "" ? null : Number(monthly),
    });
  };

  // 手动调整积分（正=发放 负=扣减）
  const adjustCredits = async (u: AdminUser) => {
    const input = window.prompt(
      `调整 ${u.name} 的积分（当前 ${u.credits} 分）\n输入正数发放，负数扣减，如 50 或 -10：`,
      "",
    );
    if (input === null || input.trim() === "") return;
    const delta = Number(input.trim());
    if (!Number.isFinite(delta) || delta === 0) {
      setMsg({ type: "err", text: "请输入非零整数" });
      return;
    }
    await patchUser(u.id, { creditsAdjust: Math.trunc(delta) });
  };

  // ---- 分销管理 ----
  const loadAffiliate = async () => {
    try {
      const res = await apiFetch("/api/admin/affiliate");
      if (!res.ok) return;
      const d = await res.json();
      setAgents(d.agents || []);
      setUnboundUsers(d.unbound || []);
      setAffiliateLoaded(true);
    } catch {}
  };
  // 切到分销 tab 时加载一次
  useEffect(() => {
    if (tab === "affiliate" && !affiliateLoaded) loadAffiliate();
  }, [tab, affiliateLoaded]);

  const markAgent = async (u: { id: string; name: string }, isAgent: boolean) => {
    setMsg(null);
    if (!isAgent && !window.confirm(`取消 ${u.name} 的代理身份？其名下绑定关系保留但不再计入收益。`)) return;
    try {
      const res = await apiFetch("/api/admin/affiliate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "markAgent", userId: u.id, isAgent }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ type: "err", text: d.error || "操作失败" }); return; }
      setMsg({ type: "ok", text: d.agentCode ? `${u.name} 已是代理，专属码 ${d.agentCode}` : "已更新" });
      setAffiliateLoaded(false); // 强制刷新
      load();
    } catch { setMsg({ type: "err", text: "网络错误" }); }
  };

  // 标记某普通用户为代理（从用户管理视角）
  const promoteToAgent = async (u: AdminUser) => {
    try {
      const res = await apiFetch("/api/admin/affiliate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "markAgent", userId: u.id, isAgent: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ type: "err", text: d.error || "操作失败" }); return; }
      setMsg({ type: "ok", text: `${u.name} 已设为代理，专属码 ${d.agentCode}` });
      setAffiliateLoaded(false);
      load();
    } catch { setMsg({ type: "err", text: "网络错误" }); }
  };

  const bindClient = async (userId: string) => {
    const agentId = bindSel[userId];
    if (!agentId) { setMsg({ type: "err", text: "请选择代理" }); return; }
    setMsg(null);
    try {
      const res = await apiFetch("/api/admin/affiliate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bind", userId, agentId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ type: "err", text: d.error || "操作失败" }); return; }
      setMsg({ type: "ok", text: "绑定成功" });
      setAffiliateLoaded(false);
      load();
    } catch { setMsg({ type: "err", text: "网络错误" }); }
  };

  // 系统设置保存（批量 PUT，仅可编辑项）
  const saveSettings = async () => {
    setMsg(null);
    const editable = settings.filter((s) => !s.restartRequired);
    const body: Record<string, string> = {};
    for (const s of editable) body[s.key] = s.value;
    try {
      const res = await apiFetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ type: "err", text: (data.errors || []).join("；") || "保存失败" });
        return;
      }
      setMsg({ type: "ok", text: `已保存 ${(data.updated || []).length} 项设置，即时生效` });
      load();
    } catch {
      setMsg({ type: "err", text: "网络错误" });
    }
  };

  const setSettingValue = (key: string, value: string) => {
    setSettings((prev) => prev.map((s) => (s.key === key ? { ...s, value } : s)));
  };

  const GROUP_LABELS: Record<string, string> = {
    quota: "配额",
    credits: "积分（真实扣减）",
    concurrency: "并发与队列",
    agent: "Agent",
    upload: "上传",
    auth: "登录与安全",
    system: "系统（部署级，仅环境变量生效）",
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
          {(["users", "settings", "audit", "affiliate"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium border ${tab === t ? "bg-accent text-accent-on border-accent" : "bg-white text-muted border-border"}`}>
              {t === "users" ? "用户管理" : t === "settings" ? "系统设置" : t === "affiliate" ? "分销管理" : "审计日志"}
            </button>
          ))}
        </div>

        {tab === "settings" && (
          <div className="space-y-6">
            {(["quota", "credits", "concurrency", "agent", "upload", "auth", "system"] as const).map((group) => {
              const items = settings.filter((s) => s.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="bg-white rounded-xl border border-border p-5">
                  <h2 className="font-semibold text-sm mb-4">{GROUP_LABELS[group]}</h2>
                  <div className="space-y-3">
                    {items.map((s) => (
                      <div key={s.key} className="flex flex-wrap items-center gap-3">
                        <div className="w-56 shrink-0">
                          <p className="text-sm">{s.label}</p>
                          {s.description && <p className="text-xs text-text-muted">{s.description}</p>}
                          {s.source !== "db" && (
                            <p className="text-[11px] text-amber-600">来源：{s.source === "env" ? `环境变量 ${s.env}` : "默认值"}</p>
                          )}
                        </div>
                        {s.restartRequired ? (
                          <span className="text-sm text-text-muted">由环境变量 {s.env} 配置</span>
                        ) : s.type === "boolean" ? (
                          <button
                            onClick={() => setSettingValue(s.key, s.value === "true" ? "false" : "true")}
                            className={`px-3 py-1 rounded-lg text-sm border ${s.value === "true" ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-muted border-border"}`}>
                            {s.value === "true" ? "开 ✓" : "关"}
                          </button>
                        ) : (
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              value={s.value}
                              min={group === "concurrency" ? 1 : 0}
                              onChange={(e) => setSettingValue(s.key, e.target.value)}
                              className="w-24 px-2 py-1 border border-border rounded-lg text-sm"
                            />
                            {s.unit && <span className="text-xs text-text-muted">{s.unit}</span>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="flex gap-3 items-center">
              <button onClick={saveSettings} className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">保存设置（即时生效）</button>
              <span className="text-xs text-text-muted">并发/超时/上传等改动立即生效；路径类需环境变量配置</span>
            </div>
          </div>
        )}

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
                    <th className="px-4 py-2">积分</th>
                    <th className="px-4 py-2">配额（日/月）</th>
                    <th className="px-4 py-2">状态</th>
                    <th className="px-4 py-2">创建时间</th>
                    <th className="px-4 py-2">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.map((u) => (
                    <tr key={u.id} className={u.disabled ? "opacity-50" : ""}>
                      <td className="px-4 py-2">
                        <div className="font-medium flex items-center gap-1.5">
                          {u.name}
                          {u.isAgent && (
                            <span className="px-1.5 py-0.5 rounded bg-green-50 text-green-700 text-[10px] font-semibold" title={u.agentCode ? `专属码 ${u.agentCode}` : "代理"}>
                              代理{u.agentCode ? ` · ${u.agentCode}` : ""}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-text-muted">{u.email || u.id}</div>
                      </td>
                      <td className="px-4 py-2">{u.role === "admin" ? "管理员" : "用户"}</td>
                      <td className="px-4 py-2">{u.taskCount}</td>
                      <td className="px-4 py-2">
                        <span className={`font-semibold ${u.credits <= 0 ? "text-red-500" : u.credits < 5 ? "text-orange-500" : ""}`}>{u.credits}</span>
                        <button onClick={() => adjustCredits(u)} className="ml-2 text-blue-600 hover:text-blue-800">调整</button>
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <span className="text-text-muted">今 {u.usage.daily}/{u.dailyLimit ?? "∞"} · 月 {u.usage.monthly}/{u.monthlyLimit ?? "∞"}</span>
                        <button onClick={() => editUserQuota(u)} className="ml-2 text-blue-600 hover:text-blue-800">编辑</button>
                      </td>
                      <td className="px-4 py-2">{u.disabled ? "已禁用" : "正常"}</td>
                      <td className="px-4 py-2 text-xs text-text-muted">{new Date(u.createdAt).toLocaleDateString("zh-CN")}</td>
                      <td className="px-4 py-2">
                        <div className="flex gap-2 text-xs">
                          {u.role !== "admin" && (
                            <>
                              {u.isAgent ? (
                                <span className="text-green-600 text-xs font-medium">✓ 代理</span>
                              ) : (
                                <button onClick={() => promoteToAgent(u)}
                                  className="text-green-600 hover:text-green-800">设为代理</button>
                              )}
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

        {tab === "affiliate" && (
          <div className="space-y-6">
            {/* 代理列表 */}
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h2 className="font-semibold text-sm">代理列表（{agents.length}）</h2>
                <p className="text-xs text-text-muted">收益 = 名下客户消耗 × 分成比例（积分记账，不结算）</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-text-muted">
                    <tr>
                      <th className="px-4 py-2">代理</th>
                      <th className="px-4 py-2">专属码</th>
                      <th className="px-4 py-2">客户数</th>
                      <th className="px-4 py-2">客户累计消耗</th>
                      <th className="px-4 py-2">预估收益</th>
                      <th className="px-4 py-2">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {agents.map((a) => (
                      <tr key={a.id}>
                        <td className="px-4 py-2">
                          <div className="font-medium">{a.name}</div>
                          <div className="text-xs text-text-muted">{a.email || a.id}</div>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs bg-gray-50 rounded">{a.code}</td>
                        <td className="px-4 py-2">{a.clientCount}</td>
                        <td className="px-4 py-2">{a.totalConsumed} 分</td>
                        <td className="px-4 py-2 font-semibold text-brand">{a.estimatedEarning} 分</td>
                        <td className="px-4 py-2">
                          <button onClick={() => markAgent({ id: a.id, name: a.name }, false)}
                            className="text-amber-600 hover:text-amber-800 text-xs">取消代理</button>
                        </td>
                      </tr>
                    ))}
                    {agents.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-muted">还没有代理。在"用户管理"中把某用户设为代理。</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 手动绑定客户 → 代理 */}
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <h2 className="font-semibold text-sm">手动绑定客户</h2>
                <p className="text-xs text-text-muted mt-0.5">把未绑定的普通用户绑定给某个代理（客户消耗积分时计入该代理收益）</p>
              </div>
              {unboundUsers.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted text-center">没有未绑定的普通用户</p>
              ) : (
                <div className="divide-y divide-border">
                  {unboundUsers.map((u) => (
                    <div key={u.id} className="px-4 py-2.5 flex items-center gap-3">
                      <span className="flex-1 text-sm truncate">{u.name}</span>
                      <select
                        value={bindSel[u.id] || ""}
                        onChange={(e) => setBindSel((p) => ({ ...p, [u.id]: e.target.value }))}
                        className="text-xs border border-border rounded-lg px-2 py-1 bg-white"
                      >
                        <option value="">选择代理…</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}（{a.code}）</option>
                        ))}
                      </select>
                      <button onClick={() => bindClient(u.id)}
                        className="px-2.5 py-1 text-xs bg-brand text-white rounded hover:bg-brand-hover">绑定</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
