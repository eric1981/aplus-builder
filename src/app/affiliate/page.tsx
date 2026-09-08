"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/apiFetch";
import { useAuth } from "../../lib/auth-client";

interface AffiliateData {
  isAgent: boolean;
  agentCode?: string;
  clientCount?: number;
  totalConsumed?: number;
  commissionPercent?: number;
  estimatedEarning?: number;
  clients?: {
    userId: string;
    userName: string;
    email: string | null;
    source: string;
    boundAt: number;
    consumed: number;
    currentBalance: number;
  }[];
}

export default function AffiliatePage() {
  const { user } = useAuth();
  const [data, setData] = useState<AffiliateData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/affiliate/me")
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          setError(d.error || "加载失败");
          return;
        }
        setData(await r.json());
      })
      .catch(() => setError("网络错误"));
  }, []);

  if (!user) return <div className="min-h-screen flex items-center justify-center text-sm text-muted">加载中…</div>;
  if (error) return <div className="min-h-screen flex items-center justify-center text-sm text-red-500">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-sm text-muted">加载中…</div>;

  if (!data.isAgent) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center px-4">
        <div className="text-5xl">🤝</div>
        <h1 className="text-xl font-bold">分销中心</h1>
        <p className="text-sm text-text-muted max-w-sm">你当前还不是代理。联系管理员开通代理身份后，即可通过专属二维码发展客户并获得收益。</p>
        <a href="/" className="mt-2 px-5 py-2 bg-brand text-white rounded-lg text-sm hover:bg-brand-hover">返回首页</a>
      </div>
    );
  }

  const clients = data.clients || [];
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-4xl mx-auto px-4 h-12 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/" className="text-text-muted hover:text-accent text-sm">←</a>
            <h1 className="font-semibold text-base">分销中心</h1>
          </div>
          <a href="/build" className="text-xs bg-accent text-accent-on px-2.5 py-1 rounded-md font-medium hover:bg-accent-active">✚ 去生成</a>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
        {/* 专属码 */}
        <div className="bg-white border border-border rounded-xl p-4 sm:p-5">
          <h2 className="text-sm font-semibold mb-1">我的专属邀请码</h2>
          <p className="text-xs text-text-muted mb-2">把下面的链接/码分享给客户，客户注册时自动绑定到你名下。目前由管理员手动绑定，二维码功能上线中。</p>
          <div className="flex items-center gap-2">
            <code className="px-3 py-1.5 bg-gray-100 rounded-lg font-mono text-lg tracking-widest">{data.agentCode}</code>
          </div>
        </div>

        {/* 收益汇总 */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white border border-border rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-brand">{data.clientCount}</div>
            <div className="text-xs text-text-muted mt-1">名下客户</div>
          </div>
          <div className="bg-white border border-border rounded-xl p-4 text-center">
            <div className="text-2xl font-bold">{data.totalConsumed}</div>
            <div className="text-xs text-text-muted mt-1">客户累计消耗（分）</div>
          </div>
          <div className="bg-white border border-border rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{data.estimatedEarning}</div>
            <div className="text-xs text-text-muted mt-1">预估收益（分 · {data.commissionPercent}%）</div>
          </div>
        </div>

        {/* 客户明细 */}
        <div className="bg-white border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border font-semibold text-sm">名下客户（{clients.length}）</div>
          {clients.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">还没有客户，快去邀请吧</p>
          ) : (
            <div className="divide-y divide-border">
              {clients.map((c) => (
                <div key={c.userId} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{c.userName}</p>
                    <p className="text-xs text-text-muted truncate">{c.email || c.userId} · {c.source === "qr" ? "扫码" : "手动绑定"}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold">{c.consumed} <span className="text-[10px] text-text-muted font-normal">已消耗</span></p>
                    <p className="text-xs text-text-muted">余额 {c.currentBalance} 分</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
