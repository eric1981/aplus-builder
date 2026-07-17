"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import JSZip from "jszip";

const STORAGE_KEY = "aplus-builder-state";
const POLL_INTERVAL = 3000;

// ===== 类型 =====

type StylePref = "auto" | "editorial" | "swiss";
type ModelPref = "auto" | "east-asian" | "european" | "middle-eastern";

interface Preferences {
  style: StylePref;
  model: ModelPref;
}

interface SavedState {
  description?: string;
  generatedHtml?: string;
  preferences?: Preferences;
}

type TaskImage = { name: string; base64: string; mime: string };

const DEFAULT_PREFS: Preferences = { style: "auto", model: "auto" };

// ===== 偏好选项配置 =====

const STYLE_OPTIONS: { value: StylePref; label: string; desc: string; className: string }[] = [
  { value: "auto", label: "AI 决定", desc: "根据品类自动选", className: "bg-gradient-to-br from-gray-100 to-gray-200" },
  { value: "editorial", label: "暖杂志风", desc: "衬线体 · 圆角 · 暖色调", className: "bg-[#FBFBFA] border-2 border-[#E8E8E5]" },
  { value: "swiss", label: "瑞士风", desc: "无衬线 · 直角 · 黑白灰", className: "bg-white border-2 border-[#111]" },
];

const MODEL_OPTIONS: { value: ModelPref; label: string; skin: string }[] = [
  { value: "auto", label: "AI 决定", skin: "bg-gradient-to-br from-purple-100 via-blue-100 to-pink-100" },
  { value: "east-asian", label: "东亚", skin: "bg-gradient-to-b from-[#F5E6D3] to-[#E8D5C0]" },
  { value: "european", label: "欧美", skin: "bg-gradient-to-b from-[#FDE8D0] to-[#F0C8A0]" },
  { value: "middle-eastern", label: "中东/混血", skin: "bg-gradient-to-b from-[#D4A574] to-[#C4956A]" },
];

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
    const merged = { ...existing, ...state };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {}
}

// ===== UI =====

