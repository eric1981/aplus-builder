"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { getHistory } from "../../lib/history";
import { STYLE_OPTIONS, OD_STYLES, MODEL_OPTIONS, type BuiltinStyle, type ModelPref } from "../../lib/preference-constants";

const STORAGE_KEY = "aplus-builder-state";
const CREDITS_KEY = "aplus-credits";
const FREE_CREDITS = 999;

// ===== 类型 =====

interface Preferences {
  style: BuiltinStyle;
  odStyle: string;
  model: ModelPref;
}

interface SavedState {
  queueItems?: any[];
  preferences?: Preferences;
}

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
}

interface CustomerInfo {
  id: string;
  name: string;
  logo?: string;
  modelRef?: string;
  sizeChartCsv?: string;
  requirements?: string;
  defaultStyle?: string;
  defaultModel?: string;
  customTemplateId?: string;
}

let _idCounter = 0;
function newId(): string { return `p${Date.now()}_${_idCounter++}`; }

// ===== 积分 =====

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

function loadProfile(): PreferenceProfile {
  try { const raw = localStorage.getItem(PROFILE_KEY); if (raw) return JSON.parse(raw); } catch {}
  return { signal: "", pending_signals: [], stats: { total: 0 } };
}
function getProfileContext(profile: PreferenceProfile): string {
  if (!profile.signal) return "";
  return `整体偏好趋势：${profile.signal}\n（基于 ${profile.stats.total} 次历史生成，仅供参考）`;
}

// ===== 本地持久化（只存元数据）=====

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

// ===== 常量 =====

const DEFAULT_PREFS: Preferences = { style: "auto", odStyle: "", model: "auto" };

