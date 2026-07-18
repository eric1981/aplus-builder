"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import JSZip from "jszip";

const STORAGE_KEY = "aplus-builder-state";
const POLL_INTERVAL = 3000;
const HISTORY_KEY = "aplus-builder-history";
const MAX_HISTORY = 5; // 保留最近 5 条记录

// ===== 类型 =====

type BuiltinStyle = "auto" | "editorial" | "swiss" | "product-launch" | "xhs-pastel" | "amazon-premium";
type ModelPref = "auto" | "east-asian" | "european" | "middle-eastern";
type ViewMode = "new" | "history";

interface Preferences {
  style: BuiltinStyle;
  odStyle: string;
  model: ModelPref;
}

interface SavedState {
  description?: string;
  generatedHtml?: string;
  preferences?: Preferences;
}

type TaskImage = { name: string; base64: string; mime: string };

interface HistoryEntry {
  id: string;
  timestamp: number;
  description: string;
  html: string;       // 带 base64 的完整 HTML
  images: TaskImage[];
  thumbnail?: string;  // 第一个生成图的 base64 data URL
}

interface PreferenceProfile {
  signal: string;
  pending_signals: string[];
  stats: { total: number };
}

// ===== 偏好 =====

const DEFAULT_PREFS: Preferences = { style: "auto", odStyle: "", model: "auto" };

const PROFILE_KEY = "aplus-builder-profile";
const MAX_PENDING = 20;

function loadProfile(): PreferenceProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { signal: "", pending_signals: [], stats: { total: 0 } };
}

function saveProfile(p: PreferenceProfile) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {}
}

function addSignal(profile: PreferenceProfile, signal: string): PreferenceProfile {
  profile.pending_signals.push(signal);
  profile.stats.total++;
  if (profile.pending_signals.length > MAX_PENDING) {
    const recent = profile.pending_signals.slice(-10);
    profile.signal = recent[recent.length - 1];
    profile.pending_signals = recent;
  }
  return profile;
}

function getProfileContext(profile: PreferenceProfile): string {
  const parts: string[] = [];
  if (profile.signal) parts.push(`画像: ${profile.signal}`);
  if (profile.pending_signals.length > 0) {
    parts.push(`最近: ${profile.pending_signals.slice(-3).join(" | ")}`);
  }
  return parts.join("\n");
}

// ===== 历史 =====

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(entries: HistoryEntry[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries)); } catch {}
}

function addToHistory(entry: HistoryEntry): HistoryEntry[] {
  const history = loadHistory();
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  saveHistory(history);
  return history;
}

// ===== 本地存储 =====

function loadState(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveState(state: Partial<SavedState>) {
  try {
    const existing = loadState() || {};
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, ...state }));
  } catch {}
}

// ===== 风格 & 模特选项 =====

const STYLE_OPTIONS: { value: BuiltinStyle; label: string; desc: string; preview: React.ReactNode; className: string }[] = [
  { value: "auto", label: "AI 决定", desc: "根据品类自动选", className: "bg-gradient-to-br from-gray-100 to-gray-200",
    preview: <div className="flex gap-1"><div className="w-5 h-3 rounded-sm bg-white/60" /><div className="w-5 h-3 rounded-sm bg-gray-300/60" /></div> },
  { value: "editorial", label: "Editorial 暖杂志", desc: "衬线体 · 圆角卡 · 暖白底", className: "bg-[#FBFBFA]",
    preview: <div className="space-y-1"><div className="h-1 w-6 rounded-full bg-[#E8E8E5]" /><div className="h-0.5 w-4 rounded-full bg-[#E8E8E5]" /><div className="h-1 w-5 rounded-full bg-[#D4A0A0]" /></div> },
  { value: "swiss", label: "Swiss 瑞士风", desc: "无衬线 · 全直角 · 黑白灰", className: "bg-white",
    preview: <div className="space-y-1"><div className="h-1 w-7 bg-[#111]" /><div className="h-px w-5 bg-[#888]" /><div className="h-1 w-4 bg-[#111]" /></div> },
  { value: "product-launch", label: "Product Launch", desc: "暗底Hero · 暖橙渐变", className: "bg-[#1A1A1A] text-white/90",
    preview: <div className="space-y-1"><div className="h-0.5 w-6 bg-[#F97316]/60" /><div className="h-1 w-4 bg-[#F97316]/40 rounded-sm" /><div className="h-0.5 w-5 bg-[#F97316]/30" /></div> },
  { value: "xhs-pastel", label: "小红书 Pastel", desc: "圆角 · 马卡龙 · 种草风", className: "bg-gradient-to-br from-[#FFF0F5] to-[#F0E6FF]",
    preview: <div className="flex gap-1"><div className="w-3 h-3 rounded-full bg-[#FFB6C1]/60" /><div className="w-3 h-3 rounded-full bg-[#DDA0DD]/50" /><div className="w-3 h-3 rounded-full bg-[#B0E0E6]/50" /></div> },
  { value: "amazon-premium", label: "Amazon Premium", desc: "全出血 · 文字蒙层", className: "bg-white",
    preview: <div className="w-full space-y-0.5"><div className="h-1.5 w-full bg-[#E8E8E5]" /><div className="flex gap-0.5"><div className="h-1 w-3 bg-[#111]/20" /><div className="h-1 w-2 bg-[#111]/10" /></div></div> },
];