export default function Home() {
  const [image, setImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedHtml, setGeneratedHtml] = useState("");
  const [images, setImages] = useState<TaskImage[]>([]);
  const [error, setError] = useState("");
  const [agentLog, setAgentLog] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [showPrefs, setShowPrefs] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 客户端水合
  useEffect(() => {
    const saved = loadState();
    if (saved?.description) setDescription(saved.description);
    if (saved?.generatedHtml) setGeneratedHtml(saved.generatedHtml);
    if (saved?.preferences) setPrefs(saved.preferences);
    setHydrated(true);
  }, []);

  useEffect(() => { if (hydrated) saveState({ description }); }, [description, hydrated]);
  useEffect(() => { if (hydrated && generatedHtml) saveState({ generatedHtml }); }, [generatedHtml, hydrated]);
  useEffect(() => { if (hydrated) saveState({ preferences: prefs }); }, [prefs, hydrated]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

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
        } else if (task.status === "error") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setError(task.error || "生成失败");
          setAgentLog(task.log || "");
          setGenerating(false);
        } else if (task.log) {
          setAgentLog(task.log);
        }
      } catch {}
    }, POLL_INTERVAL);
  };

  const handleGenerate = async () => {
    if (!imageFile) { setError("请上传产品图片"); return; }
    setGenerating(true); setError(""); setGeneratedHtml(""); setImages([]); setAgentLog("");

    try {
      const formData = new FormData();
      formData.append("image_0", imageFile);
      formData.append("description", description);
      formData.append("preferences", JSON.stringify(prefs));

      const res = await fetch("/api/generate", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "启动失败");
      if (data.taskId) { pollTask(data.taskId); }
      else { throw new Error("未获取到任务 ID"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "启动失败，请重试");
      setGenerating(false);
    }
  };

  // ========== 下载 ==========

  const downloadDataUrl = (base64: string, mime: string, filename: string) => {
    const a = document.createElement("a");
    a.href = `data:${mime};base64,${base64}`;
    a.download = filename; a.click();
  };

  const handleDownloadHtml = () => {
    const blob = new Blob([generatedHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "aplus-detail.html"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadImage = (img: TaskImage) => downloadDataUrl(img.base64, img.mime, img.name);

  const handleDownloadAll = async () => {
    const zip = new JSZip();
    zip.file("aplus-detail.html", generatedHtml);
    for (const img of images) zip.file(img.name, img.base64, { base64: true });
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "aplus-detail.zip"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleReset = () => {
    setImage(null); setImageFile(null); setGeneratedHtml(""); setImages([]);
    setDescription(""); setError(""); setAgentLog("");
    localStorage.removeItem(STORAGE_KEY);
  };

  // ========== 渲染 ==========

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            Amazon A+ 详情生成器
            <span className="text-xs font-normal text-text-muted bg-gray-100 px-2 py-0.5 rounded">Duma Agent</span>
          </h1>
          {generatedHtml && (
            <button onClick={handleReset} className="text-sm text-text-muted hover:text-brand">新建</button>
          )}
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        {/* ===== 结果预览 ===== */}
        {generatedHtml ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">A+ 详情预览</h2>
                <p className="text-text-muted text-sm">{Math.round(generatedHtml.length / 1024)}KB · {images.length} 张图</p>
              </div>
              <div className="flex gap-2">
                <button onClick={handleDownloadHtml} className="px-3 py-1.5 border border-border rounded-lg text-xs font-medium hover:bg-gray-50 transition-colors">⬇ HTML</button>
                {images.length > 0 && (
                  <button onClick={handleDownloadAll} className="px-3 py-1.5 bg-brand text-white rounded-lg text-xs font-medium hover:bg-brand-hover transition-colors">⬇ 全部 (.zip)</button>
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
                    <div key={img.name} onClick={() => handleDownloadImage(img)}
                      className="group relative aspect-[3/4] rounded-lg overflow-hidden bg-gray-100 border border-border cursor-pointer hover:ring-2 hover:ring-brand/30 transition-all">
                      <img src={`data:${img.mime};base64,${img.base64}`} alt={img.name} className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-end">
                        <div className="w-full p-2 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                          <p className="text-white text-xs truncate">{img.name}</p>
                          <p className="text-white/70 text-[10px]">{Math.round(img.base64.length * 0.75 / 1024)}KB</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : generating ? (
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
        ) : (
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
                <span className="text-base">{showPrefs ? "▾" : "▸"}</span>
                偏好设置
                {(prefs.style !== "auto" || prefs.model !== "auto") && (
                  <span className="ml-2 px-1.5 py-0.5 bg-brand/10 text-brand text-[11px] rounded font-medium">
                    {prefs.style !== "auto" && prefs.model !== "auto" ? "已自定义" : "已修改"}
                  </span>
                )}
              </button>

              {showPrefs && (
                <div className="mt-4 space-y-5 p-5 bg-gray-50 rounded-xl">
                  {/* 风格 */}
                  <div>
                    <label className="block text-sm font-medium mb-3">排版风格</label>
                    <div className="grid grid-cols-3 gap-3">
                      {STYLE_OPTIONS.map((opt) => (
                        <button key={opt.value} onClick={() => setPrefs({ ...prefs, style: opt.value })}
                          className={`relative p-3 rounded-xl text-left transition-all ${
                            prefs.style === opt.value
                              ? "ring-2 ring-brand ring-offset-1"
                              : "hover:ring-1 hover:ring-gray-300"
                          } ${opt.className}`}>
                          {/* 微缩预览 */}
                          {opt.value === "auto" && (
                            <div className="flex items-center gap-1 mb-2">
                              <div className="w-6 h-4 rounded bg-gradient-to-r from-[#FBFBFA] to-white border border-[#E8E8E5]" />
                              <div className="w-6 h-4 rounded bg-white border border-[#111]" />
                            </div>
                          )}
                          {opt.value === "editorial" && (
                            <div className="mb-2 flex flex-col gap-1">
                              <div className="h-1.5 w-3/4 rounded-full bg-[#E8E8E5]" />
                              <div className="h-1 w-1/2 rounded-full bg-[#E8E8E5]" />
                            </div>
                          )}
                          {opt.value === "swiss" && (
                            <div className="mb-2 flex flex-col gap-1">
                              <div className="h-1.5 w-3/4 bg-[#111]" />
                              <div className="h-px w-1/2 bg-[#888]" />
                            </div>
                          )}
                          <p className="text-xs font-semibold">{opt.label}</p>
                          <p className="text-[10px] text-text-muted mt-0.5">{opt.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 模特 */}
                  <div>
                    <label className="block text-sm font-medium mb-3">模特偏好</label>
                    <div className="grid grid-cols-4 gap-3">
                      {MODEL_OPTIONS.map((opt) => (
                        <button key={opt.value} onClick={() => setPrefs({ ...prefs, model: opt.value })}
                          className={`relative rounded-xl overflow-hidden transition-all ${
                            prefs.model === opt.value
                              ? "ring-2 ring-brand ring-offset-1"
                              : "hover:ring-1 hover:ring-gray-300"
                          }`}>
                          {/* 肤色卡片 */}
                          <div className={`aspect-[3/4] ${opt.skin} flex items-center justify-center`}>
                            {opt.value === "auto" && (
                              <div className="text-2xl">✨</div>
                            )}
                            {opt.value !== "auto" && (
                              /* 简笔人物剪影 */
                              <svg viewBox="0 0 40 60" className="w-8 h-12 opacity-60">
                                <ellipse cx="20" cy="14" rx="8" ry="9" fill="rgba(0,0,0,0.15)" />
                                <path d="M8 56V42c0-4 4-8 12-8s12 4 12 8v14" fill="rgba(0,0,0,0.1)" />
                                <rect x="14" y="22" width="4" height="14" rx="2" fill="rgba(0,0,0,0.08)" />
                              </svg>
                            )}
                          </div>
                          <div className="p-2 bg-white">
                            <p className="text-[11px] font-semibold text-center">{opt.label}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="space-y-3">
                <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
                {agentLog && (
                  <details className="bg-gray-50 rounded-xl border border-border overflow-hidden">
                    <summary className="px-4 py-2 text-sm text-text-muted cursor-pointer">Agent 日志（调试用）</summary>
                    <pre className="px-4 py-3 text-xs text-text-muted whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">{agentLog}</pre>
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
        )}
      </div>
    </div>
  );
}
