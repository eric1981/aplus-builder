"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { getHistory, loadOutput, outputImageUrl, type HistoryEntry, type LoadedOutput } from "../../lib/history";
import { apiFetch } from "../../lib/apiFetch";

const STORAGE_KEY = "aplus-builder-state";
const POLL_INTERVAL = 3000;

if (typeof window !== "undefined") {
  let errorCount = 0;
  window.addEventListener("error", (e) => {
    errorCount++;
    if (errorCount <= 3) console.error("[aplus-output] JS Error:", e.message);
  });
}

// ===== 类型 =====

type TaskImage = { name: string; base64: string; mime: string; path?: string };
type TaskVariant = { name: string; html: string };

interface QueueItem {
  id: string;
  productName: string;
  description: string;
  taskId?: string;
  status: "idle" | "queued" | "running" | "done" | "error";
  html?: string;
  images?: TaskImage[];
  variants?: TaskVariant[];
  error?: string;
  /** Agent 实时日志（显示系统正在执行什么任务） */
  agentLog?: string;
  /** Agent 人类可读进度（progress.log 行，优先展示） */
  progress?: string[];
  completedAt?: number;
  /** 市场潜力预测 */
  prediction?: { status: "running" | "done" | "error"; data?: PredictionData | null; error?: string };
}

interface PredictionData {
  score: number;
  unitsPerMonth?: { min: number; max: number };
  priceRange?: { min: number; max: number; currency?: string };
  competition?: "low" | "medium" | "high";
  seasonality?: "peak" | "stable" | "declining";
  trend?: "rising" | "flat" | "falling";
  bestSeason?: string;
  risks?: string[];
  opportunities?: string[];
  sellPoints?: string[];
  /** 成本核算 */
  cost?: { estimatedProductCost?: { min?: number; max?: number }; note?: string };
  amazonFees?: {
    referralRate?: number;
    estimatedReferral?: { min?: number; max?: number };
    estimatedFba?: { min?: number; max?: number };
    estimatedTotal?: { min?: number; max?: number };
  };
  profit?: { perUnit?: { min?: number; max?: number }; margin?: { min?: number; max?: number } };
  summary?: string;
}

interface SavedState {
  queueItems?: any[];
  preferences?: any;
}

// ===== 本地持久化 =====

function loadState(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    delete parsed.generatedHtml; delete parsed.images; delete parsed.variants;
    delete parsed.description; delete parsed.generating;
    return parsed;
  } catch { return null; }
}

function saveState(state: Partial<SavedState>) {
  try {
    const clean: SavedState = {
      queueItems: (state.queueItems || []).map(({ id, taskId, status, productName, description, completedAt }) => ({
        id, taskId, status, productName, description, completedAt,
      })),
      preferences: state.preferences,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch (e) {
    console.error("[saveState] localStorage 写入失败", e);
  }
}

// ===== 偏好画像 =====

interface PreferenceProfile {
  signal: string;
  pending_signals: string[];
  stats: { total: number };
}

const PROFILE_KEY = "aplus-builder-profile";

function loadProfile(): PreferenceProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") {
        // 防御：旧/损坏的画像数据缺少字段时归一化，避免 addSignal 崩溃
        if (!Array.isArray(p.pending_signals)) p.pending_signals = [];
        if (!p.stats || typeof p.stats.total !== "number") p.stats = { total: 0 };
        if (typeof p.signal !== "string") p.signal = "";
        return p;
      }
    }
  } catch {}
  return { signal: "", pending_signals: [], stats: { total: 0 } };
}
function saveProfile(p: PreferenceProfile) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {} }
function addSignal(profile: PreferenceProfile, signal: string): PreferenceProfile {
  profile.pending_signals.push(signal);
  profile.stats.total++;
  if (profile.pending_signals.length > 20) {
    profile.signal = profile.pending_signals.slice(-1)[0];
    profile.pending_signals = profile.pending_signals.slice(-10);
  }
  return profile;
}

/** 过滤 hermes agent 日志中的 diff/代码噪音，只保留可读叙述行 */
function filterAgentLogLines(log: string): string {
  return log.split("\n")
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      // 过滤 diff/路径/代码噪音
      if (/^[+\-@]/.test(t)) return false;
      if (/^(a|b)\//.test(t)) return false;
      if (t.startsWith("@@")) return false;
      if (t.startsWith("```")) return false;
      if (/^(print|import|def|from)\b/.test(t)) return false;
      if (t.startsWith("#!") || t.startsWith("#!/")) return false;
      if (/^(out|prompt|ref|size|watermark|response_format)\s*=/.test(t)) return false;
      return true;
    })
    .slice(-6)
    .join("\n");
}

