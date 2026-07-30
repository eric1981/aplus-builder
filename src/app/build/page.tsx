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
    if (errorCount <= 3) console.error("[aplus-builder] JS Error:", e.message, e.filename, e.lineno);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[aplus-builder] Unhandled Rejection:", e.reason);
  });
}

// ===== 类型 =====

type BuiltinStyle = "auto" | "editorial" | "swiss" | "product-launch" | "xhs-pastel" | "amazon-premium";
type ModelPref = "auto" | "east-asian" | "european" | "middle-eastern";

interface Preferences {
  style: BuiltinStyle;
  odStyle: string;
  model: ModelPref;
}

interface SavedState {
  queueItems?: QueueItem[];
  preferences?: Preferences;
  generating?: boolean;
}

type TaskImage = { name: string; base64: string; mime: string };
type TaskVariant = { name: string; html: string };

interface QueueItem {
  id: string;
  image: string | null;
  imageFile: File | null;
  modelImage: string | null;
  modelImageFile: File | null;
  logoImage: string | null;
  logoImageFile: File | null;
  description: string;
  productName: string;
  taskId?: string;
  status: "idle" | "queued" | "running" | "done" | "error";
  html?: string;
  images?: TaskImage[];
  variants?: TaskVariant[];
  error?: string;
  agentLog?: string;
}

const DEFAULT_PREFS: Preferences = { style: "auto", odStyle: "", model: "auto" };

let _idCounter = 0;
function newId(): string { return `p${Date.now()}_${_idCounter++}`; }

// ===== 积分 =====

const CREDITS_KEY = "aplus-credits";
const FREE_CREDITS = 999;

function loadCredits(): number {
  try { const raw = localStorage.getItem(CREDITS_KEY); return raw !== null ? parseInt(raw) : FREE_CREDITS; }
  catch { return FREE_CREDITS; }
}
function saveCredits(n: number) { localStorage.setItem(CREDITS_KEY, String(n)); }
function useCredit(): number { const c = Math.max(0, loadCredits() - 1); saveCredits(c); return c; }

// ===== 偏好画像 =====

interface PreferenceProfile {
  signal: string;
  pending_signals: string[];
  stats: { total: number };
}

const PROFILE_KEY = "aplus-builder-profile";
const MAX_PENDING = 20;

function loadProfile(): PreferenceProfile {
  try { const raw = localStorage.getItem(PROFILE_KEY); if (raw) return JSON.parse(raw); } catch {}
  return { signal: "", pending_signals: [], stats: { total: 0 } };
}
function saveProfile(p: PreferenceProfile) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {} }
function addSignal(profile: PreferenceProfile, signal: string): PreferenceProfile {
  profile.pending_signals.push(signal);
  profile.stats.total++;
  if (profile.pending_signals.length > MAX_PENDING) {
    profile.signal = profile.pending_signals.slice(-1)[0];
    profile.pending_signals = profile.pending_signals.slice(-10);
  }
  return profile;
}

function getProfileContext(profile: PreferenceProfile): string {
  if (!profile.signal) return "";
  return `整体偏好趋势：${profile.signal}\n（基于 ${profile.stats.total} 次历史生成，仅供参考）`;
}

// ===== 本地持久化 =====

