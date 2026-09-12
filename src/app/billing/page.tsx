"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../lib/apiFetch";
import { useAuth } from "../../lib/auth-client";

interface Order {
  id: string;
  userId: string;
  credits: number;
  amountCents: number;
  currency: string;
  provider: string;
  status: "pending" | "paid" | "refunded" | "canceled";
  externalId: string | null;
  note: string | null;
  createdAt: number;
  paidAt: number | null;
  refundedAt: number | null;
}

interface BillingData {
  balance: number;
  /** 积分单价（元/积分，可含小数，如 0.8） */
  creditPriceYuan: number;
  minTopupCredits: number;
  provider: string;
  orders: Order[];
}

const PRESETS = [10, 30, 50, 100, 200];

const STATUS_LABEL: Record<Order["status"], { text: string; cls: string }> = {
  pending: { text: "待支付", cls: "bg-orange-50 text-orange-600" },
  paid: { text: "已到账", cls: "bg-green-50 text-green-700" },
  refunded: { text: "已退款", cls: "bg-gray-100 text-text-muted" },
  canceled: { text: "已取消", cls: "bg-gray-100 text-text-muted" },
};

export default function BillingPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [data, setData] = useState<BillingData | null>(null);
  const [credits, setCredits] = useState<number>(PRESETS[1]);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/payments/me");
      if (res.status === 401) { router.replace("/login"); return; }
      const d = await res.json();
      setData(d);
    } catch {}
  }, [router]);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace("/login"); return; }
    load();
  }, [loading, user, load, router]);

  const unit = data?.creditPriceYuan ?? 1;
  /** ¥1 / ¥0.8 / ¥1.25 —— 整数不带小数尾巴，更好读 */
  const fmtUnit = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
  const unitYuan = fmtUnit(unit);
  const totalYuan = (credits * unit).toFixed(2);

  const createOrder = async () => {
    setMsg(null);
    const min = data?.minTopupCredits ?? 10;
    if (!Number.isFinite(credits) || credits < min) {
      setMsg({ type: "err", text: `最少充值 ${min} 积分` });
      return;
    }
    setCreating(true);
    try {
      const res = await apiFetch("/api/payments/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credits }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ type: "err", text: d.error || "下单失败" }); return; }
      setLastOrder(d.order);
      setMsg({ type: "ok", text: `已创建订单 ${d.order.id}，请按下方指引完成支付` });
      load();
    } catch {
      setMsg({ type: "err", text: "网络错误" });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-4 h-12 sm:h-14 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <a href="/" className="text-muted hover:text-accent text-xs sm:text-sm flex-shrink-0">←</a>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight truncate">充值 / 账单</h1>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <a href="/build" className="text-xs text-muted hover:text-accent font-medium">✚ 新建</a>
            <a href="/output" className="text-xs text-muted hover:text-accent font-medium">📋 产出</a>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8 space-y-6">
        {/* 余额 */}
        <div className="bg-white rounded-xl border border-border p-5">
          <p className="text-xs text-text-muted">当前余额</p>
          <p className="text-3xl font-semibold mt-1">
            {data ? data.balance : "—"}
            <span className="text-sm font-normal text-text-muted ml-1">积分</span>
          </p>
          <p className="text-xs text-text-muted mt-2">
            单价 ¥{unitYuan}/积分 · 最低起充 {data?.minTopupCredits ?? 10} 积分 ·
            支付方式：{data?.provider === "manual" ? "线下转账（人工确认）" : data?.provider || "—"}
          </p>
        </div>

        {/* 下单 */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div>
            <h2 className="font-semibold text-sm">充值积分</h2>
            <p className="text-xs text-text-muted mt-1">选择或填写积分数量，生成订单后可凭订单号线下支付。</p>
          </div>

          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p} onClick={() => setCredits(p)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${credits === p ? "bg-accent text-accent-on border-accent" : "bg-white text-muted border-border hover:border-accent"}`}>
                {p} 积分
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input type="number" min={1} value={credits}
              onChange={(e) => setCredits(Number(e.target.value))}
              className="w-32 px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent" />
            <span className="text-sm text-text-muted">积分 ≈ <span className="font-semibold text-fg">¥{totalYuan}</span></span>
            <button onClick={createOrder} disabled={creating}
              className="ml-auto px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-60">
              {creating ? "创建中…" : "生成充值订单"}
            </button>
          </div>

          {msg && (
            <p className={`text-xs ${msg.type === "ok" ? "text-green-600" : "text-red-500"}`}>{msg.text}</p>
          )}

          {lastOrder && lastOrder.status === "pending" && (
            <div className="p-4 rounded-xl bg-orange-50 border border-orange-200 space-y-2">
              <p className="text-sm font-medium text-orange-800">待支付订单</p>
              <div className="text-xs text-orange-900 space-y-1">
                <p>订单号：<span className="font-mono font-semibold">{lastOrder.id}</span>
                  <button onClick={() => navigator.clipboard?.writeText(lastOrder.id)}
                    className="ml-2 underline">复制</button>
                </p>
                <p>金额：<span className="font-semibold">¥{(lastOrder.amountCents / 100).toFixed(2)}</span> · 到账积分：<span className="font-semibold">{lastOrder.credits}</span></p>
              </div>
              {lastOrder.provider === "manual" ? (
                <div className="text-xs text-orange-900 leading-relaxed border-t border-orange-200 pt-2">
                  <p className="font-medium">支付方式：线下转账（人工确认）</p>
                  <p>1. 按上述金额完成转账；2. 把订单号发给管理员；3. 管理员在后台点「确认到账」后积分自动入账。</p>
                </div>
              ) : (
                <p className="text-xs text-orange-900">该通道已接入在线支付：请按通道页面完成付款，到账后积分自动入账。</p>
              )}
            </div>
          )}
        </div>

        {/* 订单历史 */}
        <div className="bg-white rounded-xl border border-border overflow-x-auto">
          <div className="px-5 py-3 border-b border-border text-sm font-medium">订单记录</div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-text-muted">
              <tr>
                <th className="px-4 py-2">订单号</th>
                <th className="px-4 py-2">积分</th>
                <th className="px-4 py-2">金额</th>
                <th className="px-4 py-2">状态</th>
                <th className="px-4 py-2">创建时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(!data || data.orders.length === 0) && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-text-muted">
                  {data ? "还没有订单" : "加载中…"}
                </td></tr>
              )}
              {data?.orders.map((o) => (
                <tr key={o.id}>
                  <td className="px-4 py-2 font-mono text-[11px]">{o.id}</td>
                  <td className="px-4 py-2">{o.credits}</td>
                  <td className="px-4 py-2">¥{(o.amountCents / 100).toFixed(2)}</td>
                  <td className="px-4 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${STATUS_LABEL[o.status]?.cls || ""}`}>
                      {STATUS_LABEL[o.status]?.text || o.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-text-muted">{new Date(o.createdAt).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-text-muted leading-relaxed">
          说明：充值订单只记录金额与积分；到账由服务端验签回调或管理员人工确认驱动，客户端无法自行标记已支付。
          需要开票或对账请联系管理员。
        </p>
      </div>
    </div>
  );
}