const OD_STYLES = [
  { value: "zhangzara-editorial-tri-tone", label: "Zhangzara Editorial" },
  { value: "soft-editorial", label: "Soft Editorial" }, { value: "bold-poster", label: "Bold Poster" },
  { value: "capsule", label: "Capsule" }, { value: "coral", label: "Coral" },
  { value: "pink-script", label: "Pink Script" }, { value: "studio", label: "Studio" },
  { value: "sakura-chroma", label: "Sakura Chroma" }, { value: "xhs-white-editorial", label: "XHS White Editorial" },
  { value: "monochrome", label: "Monochrome" }, { value: "brutalist", label: "Brutalist" },
];

const MODEL_OPTIONS: { value: ModelPref; label: string; image?: string }[] = [
  { value: "auto", label: "AI 决定" },
  { value: "east-asian", label: "东亚", image: "https://images.pexels.com/photos/36210958/pexels-photo-36210958.jpeg?auto=compress&cs=tinysrgb&h=400" },
  { value: "european", label: "欧美", image: "https://images.pexels.com/photos/4013692/pexels-photo-4013692.jpeg?auto=compress&cs=tinysrgb&h=400" },
  { value: "middle-eastern", label: "中东/混血", image: "https://images.pexels.com/photos/29386531/pexels-photo-29386531.jpeg?auto=compress&cs=tinysrgb&h=400" },
];

// ===== 错误分类 =====

type ErrorKind = "timeout" | "network" | "agent_failed" | "unknown";

function classifyError(msg: string): ErrorKind {
  const m = msg.toLowerCase();
  if (m.includes("timeout") || m.includes("超时")) return "timeout";
  if (m.includes("fetch") || m.includes("network") || m.includes("econnrefused")) return "network";
  if (m.includes("agent") || m.includes("未产出")) return "agent_failed";
  return "unknown";
}

function errorAdvice(kind: ErrorKind): string {
  switch (kind) {
    case "timeout": return "Agent 处理超时。火山生图可能较慢，可以重试一次。";
    case "network": return "网络连接异常，检查网络后重试。";
    case "agent_failed": return "Agent 未能完成生成，可能是生图 API 临时不可用。请重试。";
    default: return "未知错误，请重试或联系支持。";
  }
}