function loadState(): SavedState | null {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveState(state: Partial<SavedState>) {
  try {
    const current = loadState() || {};
    Object.assign(current, state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {}
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

// ===== 常量 =====

const STYLE_OPTIONS: { value: BuiltinStyle; label: string; desc: string; preview: string; className: string }[] = [
  { value: "auto" as BuiltinStyle, label: "🤖 AI 自动", desc: "Agent 智能选择", preview: "🎨", className: "bg-gray-50" },
  { value: "editorial", label: "📰 Editorial", desc: "暖杂志风", preview: "📰", className: "bg-amber-50" },
  { value: "swiss", label: "⬛ Swiss", desc: "瑞士极简", preview: "⬛", className: "bg-gray-100" },
  { value: "product-launch", label: "🚀 产品发布", desc: "暗底Hero", preview: "🚀", className: "bg-slate-800 text-white" },
  { value: "xhs-pastel", label: "🌸 小红书", desc: "马卡龙风", preview: "🌸", className: "bg-pink-50" },
  { value: "amazon-premium", label: "🅰️ Amazon A+", desc: "原生模版", preview: "🅰️", className: "bg-blue-50" },
];

const OD_STYLES = [
  { value: "zhangzara-soft-editorial", label: "ZhangZara 软杂志" },
  { value: "zhangzara-brutalist", label: "ZhangZara 粗野" },
  { value: "nordic-minimal", label: "北欧极简" },
  { value: "japanese-wabi", label: "日式侘寂" },
  { value: "bauhaus-grid", label: "包豪斯网格" },
  { value: "memphis-playful", label: "孟菲斯趣味" },
  { value: "art-deco-luxe", label: "装饰艺术奢华" },
  { value: "brutalist-raw", label: "粗野原生" },
  { value: "glassmorphism-tech", label: "玻璃科技" },
  { value: "neubrutalist-pop", label: "新粗野波普" },
  { value: "dark-mode-luxe", label: "暗黑奢华" },
  { value: "organic-biophilic", label: "有机自然" },
  { value: "retro-vaporwave", label: "复古蒸汽波" },
  { value: "cyber-neon", label: "赛博霓虹" },
];

const MODEL_OPTIONS: { value: ModelPref; label: string; image: string | null }[] = [
  { value: "auto" as ModelPref, label: "✨ 智能", image: null },
  { value: "east-asian", label: "东亚", image: "/models/east-asian.jpg" },
  { value: "european", label: "欧美", image: "/models/european.jpg" },
  { value: "middle-eastern", label: "中东", image: "/models/middle-eastern.jpg" },
];

// ===== 组件 =====

export default function Home() {
  // -- 队列状态 --
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);

  // -- 当前表单（临时状态，不清 localStorage）--
  const [formImage, setFormImage] = useState<string | null>(null);
  const [formImageFile, setFormImageFile] = useState<File | null>(null);
  const [formModelImage, setFormModelImage] = useState<string | null>(null);
  const [formModelImageFile, setFormModelImageFile] = useState<File | null>(null);
  const [formLogoImage, setFormLogoImage] = useState<string | null>(null);
  const [formLogoImageFile, setFormLogoImageFile] = useState<File | null>(null);
  const [formDescription, setFormDescription] = useState("");
  const [formProductName, setFormProductName] = useState("");

  // -- 全局 --
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [showPrefs, setShowPrefs] = useState(false);
  const [credits, setCredits] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [rating, setRating] = useState<"liked" | "disliked" | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelFileRef = useRef<HTMLInputElement>(null);
  const logoFileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueItemsRef = useRef(queueItems);
  queueItemsRef.current = queueItems;
  const historyRef = useRef<HTMLDivElement>(null);
  const savedToHistoryRef = useRef(new Set<string>());

  // 计算值
  const generating = queueItems.some((q) => q.status === "running" || q.status === "queued");
  const runningCount = queueItems.filter((q) => q.status === "running").length;
  const doneCount = queueItems.filter((q) => q.status === "done").length;
  const totalQueued = queueItems.filter((q) => q.status !== "idle").length;
  const activeResult = queueItems.find((q) => q.id === activeResultId && q.status === "done");
  const filteredQueue = queueItems.filter((q) => q.status !== "idle");

  // -- 水合 --
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("new")) {
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem("aplus-taskId");
      setHydrated(true);
      setCredits(loadCredits());
      getHistory().then(setHistoryEntries).catch(() => {});
      setProfileLoaded(loadProfile().stats.total > 0);
      return;
    }

    const saved = loadState();
    if (saved?.queueItems) setQueueItems(saved.queueItems);
    if (saved?.preferences) setPrefs(saved.preferences);
    setCredits(loadCredits());
    getHistory().then(setHistoryEntries).catch(() => {});
    setProfileLoaded(loadProfile().stats.total > 0);
    setHydrated(true);
  }, []);

  useEffect(() => { if (hydrated) saveState({ queueItems, preferences: prefs }); }, [queueItems, prefs, hydrated]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // -- 表单 handlers --
  const handleImageUpload = useCallback((file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    setFormImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setFormImage(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleModelImageUpload = useCallback((file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    setFormModelImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setFormModelImage(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleLogoUpload = useCallback((file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    setFormLogoImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setFormLogoImage(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  const resetForm = () => {
    setFormImage(null); setFormImageFile(null);
    setFormModelImage(null); setFormModelImageFile(null);
    setFormLogoImage(null); setFormLogoImageFile(null);
    setFormDescription(""); setFormProductName("");
  };

  // -- 加入队列 --
  const handleAddToQueue = async () => {
    if (!formImageFile) return;

    const item: QueueItem = {
      id: newId(),
      image: formImage,
      imageFile: formImageFile,
      modelImage: formModelImage,
      modelImageFile: formModelImageFile,
      logoImage: formLogoImage,
      logoImageFile: formLogoImageFile,
      description: formDescription,
      productName: formProductName,
      status: "idle",
    };

    setQueueItems((prev) => [...prev, item]);
    resetForm();

    // 立刻发起 POST
    try {
      const formData = new FormData();
      formData.append("image_0", item.imageFile!);
      if (item.modelImageFile) formData.append("model_image_0", item.modelImageFile);
      if (item.logoImageFile) formData.append("logo_image_0", item.logoImageFile);
      formData.append("description", item.description);
      formData.append("product_name", item.productName);
      formData.append("preferences", JSON.stringify(prefs));

      const profile = loadProfile();
      if (profile.stats.total > 0) {
        const ctx = getProfileContext(profile);
        if (ctx) formData.append("profile_context", ctx);
      }

      const res = await fetch("/api/generate", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "启动失败");

      useCredit();
      setCredits(loadCredits());

      setQueueItems((prev) =>
        prev.map((qi) =>
          qi.id === item.id
            ? { ...qi, taskId: data.taskId, status: data.queued ? "queued" : "running" }
            : qi
        )
      );
    } catch (e) {
      setQueueItems((prev) =>
        prev.map((qi) =>
          qi.id === item.id ? { ...qi, status: "error", error: e instanceof Error ? e.message : "启动失败" } : qi
        )
      );
    }
  };

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
  const downloadDataUrl = (base64: string, mime: string, filename: string) => {
    const a = document.createElement("a");
    a.href = `data:${mime};base64,${base64}`; a.download = filename; a.click();
  };

  const handleDownloadHtml = () => {
    if (!activeResult) return;
    const html = activeResult.variants?.length ? activeResult.html : activeResult.html;
    const blob = new Blob([html!], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "aplus-detail.html"; a.click();
    URL.revokeObjectURL(url);
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

  // -- 历史 --
  const restoreHistory = async (entry: HistoryEntry) => {
    const data = await loadOutput(entry.dirName);
    if (!data) return;
    const id = `hist_${entry.dirName}`;
    const exists = queueItems.find((q) => q.id === id && q.status === "done");
    if (exists) { setActiveResultId(id); return; }

    const item: QueueItem = {
      id,
      image: null, imageFile: null,
      modelImage: null, modelImageFile: null,
      logoImage: null, logoImageFile: null,
      description: "", productName: entry.dirName,
      status: "done",
      html: rewriteImagePaths(data.html, entry.dirName),
      images: data.images.map((img: any) => ({ name: img.name, base64: img.base64, mime: img.mime })),
      variants: data.variants?.map((v: any) => ({ name: v.name, html: rewriteImagePaths(v.html, entry.dirName) })),
    };
    setQueueItems((prev) => [...prev, item]);
    setActiveResultId(id);
    setShowHistory(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const deleteHistory = async (dirName: string) => {
    setHistoryEntries((prev) => prev.filter((e) => e.dirName !== dirName));
  };

  // -- 响应式 HTML --
  const responsiveHtml = useMemo(() => {
    if (!activeResult) return "";
    const raw = activeResult.html || "";
    if (!raw) return "";
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

  const canAddMore = formImageFile != null && !generating;

  // ========== 渲染 ==========

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-3 sm:px-4 h-12 sm:h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button onClick={() => window.location.href = "/"} className="text-text-muted hover:text-brand text-xs sm:text-sm flex-shrink-0">←</button>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight flex items-center gap-1.5 sm:gap-2 truncate">
              <span className="hidden sm:inline">A+ 详情生成</span>
              <span className="text-xs font-normal text-text-muted bg-gray-100 px-1.5 sm:px-2 py-0.5 rounded truncate">批量</span>
              {profileLoaded && (
                <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded">🧠 学习中</span>
              )}
            </h1>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
            <span className={`text-[10px] sm:text-xs font-medium ${credits <= 2 ? "text-red-500" : credits <= 5 ? "text-orange-500" : "text-text-muted"}`}>{credits}积分</span>
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
                {doneCount}/{totalQueued} 完成
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

        {/* ===== 结果预览 ===== */}
        {activeResult ? (
          <div className="space-y-4">
            {/* 队列列表（横向滚动） */}
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
                  <p className="text-sm text-blue-600 mt-0.5">{doneCount}/{totalQueued} 完成 · {runningCount} 并行生成中（约 2-5 分钟/个）</p>
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
        ) : (
          <>
            {/* ===== 上传区 ===== */}
            <div>
              <h2 className="text-base sm:text-lg font-semibold mb-1">产品图片</h2>
              <p className="text-text-muted text-xs sm:text-sm mb-4">上传产品图，可多次添加批量生成</p>
              {formImage ? (
                <div className="relative w-36 sm:w-48 aspect-[3/4] rounded-xl overflow-hidden bg-gray-100 shadow-sm">
                  <img src={formImage} alt="产品图" className="w-full h-full object-cover" />
                  <button onClick={() => { setFormImage(null); setFormImageFile(null); }} className="absolute top-2 right-2 w-7 h-7 bg-black/60 text-white rounded-full flex items-center justify-center text-sm hover:bg-black/80 transition-colors">✕</button>
                </div>
              ) : (
                <div onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleImageUpload(e.dataTransfer.files?.[0] || null); }}
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-border rounded-xl p-8 sm:p-12 text-center cursor-pointer hover:border-brand/30 transition-colors">
                  <div className="text-2xl sm:text-3xl mb-2">📷</div>
                  <p className="text-text-muted text-xs sm:text-sm">拖拽或点击上传产品图</p>
                  <p className="text-text-muted text-[10px] sm:text-xs mt-1">JPG / PNG / WebP</p>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => handleImageUpload(e.target.files?.[0] || null)} />
                </div>
              )}
            </div>

            {/* ===== 模特参考图 ===== */}
            <div>
              <h2 className="text-base sm:text-lg font-semibold mb-1">模特参考图 <span className="text-text-muted text-xs sm:text-sm font-normal ml-2">（可选）</span></h2>
              <p className="text-text-muted text-xs sm:text-sm mb-4">上传模特照片，AI 用虚拟换装把产品穿到指定模特身上。</p>
              {formModelImage ? (
                <div className="relative w-24 sm:w-32 aspect-square rounded-xl overflow-hidden bg-gray-100 shadow-sm">
                  <img src={formModelImage} alt="模特参考图" className="w-full h-full object-cover" />
                  <button onClick={() => { setFormModelImage(null); setFormModelImageFile(null); }} className="absolute top-1.5 right-1.5 w-6 h-6 bg-black/60 text-white rounded-full flex items-center justify-center text-xs hover:bg-black/80 transition-colors">✕</button>
                </div>
              ) : (
                <div onClick={() => modelFileRef.current?.click()}
                  className="border-2 border-dashed border-border rounded-xl p-4 sm:p-6 text-center cursor-pointer hover:border-brand/30 transition-colors max-w-xs">
                  <div className="text-xl mb-1">🧑</div>
                  <p className="text-text-muted text-xs">点击上传模特图</p>
                  <input ref={modelFileRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => handleModelImageUpload(e.target.files?.[0] || null)} />
                </div>
              )}
            </div>

            {/* ===== Logo ===== */}
            <div>
              <h2 className="text-base sm:text-lg font-semibold mb-1">品牌 Logo <span className="text-text-muted text-xs sm:text-sm font-normal ml-2">（可选）</span></h2>
              {formLogoImage ? (
                <div className="relative w-28 sm:w-36 h-16 sm:h-20 rounded-xl overflow-hidden bg-gray-100 shadow-sm flex items-center justify-center">
                  <img src={formLogoImage} alt="Logo" className="max-w-full max-h-full object-contain p-2" />
                  <button onClick={() => { setFormLogoImage(null); setFormLogoImageFile(null); }} className="absolute top-1 right-1 w-5 h-5 bg-black/60 text-white rounded-full flex items-center justify-center text-xs hover:bg-black/80 transition-colors">✕</button>
                </div>
              ) : (
                <div onClick={() => logoFileRef.current?.click()}
                  className="border-2 border-dashed border-border rounded-xl p-3 sm:p-4 text-center cursor-pointer hover:border-brand/30 transition-colors max-w-xs">
                  <div className="text-lg mb-1">🏷️</div>
                  <p className="text-text-muted text-xs">点击上传品牌 Logo</p>
                  <input ref={logoFileRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => handleLogoUpload(e.target.files?.[0] || null)} />
                </div>
              )}
            </div>

            {/* ===== 产品名称 ===== */}
            <div>
              <h2 className="text-base sm:text-lg font-semibold mb-1">产品名称 <span className="text-text-muted text-xs sm:text-sm font-normal ml-2">（可选）</span></h2>
              <input type="text" value={formProductName} onChange={(e) => setFormProductName(e.target.value)}
                placeholder="例如：法式复古连衣裙"
                className="w-full max-w-sm px-4 py-2.5 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand" />
            </div>

            {/* ===== 描述 ===== */}
            <div>
              <h2 className="text-base sm:text-lg font-semibold mb-1">产品描述 <span className="text-text-muted text-xs sm:text-sm font-normal ml-2">（可选）</span></h2>
              <textarea value={formDescription} onChange={(e) => setFormDescription(e.target.value)}
                placeholder="例如：法式复古连衣裙，高支棉质面料，方领设计…"
                rows={3}
                className="w-full px-4 py-3 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand resize-none" />
            </div>

            {/* ===== 偏好 ===== */}
            <div>
              <button onClick={() => setShowPrefs(!showPrefs)}
                className="text-sm text-text-muted hover:text-brand flex items-center gap-1.5">
                <span className="text-base">{showPrefs ? "▾" : "▸"}</span>偏好设置
                {(prefs.style !== "auto" || prefs.odStyle || prefs.model !== "auto") && (
                  <span className="ml-2 px-1.5 py-0.5 bg-brand/10 text-brand text-[11px] rounded font-medium">已自定义</span>
                )}
              </button>
              {showPrefs && (
                <div className="mt-4 space-y-5 p-5 bg-gray-50 rounded-xl">
                  <div>
                    <label className="block text-sm font-medium mb-3">排版风格</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
                      {STYLE_OPTIONS.map((opt) => (
                        <button key={opt.value}
                          onClick={() => setPrefs({ ...prefs, style: opt.value, odStyle: "" })}
                          className={`relative p-3 rounded-xl text-left transition-all ${
                            prefs.style === opt.value && !prefs.odStyle ? "ring-2 ring-brand ring-offset-1" : "hover:ring-1 hover:ring-gray-300"
                          } ${opt.className}`}>
                          <div className="mb-2">{opt.preview}</div>
                          <p className="text-xs font-semibold">{opt.label}</p>
                          <p className="text-[10px] text-text-muted mt-0.5">{opt.desc}</p>
                        </button>
                      ))}
                    </div>
                    <details className="mt-3">
                      <summary className="text-xs text-text-muted cursor-pointer hover:text-brand py-1">+ 更多 Open Design 风格</summary>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {OD_STYLES.map((od) => (
                          <button key={od.value}
                            onClick={() => setPrefs({ ...prefs, odStyle: prefs.odStyle === od.value ? "" : od.value, style: prefs.odStyle === od.value ? prefs.style : "auto" })}
                            className={`px-2.5 py-1 rounded-md text-[11px] transition-all ${
                              prefs.odStyle === od.value ? "bg-brand text-white font-medium" : "bg-white border border-border text-text-muted hover:border-brand/30 hover:text-text"
                            }`}>{od.label}</button>
                        ))}
                      </div>
                    </details>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-3">模特偏好</label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                      {MODEL_OPTIONS.map((opt) => (
                        <button key={opt.value} onClick={() => setPrefs({ ...prefs, model: opt.value })}
                          className={`relative rounded-xl overflow-hidden transition-all ${
                            prefs.model === opt.value ? "ring-2 ring-brand ring-offset-1" : "hover:ring-1 hover:ring-gray-300"
                          }`}>
                          <div className="aspect-[3/4] bg-gray-100 flex items-center justify-center overflow-hidden">
                            {opt.value === "auto" ? <div className="text-2xl">✨</div> :
                              opt.image ? <img src={opt.image} alt={opt.label} className="w-full h-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} /> : null}
                          </div>
                          <div className="p-2 bg-white"><p className="text-[11px] font-semibold text-center">{opt.label}</p></div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ===== 按钮区 ===== */}
            <div className="flex gap-2">
              <button onClick={handleAddToQueue} disabled={!canAddMore}
                className="flex-1 py-3 bg-brand text-white rounded-xl text-base font-medium hover:bg-brand-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                ➕ 加入生成队列
              </button>
            </div>

            {filteredQueue.length > 0 && (
              <p className="text-xs text-text-muted text-center">
                已添加 {filteredQueue.length} 个产品 · {doneCount} 已完成
              </p>
            )}
          </>
        )}

        {/* ===== 历史 ===== */}
        {historyEntries.length > 0 && (
          <button onClick={() => { setShowHistory(!showHistory); if (!showHistory) setTimeout(() => historyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
            className="w-full py-3 border-2 border-dashed border-border rounded-xl text-text-muted hover:text-brand hover:border-brand/30 transition-colors flex items-center justify-center gap-2 text-sm font-medium">
            📋 历史记录（{historyEntries.length}）
          </button>
        )}

        {showHistory && historyEntries.length > 0 && (
          <div ref={historyRef} className="border-t border-border pt-6 mt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base sm:text-lg font-semibold">历史记录</h2>
              <button onClick={() => setShowHistory(false)} className="text-xs text-text-muted hover:text-brand">关闭</button>
            </div>
            <div className="space-y-2 sm:space-y-3">
              {historyEntries.map((entry) => (
                <div key={entry.dirName} className="flex items-center gap-2 sm:gap-3 p-2 sm:p-3 bg-white border border-border rounded-xl hover:shadow-sm transition-shadow group">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-lg bg-gray-100 overflow-hidden flex-shrink-0">
                    <img src={`/api/output/${encodeURIComponent(entry.dirName)}/screenshot.png`} alt="" className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLElement).style.display = "none"; (e.target as HTMLElement).nextElementSibling?.classList.remove("hidden"); }} />
                    <div className="w-full h-full items-center justify-center text-lg hidden">📄</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{entry.dirName}</p>
                    <p className="text-xs text-text-muted mt-0.5">{formatTime(entry.timestamp)} · {entry.imageCount} 张图{entry.variantNames.length > 0 && ` · ${entry.variantNames.length} 变体`}</p>
                  </div>
                  <div className="flex gap-1 sm:gap-1.5 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                    <button onClick={() => restoreHistory(entry)} className="px-2 py-1 text-[11px] bg-brand text-white rounded hover:bg-brand-hover transition-colors">恢复</button>
                    <button onClick={() => deleteHistory(entry.dirName)} className="px-2 py-1 text-[11px] border border-border rounded hover:bg-red-50 hover:border-red-200 text-text-muted hover:text-red-500 transition-colors">删除</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
