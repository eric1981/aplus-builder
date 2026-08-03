"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { getHistory, loadOutput, rewriteImagePaths, type HistoryEntry } from "../../lib/history";

const STORAGE_KEY = "aplus-builder-state";
const POLL_INTERVAL = 3000;

// 全局 JS 错误兜底
if (typeof window !== "undefined") {
  let errorCount = 0;
  window.addEventListener("error", (e) => {
    errorCount++;
    if (errorCount <= 3) console.error("[aplus-output] JS Error:", e.message);
  });
}

// ===== 类型 =====

type TaskImage = { name: string; base64: string; mime: string };
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
  agentLog?: string;
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
    delete parsed.generatedHtml;
    delete parsed.images;
    delete parsed.variants;
    delete parsed.description;
    delete parsed.generating;
    return parsed;
  } catch { return null; }
}

function saveState(state: Partial<SavedState>) {
  try {
    const clean: SavedState = {
      queueItems: (state.queueItems || []).map(({ id, taskId, status, productName, description }) => ({
        id, taskId, status, productName, description,
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
  try { const raw = localStorage.getItem(PROFILE_KEY); if (raw) return JSON.parse(raw); } catch {}
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

// ===== 工具 =====

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

export default function OutputPage() {
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [rating, setRating] = useState<"liked" | "disliked" | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueItemsRef = useRef(queueItems);
  queueItemsRef.current = queueItems;
  const savedToHistoryRef = useRef(new Set<string>());

  // 计算值
  const generating = queueItems.some((q) => q.status === "running" || q.status === "queued");
  const runningCount = queueItems.filter((q) => q.status === "running").length;
  const doneCount = queueItems.filter((q) => q.status === "done").length;
  const totalQueued = queueItems.filter((q) => q.status !== "idle").length;
  const activeResult = queueItems.find((q) => q.id === activeResultId && q.status === "done");
  const filteredQueue = queueItems.filter((q) => q.status !== "idle");
  const hasContent = filteredQueue.length > 0 || historyEntries.length > 0;

  // -- 水合 --
  useEffect(() => {
    const saved = loadState();
    if (saved?.queueItems) setQueueItems(saved.queueItems);
    getHistory().then(setHistoryEntries).catch(() => {});
    setHydrated(true);
  }, []);

  // -- 为无 html 的 done 项从磁盘加载内容 --
  useEffect(() => {
    if (!hydrated || historyEntries.length === 0) return;
    for (const item of queueItems) {
      if (item.status !== "done" || item.html) continue;
      const match = historyEntries.find((e: HistoryEntry) => e.dirName === item.productName);
      if (!match) continue;
      loadOutput(match.dirName).then((data) => {
        if (!data?.html) return;
        setQueueItems((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? { ...p, html: rewriteImagePaths(data.html, match.dirName), images: data.images.map((img: any) => ({ name: img.name, base64: img.base64, mime: img.mime })), variants: data.variants?.map((v: any) => ({ name: v.name, html: rewriteImagePaths(v.html, match.dirName) })) }
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
    const items = queueItemsRef.current.filter((q) => q.taskId && (q.status === "running" || q.status === "queued"));
    if (items.length === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }

    if (!pollRef.current) {
      pollRef.current = setInterval(async () => {
        const active = queueItemsRef.current.filter((q) => q.taskId && (q.status === "running" || q.status === "queued"));
        if (active.length === 0) { clearInterval(pollRef.current!); pollRef.current = null; return; }

        for (const qi of active) {
          try {
            const res = await fetch(`/api/generate?taskId=${qi.taskId}`);
            const task = await res.json();

            if (task.status === "done" && task.html) {
              setQueueItems((prev) =>
                prev.map((p) =>
                  p.id === qi.id
                    ? { ...p, status: "done", html: task.html, images: task.images || [], variants: task.variants || [] }
                    : p
                )
              );
              setActiveResultId(qi.id);

              if (task.preference_signal) {
                const profile = addSignal(loadProfile(), task.preference_signal);
                saveProfile(profile);
              }
              if (!savedToHistoryRef.current.has(qi.id)) {
                savedToHistoryRef.current.add(qi.id);
                getHistory().then(setHistoryEntries).catch(() => {});
              }
            } else if (task.status === "error") {
              setQueueItems((prev) =>
                prev.map((p) =>
                  p.id === qi.id ? { ...p, status: "error", error: task.error || "生成失败", agentLog: task.log || "" } : p
                )
              );
            } else if (task.status === "running" && qi.status === "queued") {
              setQueueItems((prev) =>
                prev.map((p) => (p.id === qi.id ? { ...p, status: "running" } : p))
              );
            } else {
              // 任务可能已完成但服务重启丢失了内存状态，检查磁盘
              const entries = await getHistory();
              const match = entries.find((e: HistoryEntry) =>
                e.dirName === qi.productName || e.dirName.includes(qi.id.slice(-8))
              );
              if (match) {
                setHistoryEntries(entries);
                const data = await loadOutput(match.dirName);
                if (data?.html) {
                  setQueueItems((prev) =>
                    prev.map((p) =>
                      p.id === qi.id
                        ? { ...p, status: "done", html: rewriteImagePaths(data.html, match.dirName), images: data.images.map((img: any) => ({ name: img.name, base64: img.base64, mime: img.mime })), variants: data.variants?.map((v: any) => ({ name: v.name, html: rewriteImagePaths(v.html, match.dirName) })) }
                        : p
                    )
                  );
                  setActiveResultId(qi.id);
                  continue;
                }
              }
              // 确实丢失了
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
    if (activeResultId === id) {
      const next = queueItems.filter((q) => q.id !== id && q.status === "done")[0];
      setActiveResultId(next?.id || null);
    }
  };

  // -- 下载 --
  const handleDownloadHtml = () => {
    if (!activeResult?.html) return;
    const blob = new Blob([activeResult.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "aplus-detail.html"; a.click();
    URL.revokeObjectURL(url);
  };

  const downloadDataUrl = (base64: string, mime: string, filename: string) => {
    const a = document.createElement("a");
    a.href = `data:${mime};base64,${base64}`; a.download = filename; a.click();
  };

  const handleDownloadImage = (img: TaskImage) => downloadDataUrl(img.base64, img.mime, img.name);

  const handleDownloadAll = async () => {
    if (!activeResult) return;
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
    worker.postMessage({ images: activeResult.images || [], html: activeResult.html });
  };

  const handleRate = (dir: "liked" | "disliked") => {
    setRating(dir);
    const profile = loadProfile();
    const prefix = dir === "liked" ? "👍 喜欢" : "👎 不喜欢";
    const signal = profile.signal ? `${profile.signal}（${prefix}）` : prefix;
    addSignal(profile, signal);
    saveProfile(profile);
  };

  // -- 历史恢复 --
  const restoreHistory = async (entry: HistoryEntry) => {
    const data = await loadOutput(entry.dirName);
    if (!data) return;
    const id = `hist_${entry.dirName}`;
    const exists = queueItems.find((q) => q.id === id && q.status === "done");
    if (exists) { setActiveResultId(id); return; }

    const item: QueueItem = {
      id,
      productName: entry.dirName,
      description: "",
      status: "done",
      html: rewriteImagePaths(data.html, entry.dirName),
      images: data.images.map((img: any) => ({ name: img.name, base64: img.base64, mime: img.mime })),
      variants: data.variants?.map((v: any) => ({ name: v.name, html: rewriteImagePaths(v.html, entry.dirName) })),
    };
    setQueueItems((prev) => [...prev, item]);
    setActiveResultId(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const deleteHistory = async (dirName: string) => {
    setHistoryEntries((prev) => prev.filter((e) => e.dirName !== dirName));
  };

  // -- 响应式 HTML --
  const responsiveHtml = useMemo(() => {
    if (!activeResult?.html) return "";
    const raw = activeResult.html;
    const respCss = "<style>img,video,svg{display:block;max-width:100%!important;height:auto!important}body{margin:0}section,div[style*=margin]{margin-top:0!important;margin-bottom:1rem!important}</style>";
    const headIdx = raw.indexOf("</head>");
    if (headIdx !== -1) return raw.slice(0, headIdx) + respCss + raw.slice(headIdx);
    return respCss + raw;
  }, [activeResult]);

  // -- 画廊截图 --
  const [capturing, setCapturing] = useState(false);
  const captureGallery = async () => {
    if (!activeResult) return;
    setCapturing(true);
    const items = [{ html: activeResult.html!, name: "editorial" }];
    if (activeResult.variants && activeResult.variants.length > 0) items.push({ html: activeResult.variants[0].html, name: "swiss" });
    if (activeResult.variants && activeResult.variants.length > 1) items.push({ html: activeResult.variants[1].html, name: "product-launch" });
    for (const { html, name } of items) {
      try { await fetch("/api/capture-gallery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html, name }) }); } catch {}
    }
    setCapturing(false);
  };

  // ========== 渲染 ==========

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl lg:max-w-5xl mx-auto px-3 sm:px-4 h-12 sm:h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/build" className="text-text-muted hover:text-brand text-xs sm:text-sm flex-shrink-0">← 新建任务</a>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight">产出中心</h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <a href="/customers" className="text-xs text-brand hover:text-brand-hover font-medium">👤 客户</a>
          </div>
        </div>
      </header>

      <div className="max-w-2xl lg:max-w-5xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* ===== 队列状态条 ===== */}
        {filteredQueue.length > 0 && (
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-border text-sm">
            <span className="text-lg">📋</span>
            <div className="flex-1 min-w-0">
              <span className="font-medium">队列进度</span>
              <span className="text-text-muted ml-2">
                {doneCount > 0 ? `${doneCount}/${totalQueued} 已完成` : `共 ${totalQueued} 个任务`}
                {runningCount > 0 && ` · ${runningCount} 生成中`}
              </span>
            </div>
            <div className="w-32 sm:w-48 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand rounded-full transition-all duration-500"
                style={{ width: `${totalQueued > 0 ? (doneCount / totalQueued) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* ===== 空状态 ===== */}
        {!hasContent && !hydrated && (
          <div className="text-center py-20 text-text-muted">
            <div className="text-4xl mb-4">📭</div>
            <p className="text-lg font-medium">还没有产出</p>
            <p className="text-sm mt-2">去 <a href="/build" className="text-brand hover:underline">新建任务</a> 开始生成</p>
          </div>
        )}

        {/* ===== 结果预览 ===== */}
        {activeResult ? (
          <div className="space-y-4">
            {/* 队列横向 tab */}
            <div className="flex gap-2 overflow-x-auto pb-2">
              {filteredQueue.map((qi) => (
                <button
                  key={qi.id}
                  onClick={() => qi.status === "done" && setActiveResultId(qi.id)}
                  className={`flex-shrink-0 px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    qi.id === activeResultId
                      ? "bg-brand text-white"
                      : qi.status === "done"
                      ? "bg-gray-100 text-text hover:bg-gray-200"
                      : qi.status === "error"
                      ? "bg-red-50 text-red-600"
                      : "bg-blue-50 text-blue-600"
                  }`}
                >
                  {qi.status === "done" && "✅ "}
                  {qi.status === "running" && "🔵 "}
                  {qi.status === "queued" && "⏳ "}
                  {qi.status === "error" && "❌ "}
                  {qi.productName || qi.description?.slice(0, 12) || qi.id.slice(-6)}
                </button>
              ))}
            </div>

            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">
              {activeResult.productName || activeResult.description?.split(/[,，\n]/)[0] || "未命名产品"}
            </h1>

            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-base sm:text-lg font-semibold">A+ 详情预览</h2>
                <p className="text-text-muted text-xs sm:text-sm">
                  {Math.round((activeResult.html || "").length / 1024)}KB · {activeResult.images?.length || 0} 张图
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
                {(activeResult.images?.length || 0) > 0 && (
                  downloadProgress > 0 ? (
                    <div className="px-3 py-1.5 bg-brand text-white rounded-lg text-xs font-medium flex items-center gap-2">
                      <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />{downloadProgress}%
                    </div>
                  ) : (
                    <button onClick={handleDownloadAll} className="px-3 py-1.5 bg-brand text-white rounded-lg text-xs font-medium hover:bg-brand-hover transition-colors">⬇ 全部 (.zip)</button>
                  )
                )}
                <button onClick={() => removeQueueItem(activeResult.id)} className="px-2 py-1.5 text-xs text-text-muted hover:text-red-500">✕</button>
              </div>
            </div>

            <div className="grid lg:grid-cols-5 gap-4 items-start">
              <div className="lg:col-span-3">
                <div className="border border-border rounded-xl overflow-hidden bg-white shadow-sm">
                  <iframe srcDoc={responsiveHtml} className="w-full" style={{ height: "85vh", minHeight: "600px", border: "none" }} title="预览" />
                </div>
              </div>
              {(activeResult.images?.length || 0) > 0 && (
                <div className="lg:col-span-2">
                  <h2 className="text-base sm:text-lg font-semibold mb-3">高清图片（{activeResult.images!.length} 张）</h2>
                  <div className="grid grid-cols-2 gap-2">
                    {activeResult.images!.map((img) => (
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
          </div>
        ) : generating ? (
          <div className="space-y-4">
            {runningCount > 0 && (
              <div className="flex items-center gap-3 p-6 bg-blue-50 border border-blue-200 rounded-xl">
                <span className="w-5 h-5 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
                <div>
                  <p className="font-medium text-blue-800">Agent 正在工作中…</p>
                  <p className="text-sm text-blue-600 mt-0.5">{doneCount}/{totalQueued} · {runningCount} 个生成中（约 2-5 分钟/个）</p>
                </div>
              </div>
            )}
            {filteredQueue.filter((q) => q.status === "queued").length > 0 && (
              <div className="flex items-center gap-3 p-6 bg-yellow-50 border border-yellow-200 rounded-xl">
                <span className="text-2xl">⏳</span>
                <div>
                  <p className="font-medium text-yellow-800">排队中…</p>
                  <p className="text-sm text-yellow-600 mt-0.5">{filteredQueue.filter((q) => q.status === "queued").length} 个产品等待生成</p>
                </div>
              </div>
            )}
            {/* 队列列表 */}
            <div className="space-y-2">
              {filteredQueue.map((qi) => (
                <div key={qi.id} className={`flex items-center gap-3 p-3 rounded-xl border text-sm ${
                  qi.status === "done" ? "bg-green-50 border-green-200" :
                  qi.status === "error" ? "bg-red-50 border-red-200" :
                  qi.status === "running" ? "bg-blue-50 border-blue-200" :
                  "bg-yellow-50 border-yellow-200"
                }`}>
                  <span>{
                    qi.status === "done" ? "✅" : qi.status === "error" ? "❌" : qi.status === "running" ? "🔵" : "⏳"
                  }</span>
                  <span className="flex-1 truncate font-medium">{qi.productName || qi.description?.slice(0, 20) || qi.id.slice(-8)}</span>
                  {qi.status === "done" && (
                    <button onClick={() => setActiveResultId(qi.id)} className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700">查看</button>
                  )}
                  {qi.status === "error" && (
                    <button onClick={() => removeQueueItem(qi.id)} className="px-2 py-1 text-xs text-red-500 hover:text-red-700">移除</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : filteredQueue.length > 0 ? (
          /* 全部是 done 或 error，但没有 activeResult */
          <div className="space-y-2">
            {filteredQueue.map((qi) => (
              <div key={qi.id} className={`flex items-center gap-3 p-3 rounded-xl border text-sm ${
                qi.status === "done" ? "bg-green-50 border-green-200" :
                qi.status === "error" ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"
              }`}>
                <span>{qi.status === "done" ? "✅" : "❌"}</span>
                <span className="flex-1 truncate font-medium">{qi.productName || qi.description?.slice(0, 20) || qi.id.slice(-8)}</span>
                {qi.status === "done" && (
                  <button onClick={() => setActiveResultId(qi.id)} className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700">查看</button>
                )}
                {qi.status === "error" && (
                  <button onClick={() => removeQueueItem(qi.id)} className="px-2 py-1 text-xs text-red-500 hover:text-red-700">移除</button>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {/* ===== 历史记录 ===== */}
        {historyEntries.length > 0 && (
          <div className="border-t border-border pt-6 mt-6">
            <h2 className="text-base sm:text-lg font-semibold mb-4">历史记录（{historyEntries.length}）</h2>
            <div className="space-y-2">
              {historyEntries.map((entry) => (
                <div key={entry.dirName} className="flex items-center gap-2 sm:gap-3 p-2 sm:p-3 bg-white border border-border rounded-xl hover:shadow-sm transition-shadow group">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-lg bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
                    <img src={`/api/output/${encodeURIComponent(entry.dirName)}/screenshot.png`} alt="" className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLElement).style.display = "none"; }} />
                    <div className="text-lg">📄</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{entry.dirName}</p>
                    <p className="text-xs text-text-muted mt-0.5">{formatTime(entry.timestamp)} · {entry.imageCount} 张图{entry.variantNames.length > 0 && ` · ${entry.variantNames.length} 变体`}</p>
                  </div>
                  <div className="flex gap-1 sm:gap-1.5">
                    <button onClick={() => restoreHistory(entry)} className="px-2 py-1 text-[11px] bg-brand text-white rounded hover:bg-brand-hover transition-colors">恢复</button>
                    <button onClick={() => deleteHistory(entry.dirName)} className="px-2 py-1 text-[11px] border border-border rounded hover:bg-red-50 hover:border-red-200 text-text-muted hover:text-red-500 transition-colors">删除</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 空状态 — 水合完成后 */}
        {!hasContent && hydrated && (
          <div className="text-center py-20 text-text-muted">
            <div className="text-4xl mb-4">📭</div>
            <p className="text-lg font-medium">还没有产出</p>
            <p className="text-sm mt-2">去 <a href="/build" className="text-brand hover:underline">新建任务</a> 开始生成</p>
          </div>
        )}
      </div>
    </div>
  );
}