// ===== UI =====

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export default function Home() {
  const [image, setImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedHtml, setGeneratedHtml] = useState("");
  const [images, setImages] = useState<TaskImage[]>([]);
  const [error, setError] = useState("");
  const [errorKind, setErrorKind] = useState<ErrorKind>("unknown");
  const [agentLog, setAgentLog] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [showPrefs, setShowPrefs] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("new");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 客户端水合
  useEffect(() => {
    const saved = loadState();
    if (saved?.description) setDescription(saved.description);
    if (saved?.generatedHtml) setGeneratedHtml(saved.generatedHtml);
    if (saved?.preferences) setPrefs(saved.preferences);
    setHistory(loadHistory());
    setHydrated(true);
  }, []);

  useEffect(() => { if (hydrated) saveState({ description }); }, [description, hydrated]);
  useEffect(() => { if (hydrated && generatedHtml) saveState({ generatedHtml }); }, [generatedHtml, hydrated]);
  useEffect(() => { if (hydrated) saveState({ preferences: prefs }); }, [prefs, hydrated]);
  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  // ========== 图片上传 ==========

  const handleImageUpload = useCallback((file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => { setImage(reader.result as string); setError(""); };
    reader.readAsDataURL(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    handleImageUpload(e.dataTransfer.files?.[0] || null);
  }, [handleImageUpload]);

  const removeImage = () => { setImage(null); setImageFile(null); };

  // ========== 生成 ==========

  const pollTask = (taskId: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/generate?taskId=${taskId}`);
        const task = await res.json();
        if (task.status === "done" && task.html) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setGeneratedHtml(task.html);
          setImages(task.images || []);
          setGenerating(false);
          saveState({ generatedHtml: task.html });

          // 存历史
          const entry: HistoryEntry = {
            id: taskId,
            timestamp: Date.now(),
            description,
            html: task.html,
            images: task.images || [],
            thumbnail: task.images?.[0] ? `data:${task.images[0].mime};base64,${task.images[0].base64}` : undefined,
          };
          const newHistory = addToHistory(entry);
          setHistory(newHistory);

          // 偏好信号
          if (task.preference_signal) {
            saveProfile(addSignal(loadProfile(), task.preference_signal));
          }
        } else if (task.status === "error") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          const msg = task.error || "生成失败";
          setError(msg);
          setErrorKind(classifyError(msg));
          setAgentLog(task.log || "");
          setGenerating(false);
        } else if (task.log) {
          setAgentLog(task.log);
        }
      } catch {
        // 网络错误不中断轮询
      }
    }, POLL_INTERVAL);
  };

  const handleGenerate = async () => {
    if (!imageFile) { setError("请上传产品图片"); setErrorKind("unknown"); return; }
    setGenerating(true); setError(""); setGeneratedHtml(""); setImages([]); setAgentLog("");

    try {
      const formData = new FormData();
      formData.append("image_0", imageFile);
      formData.append("description", description);
      formData.append("preferences", JSON.stringify(prefs));

      const profile = loadProfile();
      if (profile.stats.total > 0) {
        const ctx = getProfileContext(profile);
        if (ctx) formData.append("profile_context", ctx);
      }

      const res = await fetch("/api/generate", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "启动失败");
      if (data.taskId) { pollTask(data.taskId); }
      else { throw new Error("未获取到任务 ID"); }
    } catch (e: any) {
      setError(e.message || "启动失败");
      setErrorKind("network");
      setGenerating(false);
    }
  };

  // ========== 下载 ==========

  const handleDownloadHtml = (html?: string) => {
    const content = html || generatedHtml;
    const blob = new Blob([content], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "aplus-detail.html"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadAll = async (html?: string, imgs?: TaskImage[]) => {
    const content = html || generatedHtml;
    const imgSet = imgs || images;
    const zip = new JSZip();
    zip.file("aplus-detail.html", content);
    for (const img of imgSet) zip.file(img.name, img.base64, { base64: true });
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "aplus-detail.zip"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleReset = () => {
    setImage(null); setImageFile(null); setGeneratedHtml(""); setImages([]);
    setDescription(""); setError(""); setAgentLog("");
    setViewMode("new");
    localStorage.removeItem(STORAGE_KEY);
  };

  // 从历史加载
  const loadFromHistory = (entry: HistoryEntry) => {
    setGeneratedHtml(entry.html);
    setImages(entry.images);
    setDescription(entry.description);
    setImage(null); setImageFile(null);
    setError(""); setAgentLog("");
  };

  // ========== 渲染 ==========

  const historyCount = history.length;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            Amazon A+ 详情生成器
            <span className="text-xs font-normal text-text-muted bg-gray-100 px-2 py-0.5 rounded">Duma Agent</span>
          </h1>
          {/* 标签栏 */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            <button onClick={() => { setViewMode("new"); setGeneratedHtml(""); }}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${viewMode === "new" ? "bg-white shadow-sm text-text" : "text-text-muted hover:text-text"}`}>
              新建
            </button>
            <button onClick={() => { setViewMode("history"); setGeneratedHtml(""); }}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${viewMode === "history" ? "bg-white shadow-sm text-text" : "text-text-muted hover:text-text"}`}>
              历史{historyCount > 0 && <span className="ml-1 text-[10px]">{historyCount}</span>}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        {/* ===== 历史列表视图 ===== */}
        {viewMode === "history" && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">生成历史</h2>
            {history.length === 0 ? (
              <p className="text-text-muted text-sm py-8 text-center">还没有生成记录</p>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {history.map((entry) => (
                  <button key={entry.id}
                    onClick={() => { loadFromHistory(entry); setViewMode("new"); }}
                    className="text-left border border-border rounded-xl overflow-hidden hover:ring-2 hover:ring-brand/20 transition-all bg-white">
                    {entry.thumbnail ? (
                      <img src={entry.thumbnail} alt="" className="w-full aspect-[4/3] object-cover bg-gray-100" />
                    ) : (
                      <div className="w-full aspect-[4/3] bg-gray-100 flex items-center justify-center text-3xl">📄</div>
                    )}
                    <div className="p-3">
                      <p className="text-xs text-text-muted">{formatDate(entry.timestamp)}</p>
                      <p className="text-sm mt-1 line-clamp-2">{entry.description || "（无描述）"}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ===== 结果预览 ===== */}
        {viewMode === "new" && generatedHtml ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">A+ 详情预览</h2>
                <p className="text-text-muted text-sm">{Math.round(generatedHtml.length / 1024)}KB · {images.length} 张图</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleDownloadHtml()} className="px-3 py-1.5 border border-border rounded-lg text-xs font-medium hover:bg-gray-50 transition-colors">⬇ HTML</button>
                {images.length > 0 && (
                  <button onClick={() => handleDownloadAll()} className="px-3 py-1.5 bg-brand text-white rounded-lg text-xs font-medium hover:bg-brand-hover transition-colors">⬇ 全部 (.zip)</button>
                )}
              </div>
            </div>
            <div className="border border-border rounded-xl overflow-hidden bg-white shadow-sm">
              <iframe srcDoc={generatedHtml} className="w-full" style={{ height: "70vh", border: "none" }} title="预览" />
            </div>
            {images.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-text-muted">生成图片（{images.length} 张，点击下载）</h3>
                <div className="grid grid-cols-3 gap-3">
                  {images.map((img) => (
                    <div key={img.name}
                      onClick={() => {
                        const a = document.createElement("a");
                        a.href = `data:${img.mime};base64,${img.base64}`;
                        a.download = img.name; a.click();
                      }}
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
        ) : viewMode === "new" && generating ? (
          <div className="space-y-6">
            <div className="flex items-center gap-3 p-6 bg-blue-50 border border-blue-200 rounded-xl">
              <span className="w-5 h-5 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
              <div>
                <p className="font-medium text-blue-800">Agent 正在工作中…</p>
                <p className="text-sm text-blue-600 mt-0.5">提取产品特征 → 生成场景图 → 排版 A+ 详情页（约 2-5 分钟）</p>
              </div>
            </div>
            {agentLog && (
              <details className="bg-gray-50 rounded-xl border border-border overflow-hidden">
                <summary className="px-4 py-2 text-sm text-text-muted cursor-pointer hover:text-text">Agent 实时日志</summary>
                <pre className="px-4 py-3 text-xs text-text-muted whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">{agentLog}</pre>
              </details>
            )}
          </div>
        ) : viewMode === "new" ? (
          <>
            {/* ===== 上传区 ===== */}
            <div>
              <h2 className="text-lg font-semibold mb-1">产品图片</h2>
              <p className="text-text-muted text-sm mb-4">上传一张白底产品图，Agent 自动分析特征 → 生成多场景图 → 输出 A+ 详情页</p>
              {image ? (
                <div className="relative w-48 aspect-[3/4] rounded-xl overflow-hidden bg-gray-100 shadow-sm">
                  <img src={image} alt="产品图" className="w-full h-full object-cover" />
                  <button onClick={removeImage} className="absolute top-2 right-2 w-7 h-7 bg-black/60 text-white rounded-full flex items-center justify-center text-sm hover:bg-black/80 transition-colors">✕</button>
                </div>
              ) : (
                <div onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }} onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-border rounded-xl p-12 text-center cursor-pointer hover:border-brand/30 transition-colors">
                  <div className="text-3xl mb-2">📷</div>
                  <p className="text-text-muted text-sm">拖拽或点击上传产品图</p>
                  <p className="text-text-muted text-xs mt-1">JPG / PNG / WebP</p>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => handleImageUpload(e.target.files?.[0] || null)} />
                </div>
              )}
            </div>

            {/* ===== 描述区 ===== */}
            <div>
              <h2 className="text-lg font-semibold mb-1">产品描述 <span className="text-text-muted text-sm font-normal ml-2">（可选）</span></h2>
              <p className="text-text-muted text-sm mb-4">不填也行，Agent 会根据图片自动分析。</p>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="例如：法式复古连衣裙，高支棉质面料，方领设计，收腰A字版型。品牌ÉTINCELLE。"
                rows={3}
                className="w-full px-4 py-3 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand resize-none" />
            </div>

            {/* ===== 偏好设置 ===== */}
            <div>
              <button onClick={() => setShowPrefs(!showPrefs)}
                className="text-sm text-text-muted hover:text-brand flex items-center gap-1.5">
                <span className="text-base">{showPrefs ? "▾" : "▸"}</span> 偏好设置
                {(prefs.style !== "auto" || prefs.odStyle || prefs.model !== "auto") && (
                  <span className="ml-2 px-1.5 py-0.5 bg-brand/10 text-brand text-[11px] rounded font-medium">已自定义</span>
                )}
              </button>
              {showPrefs && (
                <div className="mt-4 space-y-5 p-5 bg-gray-50 rounded-xl">
                  <div>
                    <label className="block text-sm font-medium mb-3">排版风格</label>
                    <div className="grid grid-cols-3 gap-3">
                      {STYLE_OPTIONS.map((opt) => (
                        <button key={opt.value} onClick={() => setPrefs({ ...prefs, style: opt.value, odStyle: "" })}
                          className={`relative p-3 rounded-xl text-left transition-all ${prefs.style === opt.value && !prefs.odStyle ? "ring-2 ring-brand ring-offset-1" : "hover:ring-1 hover:ring-gray-300"} ${opt.className}`}>
                          <div className="mb-2">{opt.preview}</div>
                          <p className="text-xs font-semibold">{opt.label}</p>
                          <p className="text-[10px] text-text-muted mt-0.5">{opt.desc}</p>
                        </button>
                      ))}
                    </div>
                    <details className="mt-3">
                      <summary className="text-xs text-text-muted cursor-pointer hover:text-brand py-1">+ 更多 Open Design 风格（14 种）</summary>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {OD_STYLES.map((od) => (
                          <button key={od.value}
                            onClick={() => setPrefs({ ...prefs, odStyle: prefs.odStyle === od.value ? "" : od.value, style: prefs.odStyle === od.value ? prefs.style : "auto" })}
                            className={`px-2.5 py-1 rounded-md text-[11px] transition-all ${prefs.odStyle === od.value ? "bg-brand text-white font-medium" : "bg-white border border-border text-text-muted hover:border-brand/30 hover:text-text"}`}>
                            {od.label}
                          </button>
                        ))}
                      </div>
                    </details>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-3">模特偏好</label>
                    <div className="grid grid-cols-4 gap-3">
                      {MODEL_OPTIONS.map((opt) => (
                        <button key={opt.value} onClick={() => setPrefs({ ...prefs, model: opt.value })}
                          className={`relative rounded-xl overflow-hidden transition-all ${prefs.model === opt.value ? "ring-2 ring-brand ring-offset-1" : "hover:ring-1 hover:ring-gray-300"}`}>
                          <div className="aspect-[3/4] bg-gray-100 flex items-center justify-center overflow-hidden">
                            {opt.value === "auto" ? <div className="text-2xl">✨</div> :
                              opt.image ? <img src={opt.image} alt={opt.label} className="w-full h-full object-cover" loading="lazy" /> : null}
                          </div>
                          <div className="p-2 bg-white"><p className="text-[11px] font-semibold text-center">{opt.label}</p></div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ===== 错误 + 重试 ===== */}
            {error && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-xl space-y-3">
                <div>
                  <p className="text-sm font-medium text-red-800">生成失败</p>
                  <p className="text-sm text-red-700 mt-1">{error}</p>
                  <p className="text-xs text-red-600 mt-1">{errorAdvice(errorKind)}</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={handleGenerate}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors">
                    重试
                  </button>
                  <button onClick={() => setError("")}
                    className="px-4 py-2 border border-red-200 text-red-700 rounded-lg text-sm hover:bg-red-50 transition-colors">
                    关闭
                  </button>
                </div>
                {agentLog && (
                  <details className="bg-red-100/50 rounded-lg overflow-hidden">
                    <summary className="px-3 py-1.5 text-xs text-red-600 cursor-pointer">Agent 日志</summary>
                    <pre className="px-3 py-2 text-xs text-red-500 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">{agentLog}</pre>
                  </details>
                )}
              </div>
            )}

            {/* 生成按钮 */}
            <button onClick={handleGenerate} disabled={generating}
              className="w-full py-3 bg-brand text-white rounded-xl text-base font-medium hover:bg-brand-hover transition-colors disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-2">
              {generating ? (
                <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Agent 正在生成…</>
              ) : (
                "✨ 生成 A+ 详情"
              )}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