// ===== 工具 =====

/**
 * 把 HTML 中的图片引用（./output/xxx.jpg、output/xxx.jpg、/api/output/.../xxx.jpg 等）
 * 替换成 base64 data URL，使预览 iframe 完全自包含 —— 不依赖会话 cookie、
 * 不依赖磁盘路径，避免 sandbox iframe 内图片 404 / 加载失败。
 */
function embedPreviewImages(html: string, images: TaskImage[]): string {
  let out = html;
  for (const img of images) {
    if (!img?.name || !img?.base64) continue;
    const dataUrl = `data:${img.mime || "image/jpeg"};base64,${img.base64}`;
    const escaped = img.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 匹配任意前缀（./output/、output/、/api/output/.../output/ 等）下的同名图片引用
    out = out.replace(
      new RegExp(`(["'])(?:[^"']*\\/)?${escaped}(["'])`, "g"),
      `$1${dataUrl}$2`,
    );
  }
  return out;
}

/** 市场潜力预测卡片 */
function PredictionCard({ prediction }: { prediction: { status: string; data?: PredictionData | null; error?: string } | null | undefined }) {
  if (!prediction) return null;
  if (prediction.status === "running") {
    return (
      <div className="mt-4 p-4 border border-border rounded-xl bg-white">
        <p className="text-sm font-semibold mb-2">📈 市场潜力预测</p>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="w-3 h-3 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
          正在联网分析 Amazon US 市场…
        </div>
      </div>
    );
  }
  const d = prediction.data;
  if (!d) {
    return (
      <div className="mt-4 p-4 border border-border rounded-xl bg-white">
        <p className="text-sm font-semibold mb-1">📈 市场潜力预测</p>
        <p className="text-xs text-text-muted">暂无预测数据{prediction.error ? `（${prediction.error}）` : ""}</p>
      </div>
    );
  }
  const badge = (label: string, val: string, color: string) => (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>{label}：{val}</span>
  );
  const fmtRange = (r: { min?: number; max?: number } | undefined, prefix: string) =>
    r && (r.min != null || r.max != null)
      ? `${prefix}${r.min ?? r.max ?? 0}${r.max != null && r.max !== r.min ? `-${r.max}` : ""}`
      : "—";
  const list = (title: string, items: string[] | undefined, color: string) =>
    items && items.length > 0 ? (
      <div>
        <p className={`text-xs font-semibold ${color} mb-1`}>{title}</p>
        <ul className="space-y-1 text-xs text-text-muted">
          {items.map((it, i) => (
            <li key={i} className="flex gap-1.5"><span className="shrink-0">·</span><span>{it}</span></li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <div className="mt-4 p-4 border border-border rounded-xl bg-white amz-card">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <p className="text-sm font-semibold">📈 市场潜力预测（Amazon US）</p>
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold"
          style={{ background: d.score >= 70 ? "#eaf5ef" : d.score >= 45 ? "#fdfbea" : "#fdf3f1", color: d.score >= 70 ? "#067d62" : d.score >= 45 ? "#8a6b1f" : "#b12704" }}>
          综合评分 {d.score}/100
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <div>
          <p className="text-xs text-text-muted">预估月销</p>
          <p className="text-sm font-semibold">{d.unitsPerMonth?.min != null ? `${d.unitsPerMonth.min}-${d.unitsPerMonth.max ?? d.unitsPerMonth.min} 件` : "—"}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">建议定价</p>
          <p className="text-sm font-semibold amz-price">{d.priceRange?.min != null ? `${d.priceRange.currency || "$"}${d.priceRange.min}-${d.priceRange.max ?? d.priceRange.min}` : "—"}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">竞争 / 季节</p>
          <p className="text-sm font-semibold">
            {d.competition === "high" ? "竞争高" : d.competition === "low" ? "竞争低" : "竞争中"}
            {" · "}
            {d.seasonality === "peak" ? "旺季" : d.seasonality === "declining" ? "淡季" : "平稳"}
          </p>
        </div>
        <div>
          <p className="text-xs text-text-muted">趋势 / 最佳季节</p>
          <p className="text-sm font-semibold">
            {d.trend === "rising" ? "↑ 上升" : d.trend === "falling" ? "↓ 下降" : "→ 平稳"}
            {d.bestSeason ? ` · ${d.bestSeason}` : ""}
          </p>
        </div>
      </div>

      {/* 成本核算 */}
      {(d.cost?.estimatedProductCost || d.profit || d.amazonFees) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border-soft mb-3">
          <div>
            <p className="text-xs text-text-muted">预估到岸成本</p>
            <p className="text-sm font-semibold">{fmtRange(d.cost?.estimatedProductCost, "$")}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">亚马逊费用</p>
            <p className="text-sm font-semibold">
              {fmtRange(d.amazonFees?.estimatedTotal, "$")}
              {d.amazonFees?.referralRate ? `（佣金${d.amazonFees.referralRate}%+FBA）` : ""}
            </p>
          </div>
          <div>
            <p className="text-xs text-text-muted">单件毛利</p>
            <p className="text-sm font-semibold amz-price">{fmtRange(d.profit?.perUnit, "$")}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">毛利率</p>
            <p className="text-sm font-semibold text-green-700">{fmtRange(d.profit?.margin, "")}{d.profit?.margin?.min != null ? "%" : ""}</p>
          </div>
          {d.cost?.note && (
            <p className="col-span-full text-[10px] text-meta">* {d.cost.note}</p>
          )}
        </div>
      )}

      <div className="grid sm:grid-cols-3 gap-3">
        {list("💡 卖点", d.sellPoints, "text-green-700")}
        {list("⚠️ 风险", d.risks, "text-red-600")}
        {list("🚀 机会", d.opportunities, "text-blue-700")}
      </div>

      {d.summary && (
        <p className="mt-3 pt-3 border-t border-border-soft text-xs text-text-muted leading-relaxed">
          {d.summary}
        </p>
      )}
      <p className="mt-2 text-[10px] text-meta">预测基于联网调研与经验推断，仅供参考，不构成销售承诺。</p>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ===== 常量 =====

const POLL_STATUSES = new Set(["running", "queued"]);

export default function OutputPage() {
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // 历史分页（每页条数）
  const HISTORY_PAGE_SIZE = 8;
  const [historyPage, setHistoryPage] = useState(1);
  const sortedHistory = useMemo(
    () => [...historyEntries].sort((a, b) => b.timestamp - a.timestamp),
    [historyEntries],
  );
  const historyTotalPages = Math.max(1, Math.ceil(sortedHistory.length / HISTORY_PAGE_SIZE));
  const effectiveHistoryPage = Math.min(historyPage, historyTotalPages);
  const pagedHistory = sortedHistory.slice(
    (effectiveHistoryPage - 1) * HISTORY_PAGE_SIZE,
    effectiveHistoryPage * HISTORY_PAGE_SIZE,
  );
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [rating, setRating] = useState<"liked" | "disliked" | null>(null);

  // 独立于队列的预览状态（历史恢复不加入队列）
  const [preview, setPreview] = useState<{
    html: string; images: TaskImage[]; variants: TaskVariant[]; title: string;
    prediction?: { status: string; data?: PredictionData | null; error?: string } | null;
  } | null>(null);
  // 预览加载失败提示（历史预览/查看任务失败时展示，避免"点了没反应"）
  const [previewError, setPreviewError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueItemsRef = useRef(queueItems);
  queueItemsRef.current = queueItems;
  const savedToHistoryRef = useRef(new Set<string>());

  // 队列中的各状态分组
  const activeItems = queueItems.filter((q) => POLL_STATUSES.has(q.status));
  const doneItems = queueItems.filter((q) => {
    if (q.status !== "done") return false;
    if (!q.completedAt) return true; // 无时间戳的老数据，保留兼容
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return q.completedAt >= today.getTime();
  });
  const errorItems = queueItems.filter((q) => q.status === "error");
  const hasQueue = activeItems.length > 0 || errorItems.length > 0;

  const runningCount = queueItems.filter((q) => q.status === "running").length;
  const doneCount = doneItems.length;
  const totalActive = activeItems.length + doneItems.length;

  const hasContent = hasQueue || doneItems.length > 0 || historyEntries.length > 0;

  // ====== 辅助：按 taskId 匹配历史 ======
  const findHistoryEntry = (entries: HistoryEntry[], item: QueueItem) => {
    const tid = item.taskId?.slice(0, 8) || "";
    return entries.find((e) =>
      e.dirName === item.productName || (tid && e.dirName.includes(tid))
    );
  };

  // -- 水合 --
  useEffect(() => {
    const saved = loadState();
    // 防御：localStorage 中的旧/损坏数据可能是非数组
    if (saved?.queueItems && Array.isArray(saved.queueItems)) setQueueItems(saved.queueItems);
    // 未登录（远程访问无会话）重定向到登录页；localhost 恒为 admin，不会触发
    apiFetch("/api/auth/me").then((r) => {
      if (r.status === 401) window.location.href = "/login";
    }).catch(() => {});
    // 历史加载失败要显式提示，不能静默显示"还没有产出"（例如局域网访问被认证拦截）
    apiFetch("/api/list-history")
      .then((r) => {
        if (!r.ok) throw new Error(`历史接口异常（HTTP ${r.status}）`);
        return r.json();
      })
      .then((d) => {
        if (d && Array.isArray(d.entries)) setHistoryEntries(d.entries);
        else setHistoryError("历史接口返回异常");
      })
      .catch((e) => setHistoryError(e?.message || "历史加载失败"));
    setHydrated(true);
  }, []);

  // -- 为无 html 的 done/error 项从磁盘加载内容 --
  useEffect(() => {
    if (!hydrated || historyEntries.length === 0) return;
    for (const item of queueItems) {
      if (item.html) continue;
      if (item.status !== "done" && item.status !== "error") continue;
      const match = findHistoryEntry(historyEntries, item);
      if (!match) continue;
      loadOutput(match.dirName).then((data) => {
        if (!data?.html) return;
        const imgs = data.images.map((img: any) => ({ name: img.name, base64: img.base64, mime: img.mime, path: img.path }));
        setQueueItems((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? { ...p, status: "done", html: embedPreviewImages(data.html, imgs), images: imgs, variants: data.variants?.map((v: any) => ({ name: v.name, html: embedPreviewImages(v.html, imgs) })) }
              : p
          )
        );
      }).catch(() => {});
    }
  }, [hydrated, historyEntries]);

  useEffect(() => { if (hydrated) saveState({ queueItems }); }, [queueItems, hydrated]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // -- 轮询 --
  const pollTasks = useCallback(() => {
    const items = queueItemsRef.current.filter((q) => q.taskId && POLL_STATUSES.has(q.status));
    if (items.length === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }

    if (!pollRef.current) {
      pollRef.current = setInterval(async () => {
        const active = queueItemsRef.current.filter((q) => q.taskId && POLL_STATUSES.has(q.status));
        if (active.length === 0) { clearInterval(pollRef.current!); pollRef.current = null; return; }

        for (const qi of active) {
          try {
            const res = await apiFetch(`/api/generate?taskId=${qi.taskId}`);
            const task = await res.json();

            if (task.status === "done" && task.html) {
              setQueueItems((prev) =>
                prev.map((p) =>
                  p.id === qi.id
                    ? { ...p, status: "done", html: task.html, images: task.images || [], variants: task.variants || [],
                        prediction: task.prediction,
                        completedAt: Date.now(), productName: task.productName || p.productName }
                    : p
                )
              );
              if (task.preference_signal) {
                const profile = addSignal(loadProfile(), task.preference_signal);
                saveProfile(profile);
              }
              if (!savedToHistoryRef.current.has(qi.id)) {
                savedToHistoryRef.current.add(qi.id);
                getHistory().then((d) => { if (Array.isArray(d)) setHistoryEntries(d); }).catch(() => {});
              }
            } else if (task.status === "error") {
              setQueueItems((prev) =>
                prev.map((p) =>
                  p.id === qi.id ? { ...p, status: "error", error: task.error || "生成失败" } : p
                )
              );
            } else if (task.status === "running" && qi.status === "queued") {
              setQueueItems((prev) =>
                prev.map((p) => (p.id === qi.id ? { ...p, status: "running" } : p))
              );
            } else if (task.status === "running") {
              // 运行中：更新进度（progress.log 优先，agent 日志兜底）+ 渐进展示图片
              const imgs = (task.images || []).map((img: any) => ({ name: img.name, base64: img.base64, mime: img.mime }));
              const progress = Array.isArray(task.progress) && task.progress.length > 0
                ? task.progress
                : undefined;
              setQueueItems((prev) =>
                prev.map((p) =>
                  p.id === qi.id
                    ? {
                        ...p,
                        productName: typeof task.productName === "string" && task.productName ? task.productName : p.productName,
                        progress: progress || p.progress,
                        agentLog: !progress && typeof task.log === "string" ? task.log : p.agentLog,
                        images: imgs.length > 0 ? imgs : p.images,
                      }
                    : p
                )
              );
            } else {
              // 任务可能在磁盘上已完成
              const entries = await getHistory();
              const tid8 = qi.taskId?.slice(0, 8) || "";
              const match = entries.find((e) =>
                e.dirName === qi.productName || (tid8 && e.dirName.includes(tid8))
              );
              if (match) {
                setHistoryEntries(entries);
                const data = await loadOutput(match.dirName);
                if (data?.html) {
                  const imgs = data.images.map((img: any) => ({ name: img.name, base64: img.base64, mime: img.mime, path: img.path }));
                  setQueueItems((prev) =>
                    prev.map((p) =>
                      p.id === qi.id
                        ? { ...p, status: "done", html: embedPreviewImages(data.html, imgs), images: imgs, variants: data.variants?.map((v: any) => ({ name: v.name, html: embedPreviewImages(v.html, imgs) })), completedAt: Date.now() }
                        : p
                    )
                  );
                  continue;
                }
              }
              setQueueItems((prev) =>
                prev.map((p) =>
                  p.id === qi.id ? { ...p, status: "error", error: task.error || "任务连接丢失" } : p
                )
              );
            }
          } catch {}
        }
      }, POLL_INTERVAL);
    }
  }, []);

  useEffect(() => { pollTasks(); }, [queueItems]);

  // -- 移除队列项 --
  const removeQueueItem = (id: string) => {
    setQueueItems((prev) => prev.filter((q) => q.id !== id));
  };

  // -- 取消任务（稳定性 P0：排队/运行中任务可取消）--
  const [cancelingIds, setCancelingIds] = useState<Set<string>>(new Set());

  const cancelTask = async (qi: QueueItem) => {
    if (!qi.taskId || cancelingIds.has(qi.id)) return;
    setCancelingIds((prev) => new Set(prev).add(qi.id));
    try {
      const res = await apiFetch(`/api/generate?taskId=${qi.taskId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.canceled) {
        // 排队任务已被服务端移除 → 本地标记为已取消（退出轮询）
        setQueueItems((prev) =>
          prev.map((p) => (p.id === qi.id ? { ...p, status: "error", error: "已取消" } : p))
        );
      }
      // 运行中任务保持轮询，等待服务端最终状态（完成或"任务已取消"）
    } catch {}
    setCancelingIds((prev) => { const s = new Set(prev); s.delete(qi.id); return s; });
  };

  // -- 下载 --
  const handleDownloadHtml = () => {
    const html = preview?.html;
    if (!html) return;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "aplus-detail.html"; a.click();
    URL.revokeObjectURL(url);
  };

  const downloadDataUrl = (base64: string, mime: string, filename: string) => {
    const a = document.createElement("a");
    a.href = `data:${mime};base64,${base64}`; a.download = filename; a.click();
  };

  // 单图下载：优先原图 URL（浏览器直接下载高清原图），否则回退 base64 缩略图
  const handleDownloadImage = (img: TaskImage) => {
    if (img.path) {
      const a = document.createElement("a");
      a.href = outputImageUrl(img.path);
      a.download = img.name;
      a.click();
      return;
    }
    downloadDataUrl(img.base64, img.mime, img.name);
  };

  const handleDownloadAll = async () => {
    if (!preview) return;
    setDownloadProgress(0);
    const worker = new Worker("/workers/zip-worker.js");
    worker.onmessage = (e: MessageEvent) => {
      const { type, blob, percent, processed, total } = e.data;
      if (type === "progress") {
        if (percent != null) setDownloadProgress(percent);
        else if (processed != null && total > 0) setDownloadProgress(Math.round((processed / total) * 100));
      } else if (type === "complete") {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "aplus-detail.zip"; a.click();
        URL.revokeObjectURL(url);
        setDownloadProgress(0); worker.terminate();
      }
    };
    // zip 打包：优先原图 URL（worker 内 fetch 原图），无 path 时回退 base64
    worker.postMessage({
      images: preview.images?.map((img) => ({
        name: img.name,
        base64: img.base64,
        mime: img.mime,
        url: img.path ? outputImageUrl(img.path) : undefined,
      })) || [],
      html: preview.html,
    });
  };

  const handleRate = (dir: "liked" | "disliked") => {
    setRating(dir);
    const profile = loadProfile();
    const prefix = dir === "liked" ? "👍 喜欢" : "👎 不喜欢";
    const signal = profile.signal ? `${profile.signal}（${prefix}）` : prefix;
    addSignal(profile, signal);
    saveProfile(profile);
  };

  // -- 历史恢复：不加入队列，直接预览 --
  const restoreHistory = async (entry: HistoryEntry) => {
    setPreviewError(null);
    try {
      const data = await loadOutput(entry.dirName);
      if (!data) {
        setPreviewError(`预览加载失败：未找到产出数据（${entry.dirName}）`);
        return;
      }
      const images = data.images.map((img: any) => ({ name: img.name, base64: img.base64, mime: img.mime, path: img.path }));
      setPreview({
        // 图片直接内嵌 base64，iframe 不再依赖 /api/output 网络请求（沙箱内可能丢 cookie 导致 404）
        html: embedPreviewImages(data.html, images),
        images,
        variants: data.variants?.map((v: any) => ({ name: v.name, html: embedPreviewImages(v.html, images) })) || [],
        title: entry.dirName,
        prediction: data.prediction ? { status: "done", data: data.prediction as unknown as PredictionData } : null,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) {
      setPreviewError(`预览加载失败：${e?.message || "未知错误"}`);
    }
  };

  // -- 查看已完成的任务 --
  const viewDoneItem = (item: QueueItem) => {
    setPreviewError(null);
    setPreview({
      html: item.html || "",
      images: item.images || [],
      variants: item.variants || [],
      title: item.productName || item.id.slice(-8),
      prediction: item.prediction || null,
    });
  };

  // -- 关闭预览 --
  const closePreview = () => { setPreview(null); setPreviewError(null); };

  // -- 响应式 HTML --
  const responsiveHtml = useMemo(() => {
    if (!preview?.html) return "";
    const raw = preview.html;
    const respCss = "<style>img,video,svg{display:block;max-width:100%!important;height:auto!important}body{margin:0}section,div[style*=margin]{margin-top:0!important;margin-bottom:1rem!important}</style>";
    const headIdx = raw.indexOf("</head>");
    if (headIdx !== -1) return raw.slice(0, headIdx) + respCss + raw.slice(headIdx);
    return respCss + raw;
  }, [preview]);

  // -- 画廊截图 --
  const [capturing, setCapturing] = useState(false);
  const captureGallery = async () => {
    if (!preview) return;
    setCapturing(true);
    const items = [{ html: preview.html, name: "editorial" }];
    if (preview.variants.length > 0) items.push({ html: preview.variants[0].html, name: "swiss" });
    if (preview.variants.length > 1) items.push({ html: preview.variants[1].html, name: "product-launch" });
    for (const { html, name } of items) {
      try { await apiFetch("/api/capture-gallery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html, name }) }); } catch {}
    }
    setCapturing(false);
  };

  // ========== 渲染 ==========

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl lg:max-w-5xl mx-auto px-3 sm:px-4 h-12 sm:h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/" className="text-text-muted hover:text-accent text-xs sm:text-sm">←</a>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight">产出中心</h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <a href="/customers" className="text-xs text-muted hover:text-accent font-medium">👤 客户</a>
            <a href="/build" className="text-xs bg-accent text-accent-on px-2.5 py-1 rounded-md font-medium hover:bg-accent-active transition-colors">✚ 新建</a>
          </div>
        </div>
      </header>

      <div className="max-w-2xl lg:max-w-5xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* ===== 预览加载失败提示 ===== */}
        {previewError && (
          <div className="p-3 sm:p-4 border border-red-200 bg-red-50 rounded-xl text-sm text-red-700 flex items-start gap-2">
            <span className="shrink-0">⚠️</span>
            <div className="flex-1 min-w-0">
              <p className="font-medium">预览加载失败</p>
              <p className="text-xs text-red-600 mt-0.5 break-all">{previewError}</p>
              <p className="text-xs text-red-500 mt-1">请确认产出文件完整（index.html 与图片），或刷新后重试。</p>
            </div>
            <button onClick={() => setPreviewError(null)} className="shrink-0 text-red-400 hover:text-red-600">✕</button>
          </div>
        )}

        {/* ===== 预览区 ===== */}
        {preview && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{preview.title}</h1>
              <button onClick={closePreview} className="text-sm text-text-muted hover:text-red-500">✕ 关闭</button>
            </div>

            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-base sm:text-lg font-semibold">A+ 详情预览</h2>
                <p className="text-text-muted text-xs sm:text-sm">
                  {Math.round((preview.html || "").length / 1024)}KB · {preview.images?.length || 0} 张图
                </p>
              </div>
              <div className="flex gap-1.5 sm:gap-2">
                <div className="flex items-center gap-0.5 sm:gap-1 mr-0.5 sm:mr-1">
                  <button onClick={() => handleRate("liked")}
                    className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm transition-all ${rating === "liked" ? "bg-green-100 text-green-600 scale-110" : "bg-gray-50 text-gray-400 hover:bg-green-50 hover:text-green-500"}`}>👍</button>
                  <button onClick={() => handleRate("disliked")}
                    className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm transition-all ${rating === "disliked" ? "bg-red-100 text-red-500 scale-110" : "bg-gray-50 text-gray-400 hover:bg-red-50 hover:text-red-500"}`}>👎</button>
                </div>
                <button onClick={handleDownloadHtml} className="px-3 py-1.5 border border-border rounded-lg text-xs font-medium hover:bg-gray-50 transition-colors">⬇ HTML</button>
                <button onClick={captureGallery} disabled={capturing}
                  className="px-3 py-1.5 border border-border rounded-lg text-xs font-medium hover:bg-purple-50 hover:border-purple-200 hover:text-purple-600 transition-colors disabled:opacity-50">{capturing ? "⏳" : "📸"} 画廊</button>
                {(preview.images?.length || 0) > 0 && (
                  downloadProgress > 0 ? (
                    <div className="px-3 py-1.5 bg-brand text-white rounded-lg text-xs font-medium flex items-center gap-2">
                      <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />{downloadProgress}%
                    </div>
                  ) : (
                    <button onClick={handleDownloadAll} className="px-3 py-1.5 bg-brand text-white rounded-lg text-xs font-medium hover:bg-brand-hover transition-colors">⬇ 全部 (.zip)</button>
                  )
                )}
              </div>
            </div>

            <div className="grid lg:grid-cols-5 gap-4 items-start">
              <div className="lg:col-span-3">
                <div className="border border-border rounded-xl overflow-hidden bg-white shadow-sm">
                  <iframe srcDoc={responsiveHtml} sandbox="allow-scripts allow-popups allow-forms" referrerPolicy="no-referrer" className="w-full" style={{ height: "85vh", minHeight: "600px", border: "none" }} title="预览" />
                </div>
              </div>
              {(preview.images?.length || 0) > 0 && (
                <div className="lg:col-span-2">
                  <h2 className="text-base sm:text-lg font-semibold mb-3">高清图片（{preview.images!.length} 张）</h2>
                  <div className="grid grid-cols-2 gap-2">
                    {preview.images!.map((img) => (
                      <div key={img.name} onClick={() => handleDownloadImage(img)}
                        className="group relative aspect-[3/4] rounded-lg overflow-hidden bg-gray-100 border border-border cursor-pointer hover:ring-2 hover:ring-brand/30 transition-all">
                        <img src={`data:${img.mime};base64,${img.base64}`} alt={img.name} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-end">
                          <div className="w-full p-2 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                            <p className="text-white text-xs truncate">{img.name}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 市场潜力预测（并行分析结果） */}
            <PredictionCard prediction={preview.prediction} />
          </div>
        )}

        {/* ===== 队列（进行中 + 失败）===== */}
        {hasQueue && (
          <div>
            <h2 className="text-base sm:text-lg font-semibold mb-3">队列</h2>
            {runningCount > 0 && (
              <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl text-sm mb-2">
                <span className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
                <span className="text-blue-800">{runningCount} 个生成中（约 2-5 分钟/个）</span>
              </div>
            )}
            <div className="space-y-2">
              {activeItems.map((qi) => (
                <div key={qi.id} className={`p-3 sm:p-4 rounded-xl border text-sm ${
                  qi.status === "running" ? "bg-blue-50 border-blue-200" : "bg-yellow-50 border-yellow-200"
                }`}>
                  <div className="flex items-center gap-3">
                    <span>{qi.status === "running" ? "🔵" : "⏳"}</span>
                    <span className="flex-1 truncate font-medium">{qi.productName || qi.description?.slice(0, 20) || qi.id.slice(-8)}</span>
                    {qi.taskId && (
                      <button onClick={() => cancelTask(qi)} disabled={cancelingIds.has(qi.id)}
                        className="px-2 py-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-40">取消</button>
                    )}
                  </div>

                  {/* Agent 实时进度：显示系统正在执行什么任务（progress.log 优先，agent 日志兜底） */}
                  {qi.status === "running" && qi.progress && qi.progress.length > 0 && (
                    <div className="mt-3 rounded-lg bg-white/70 border border-blue-100 p-2.5">
                      <div className="space-y-1">
                        {qi.progress.map((line, i) => (
                          <p key={i} className="text-[11px] leading-relaxed text-blue-900 flex items-start gap-1.5">
                            <span className="text-blue-400 mt-px">▸</span>
                            <span className="whitespace-pre-wrap break-words">{line}</span>
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                  {qi.status === "running" && (!qi.progress || qi.progress.length === 0) && qi.agentLog && (
                    <div className="mt-3 rounded-lg bg-white/70 border border-blue-100 p-2.5">
                      <pre className="text-[11px] leading-relaxed text-blue-900 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                        {filterAgentLogLines(qi.agentLog)}
                      </pre>
                    </div>
                  )}

                  {/* 渐进展示：有一张图就展示一张 */}
                  {qi.status === "running" && qi.images && qi.images.length > 0 && (
                    <div className="mt-3">
                      <p className="text-[11px] text-blue-700 font-medium mb-1.5">已产出 {qi.images.length} 张图（持续生成中）</p>
                      <div className="flex flex-wrap gap-2">
                        {qi.images.map((img) => (
                          <div key={img.name} className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-white border border-blue-100 flex-shrink-0">
                            <img src={`data:${img.mime};base64,${img.base64}`} alt={img.name} className="w-full h-full object-cover" loading="lazy" />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {errorItems.map((qi) => (
                <div key={qi.id} className="flex items-center gap-3 p-3 rounded-xl border text-sm bg-red-50 border-red-200">
                  <span>❌</span>
                  <span className="flex-1 truncate font-medium">{qi.productName || qi.description?.slice(0, 20) || qi.id.slice(-8)}</span>
                  <button onClick={() => removeQueueItem(qi.id)} className="px-2 py-1 text-xs text-red-500 hover:text-red-700">移除</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ===== 今日生图（已完成）===== */}
        {doneItems.length > 0 && (
          <div>
            <h2 className="text-base sm:text-lg font-semibold mb-3">今日生图</h2>
            <div className="space-y-2">
              {doneItems.map((qi) => (
                <div key={qi.id} className="flex items-center gap-3 p-3 rounded-xl border text-sm bg-green-50 border-green-200">
                  <span>✅</span>
                  <span className="flex-1 truncate font-medium">{qi.productName || qi.description?.slice(0, 20) || qi.id.slice(-8)}</span>
                  {qi.html && (
                    <button onClick={() => viewDoneItem(qi)} className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700">查看</button>
                  )}
                  <button onClick={() => removeQueueItem(qi.id)} className="px-2 py-1 text-xs text-text-muted hover:text-red-500">✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ===== 历史记录 ===== */}
        {historyEntries.length > 0 && (
          <div>
            <h2 className="text-base sm:text-lg font-semibold mb-3">历史记录（{historyEntries.length}）</h2>
            <div className="space-y-2">
              {pagedHistory.map((entry) => (
                <div key={entry.dirName} className="flex items-center gap-2 sm:gap-3 p-2 sm:p-3 bg-white border border-border rounded-xl hover:shadow-sm transition-shadow group">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-lg bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {entry.firstImage ? (
                      <img src={outputImageUrl(entry.firstImage)} loading="lazy" alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-lg">📄</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {entry.userId && entry.userId !== "admin" && (
                        <span className="mr-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-semibold align-middle">
                          👤 {entry.userName || entry.userId}
                        </span>
                      )}
                      {entry.dirName}
                    </p>
                    <p className="text-xs text-text-muted mt-0.5">{formatTime(entry.timestamp)} · {entry.imageCount} 张图{entry.variantNames.length > 0 && ` · ${entry.variantNames.length} 变体`}</p>
                  </div>
                  <div className="flex gap-1 sm:gap-1.5">
                    <button onClick={() => restoreHistory(entry)} className="px-2 py-1 text-[11px] bg-brand text-white rounded hover:bg-brand-hover transition-colors">预览</button>
                  </div>
                </div>
              ))}
            </div>
            {historyTotalPages > 1 && (
              <div className="flex items-center justify-center gap-4 mt-4 text-sm">
                <button
                  onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                  disabled={effectiveHistoryPage <= 1}
                  className="px-3 py-1.5 border border-border rounded-lg text-xs font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ‹ 上一页
                </button>
                <span className="text-xs text-text-muted">第 {effectiveHistoryPage} / {historyTotalPages} 页</span>
                <button
                  onClick={() => setHistoryPage((p) => Math.min(historyTotalPages, p + 1))}
                  disabled={effectiveHistoryPage >= historyTotalPages}
                  className="px-3 py-1.5 border border-border rounded-lg text-xs font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  下一页 ›
                </button>
              </div>
            )}
          </div>
        )}

        {/* 空状态 */}
        {!hasContent && hydrated && (
          <div className="text-center py-20 text-text-muted">
            <div className="text-4xl mb-4">📭</div>
            <p className="text-lg font-medium">还没有产出</p>
            <p className="text-sm mt-2">去 <a href="/build" className="text-brand hover:underline">新建任务</a> 开始生成</p>
            {historyError && (
              <p className="text-xs text-red-500 mt-3">⚠️ 历史加载失败：{historyError}（请确认通过 localhost 访问，或刷新重试）</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