export default function BuildPage() {
  // -- 表单状态 --
  const [formImage, setFormImage] = useState<string | null>(null);
  const [formImageFile, setFormImageFile] = useState<File | null>(null);
  const [formModelImage, setFormModelImage] = useState<string | null>(null);
  const [formModelImageFile, setFormModelImageFile] = useState<File | null>(null);
  const [formLogoImage, setFormLogoImage] = useState<string | null>(null);
  const [formLogoImageFile, setFormLogoImageFile] = useState<File | null>(null);
  const [formDescription, setFormDescription] = useState("");
  const [formProductName, setFormProductName] = useState("");
  const [formCategory, setFormCategory] = useState("");

  // -- 队列（轻量，不轮询）--
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);

  // -- 全局 --
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [showPrefs, setShowPrefs] = useState(false);
  const [generationMode, setGenerationMode] = useState<"detail" | "single">("detail");
  const [credits, setCredits] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);

  // -- 客户 --
  const [customers, setCustomers] = useState<CustomerInfo[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelFileRef = useRef<HTMLInputElement>(null);
  const logoFileRef = useRef<HTMLInputElement>(null);

  // 计算
  const runningCount = queueItems.filter((q) => q.status === "running" || q.status === "queued").length;
  const canAddMore = formImageFile != null && runningCount < 5;

  // -- 水合 --
  useEffect(() => {
    const saved = loadState();
    if (saved?.queueItems) setQueueItems(saved.queueItems as QueueItem[]);
    if (saved?.preferences) setPrefs(saved.preferences);
    setCredits(loadCredits());
    setProfileLoaded(loadProfile().stats.total > 0);
    setHydrated(true);
  }, []);

  useEffect(() => { if (hydrated) saveState({ queueItems, preferences: prefs }); }, [queueItems, prefs, hydrated]);

  // -- 加载客户列表 --
  useEffect(() => {
    fetch("/api/customers").then((r) => r.json()).then(setCustomers).catch(() => {});
  }, []);

  // -- 选中客户时自动加载资产 + 偏好 --
  useEffect(() => {
    if (!selectedCustomerId) return;
    const c = customers.find((x) => x.id === selectedCustomerId);
    if (!c) return;
    if (c.logo) {
      fetch(`/api/customers/assets?id=${c.id}&type=logo`)
        .then((r) => r.json()).then((d) => { if (d.dataUrl) setFormLogoImage(d.dataUrl); }).catch(() => {});
    }
    if (c.modelRef) {
      fetch(`/api/customers/assets?id=${c.id}&type=model-ref`)
        .then((r) => r.json()).then((d) => { if (d.dataUrl) setFormModelImage(d.dataUrl); }).catch(() => {});
    }
    if (c.defaultStyle || c.defaultModel) {
      setPrefs((p) => ({
        ...p,
        style: (c.defaultStyle as BuiltinStyle) || p.style,
        model: (c.defaultModel as ModelPref) || p.model,
      }));
    }
  }, [selectedCustomerId, customers]);

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
    setFormDescription(""); setFormProductName(""); setFormCategory("");
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

    try {
      const formData = new FormData();
      formData.append("image_0", item.imageFile!);
      if (item.modelImageFile) formData.append("model_image_0", item.modelImageFile);
      if (item.logoImageFile) formData.append("logo_image_0", item.logoImageFile);
      formData.append("description", item.description);
      formData.append("product_name", item.productName);
      if (formCategory) formData.append("category", formCategory);
      formData.append("mode", generationMode);
      formData.append("preferences", JSON.stringify(prefs));

      if (selectedCustomerId) {
        const cust = customers.find((c) => c.id === selectedCustomerId);
        if (cust) {
          formData.append("customer_id", cust.id);
          formData.append("customer_name", cust.name);
          if (cust.sizeChartCsv) formData.append("customer_size_chart", cust.sizeChartCsv);
          if (cust.requirements) formData.append("customer_requirements", cust.requirements);
          if (cust.customTemplateId) formData.append("custom_template_id", cust.customTemplateId);
        }
      }

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
          qi.id === item.id ? { ...qi, status: "error" } : qi
        )
      );
    }
  };

  // ========== 渲染 ==========

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-3 sm:px-4 h-12 sm:h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <a href="/" className="text-muted hover:text-accent text-xs sm:text-sm flex-shrink-0">←</a>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight flex items-center gap-1.5 sm:gap-2 truncate">
              <span className="hidden sm:inline">A+ 详情生成</span>
              <span className="text-xs font-normal text-muted bg-surface-warm px-1.5 sm:px-2 py-0.5 rounded truncate">批量</span>
              {profileLoaded && (
                <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded">🧠 学习中</span>
              )}
            </h1>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
            <select
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              className="text-xs border border-border rounded-lg px-2 py-1 bg-surface max-w-[100px] sm:max-w-[140px] truncate"
            >
              <option value="">全部客户</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <a href="/customers" className="text-xs text-muted hover:text-accent font-medium">👤 客户</a>
            <a href="/output" className="text-xs text-muted hover:text-accent font-medium">📋 产出</a>
            <a href="/style-extract" className="text-xs text-muted hover:text-accent font-medium">🎨 复刻</a>
            <span className={`text-[10px] sm:text-xs font-medium ${credits <= 2 ? "text-red-500" : credits <= 5 ? "text-orange-500" : "text-text-muted"}`}>{credits}积分</span>
          </div>
        </div>
      </header>

      <div className="max-w-2xl lg:max-w-5xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* ===== 进行中提示 ===== */}
        {runningCount > 0 && (
          <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl text-sm">
            <span className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
            <span className="flex-1">
              <span className="font-medium text-blue-800">{runningCount} 个任务进行中</span>
            </span>
            <a href="/output" className="text-xs text-brand hover:underline font-medium">查看产出 →</a>
          </div>
        )}

        {/* ===== 客户已加载提示 ===== */}
        {selectedCustomerId && (() => {
          const cust = customers.find((c) => c.id === selectedCustomerId);
          if (!cust) return null;
          const hasData = cust.logo || cust.modelRef || cust.sizeChartCsv || cust.requirements || cust.defaultStyle || cust.defaultModel;
          if (!hasData) return null;
          return (
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-2">
              <p className="text-sm font-medium text-blue-800">✅ 已加载客户：{cust.name}</p>
              <div className="flex flex-wrap gap-2 text-xs text-blue-700">
                {cust.logo && <span className="bg-blue-100 px-2 py-0.5 rounded">🏷️ Logo</span>}
                {cust.modelRef && <span className="bg-blue-100 px-2 py-0.5 rounded">🧑 模特图</span>}
                {cust.defaultStyle && <span className="bg-blue-100 px-2 py-0.5 rounded">🎨 {cust.defaultStyle}</span>}
                {cust.defaultModel && <span className="bg-blue-100 px-2 py-0.5 rounded">👤 {cust.defaultModel}</span>}
                {cust.sizeChartCsv && <span className="bg-blue-100 px-2 py-0.5 rounded">📏 尺码表</span>}
                {cust.requirements && <span className="bg-blue-100 px-2 py-0.5 rounded">📋 特殊要求</span>}
              </div>
              {cust.requirements && (
                <p className="text-xs text-blue-600 italic mt-1 line-clamp-2">"{cust.requirements}"</p>
              )}
            </div>
          );
        })()}

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

        {/* ===== 品类（必选）===== */}
        <div>
          <h2 className="text-base sm:text-lg font-semibold mb-2">品类 <span className="text-red-400 text-xs ml-1">必选</span></h2>
          <div className="flex flex-wrap gap-2">
            {["上衣","裤子","套装","鞋帽","箱包"].map((cat) => (
              <button key={cat} type="button" onClick={() => setFormCategory(formCategory === cat ? "" : cat)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition
                  ${formCategory === cat ? "bg-accent text-accent-on border-accent" : "bg-surface text-muted border-border hover:border-accent"}`}
              >{cat}</button>
            ))}
          </div>
          {!formCategory && <p className="text-xs text-red-400 mt-1">请选择产品品类</p>}
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
                  <summary className="text-xs text-text-muted cursor-pointer hover:text-brand py-1">+ 更多 Open Design 风格（29 种）</summary>
                  <div className="mt-2 space-y-2 max-h-64 overflow-y-auto">
                    {(() => {
                      const cats = [...new Set(OD_STYLES.map(od => od.category))];
                      return cats.map(cat => (
                        <div key={cat}>
                          <p className="text-[10px] text-muted font-medium mb-1">{cat}</p>
                          <div className="flex flex-wrap gap-1">
                            {OD_STYLES.filter(od => od.category === cat).map((od) => (
                              <button key={od.value}
                                onClick={() => setPrefs({ ...prefs, odStyle: prefs.odStyle === od.value ? "" : od.value, style: prefs.odStyle === od.value ? prefs.style : "auto" })}
                                className={`px-2 py-0.5 rounded text-[10px] transition-all ${
                                  prefs.odStyle === od.value ? "bg-accent text-accent-on font-medium" : "bg-surface border border-border text-muted hover:border-accent/30 hover:text-fg"
                                }`}>{od.label}</button>
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
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

        {/* ===== 生成模式 ===== */}
        <div>
          <h2 className="text-base sm:text-lg font-semibold mb-1">生成模式</h2>
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1 max-w-xs">
            <button
              onClick={() => setGenerationMode("detail")}
              className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                generationMode === "detail"
                  ? "bg-white shadow text-brand"
                  : "text-text-muted hover:text-text"
              }`}
            >
              📄 详情页
            </button>
            <button
              onClick={() => setGenerationMode("single")}
              className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                generationMode === "single"
                  ? "bg-white shadow text-brand"
                  : "text-text-muted hover:text-text"
              }`}
            >
              🖼️ 单图
            </button>
          </div>
          <p className="text-xs text-text-muted mt-1.5">
            {generationMode === "single"
              ? "只生成 1 张场景图，不生成 HTML 详情页、白底图和多场景图。"
              : "生成完整 A+ 详情页，含多张场景图、白底主图、多版本变体。"}
          </p>
        </div>

        {/* ===== 按钮区 ===== */}
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <button onClick={handleAddToQueue} disabled={!canAddMore}
              className="flex-1 py-3 bg-brand text-white rounded-xl text-base font-medium hover:bg-brand-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              ➕ 加入生成队列
            </button>
          </div>

          <a href="/output"
            className="w-full py-3 border-2 border-dashed border-border rounded-xl text-text-muted hover:text-brand hover:border-brand/30 transition-colors flex items-center justify-center gap-2 text-sm font-medium">
            📋 查看所有产出
          </a>
        </div>
      </div>
    </div>
  );
}
