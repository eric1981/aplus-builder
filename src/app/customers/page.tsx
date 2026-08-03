"use client";

import { useState, useEffect, useRef } from "react";
import { STYLE_OPTIONS, OD_STYLES, MODEL_OPTIONS, type BuiltinStyle, type ModelPref } from "@/lib/preference-constants";

interface Customer {
  id: string;
  name: string;
  logo?: string;
  modelRef?: string;
  sizeChartCsv?: string;
  requirements?: string;
  defaultStyle?: string;
  defaultModel?: string;
  createdAt: string;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);

  const [editName, setEditName] = useState("");
  const [editStyle, setEditStyle] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editSizeChart, setEditSizeChart] = useState("");
  const [editRequirements, setEditRequirements] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [modelUrl, setModelUrl] = useState<string | null>(null);

  const logoInputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);

  const selected = customers.find((c) => c.id === selectedId);

  const loadCustomers = () => {
    fetch("/api/customers").then((r) => r.json()).then(setCustomers).catch(() => {});
  };
  useEffect(() => { loadCustomers(); }, []);

  useEffect(() => {
    if (!selected) {
      setEditName(""); setEditStyle(""); setEditModel("");
      setEditSizeChart(""); setEditRequirements("");
      setLogoUrl(null); setModelUrl(null);
      return;
    }
    setEditName(selected.name);
    setEditStyle(selected.defaultStyle || "");
    setEditModel(selected.defaultModel || "");
    setEditSizeChart(selected.sizeChartCsv || "");
    setEditRequirements(selected.requirements || "");

    if (selected.logo) {
      fetch(`/api/customers/assets?id=${selected.id}&type=logo`)
        .then((r) => r.json()).then((d) => setLogoUrl(d.dataUrl)).catch(() => setLogoUrl(null));
    } else { setLogoUrl(null); }

    if (selected.modelRef) {
      fetch(`/api/customers/assets?id=${selected.id}&type=model-ref`)
        .then((r) => r.json()).then((d) => setModelUrl(d.dataUrl)).catch(() => setModelUrl(null));
    } else { setModelUrl(null); }
  }, [selectedId, customers]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const res = await fetch("/api/customers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (!res.ok) return alert((await res.json()).error);
    const created = await res.json();
    setCustomers((prev) => [...prev, created]);
    setSelectedId(created.id);
    setShowNew(false);
  };

  const handleSave = async () => {
    if (!selectedId || !editName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/customers", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selectedId, name: editName.trim(),
          defaultStyle: editStyle || undefined,
          defaultModel: editModel || undefined,
          sizeChartCsv: editSizeChart || undefined,
          requirements: editRequirements || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      loadCustomers();
      alert("已保存。返回生成页面，选择该客户即可应用。");
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const handleUpload = async (type: "logo" | "model-ref", file: File | null) => {
    if (!file || !selectedId) return;
    const formData = new FormData();
    formData.append("id", selectedId);
    formData.append("type", type);
    formData.append("file", file);
    const res = await fetch("/api/customers/upload", { method: "POST", body: formData });
    if (!res.ok) return alert((await res.json()).error);
    loadCustomers();
  };

  const handleDelete = async () => {
    if (!selectedId || !confirm("确定删除该客户及其全部数据？")) return;
    await fetch(`/api/customers?id=${selectedId}`, { method: "DELETE" });
    setSelectedId("");
    loadCustomers();
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-5xl mx-auto px-3 sm:px-4 h-12 sm:h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <a href="/" className="text-muted hover:text-accent text-xs sm:text-sm flex-shrink-0">←</a>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight">客户管理</h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            <a href="/output" className="text-xs text-muted hover:text-accent">📋 产出</a>
            <a href="/build" className="text-xs text-muted hover:text-accent">生成页</a>
            <button onClick={() => { setShowNew(true); setNewName(""); }}
              className="px-3 py-1.5 bg-accent text-accent-on rounded-lg text-xs font-medium hover:bg-accent-active transition-colors">
              + 新建
            </button>
          </div>
        </div>
      </header>

      {showNew && (
        <div className="fixed inset-0 z-[60] bg-black/30 flex items-center justify-center" onClick={() => setShowNew(false)}>
          <div className="bg-white rounded-2xl p-6 shadow-xl max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">新建客户</h2>
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="客户名称" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
              className="w-full px-4 py-2.5 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand mb-4" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowNew(false)} className="px-4 py-2 text-sm text-text-muted">取消</button>
              <button onClick={handleCreate} disabled={!newName.trim()}
                className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">创建</button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-6 flex gap-6">
        {/* 左侧列表 */}
        <div className="w-56 flex-shrink-0 space-y-1">
          {customers.map((c) => (
            <button key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={`w-full text-left px-4 py-3 rounded-xl text-sm transition-colors ${
                c.id === selectedId
                  ? "bg-brand text-white font-medium"
                  : "bg-white border border-border hover:bg-gray-50 text-text"
              }`}>
              <div className="truncate">{c.name}</div>
              <div className="text-[10px] opacity-60 mt-0.5">
                {c.createdAt ? new Date(c.createdAt).toLocaleDateString("zh-CN") : ""}
              </div>
            </button>
          ))}
          {customers.length === 0 && (
            <p className="text-sm text-text-muted text-center py-8">暂无客户</p>
          )}
        </div>

        {/* 右侧编辑区 */}
        <div className="flex-1 min-w-0">
          {selected ? (
            <div className="border border-border rounded-2xl bg-white p-6 space-y-6">
              {/* 基本信息 */}
              <div>
                <label className="block text-sm font-medium mb-2">客户名称</label>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                  className="w-full max-w-sm px-4 py-2.5 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand" />
              </div>

              {/* 品牌 Logo */}
              <div>
                <label className="block text-sm font-medium mb-2">品牌 Logo</label>
                <p className="text-xs text-text-muted mb-2">PNG 透明底最佳。上传后生成页选中该客户时自动加载。</p>
                <div className="flex items-start gap-4">
                  {logoUrl ? (
                    <div className="relative w-36 h-16 rounded-lg overflow-hidden border border-border bg-gray-50 flex items-center justify-center">
                      <img src={logoUrl} alt="Logo" className="max-w-full max-h-full object-contain p-2" />
                      <button onClick={() => { setLogoUrl(null); }}
                        className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/60 text-white rounded-full flex items-center justify-center text-[10px]">✕</button>
                    </div>
                  ) : (
                    <div onClick={() => logoInputRef.current?.click()}
                      className="w-36 h-16 border-2 border-dashed border-border rounded-lg flex items-center justify-center cursor-pointer hover:border-brand/30 transition-colors">
                      <span className="text-text-muted text-xs">点击上传</span>
                    </div>
                  )}
                  <input ref={logoInputRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => handleUpload("logo", e.target.files?.[0] || null)} />
                </div>
              </div>

              {/* 专属模特图 */}
              <div>
                <label className="block text-sm font-medium mb-2">专属模特参考图</label>
                <p className="text-xs text-text-muted mb-2">正面半身照。生成时自动用于虚拟换装。</p>
                <div className="flex items-start gap-4">
                  {modelUrl ? (
                    <div className="relative w-20 h-20 rounded-lg overflow-hidden border border-border bg-gray-50">
                      <img src={modelUrl} alt="模特" className="w-full h-full object-cover" />
                      <button onClick={() => { setModelUrl(null); }}
                        className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/60 text-white rounded-full flex items-center justify-center text-[10px]">✕</button>
                    </div>
                  ) : (
                    <div onClick={() => modelInputRef.current?.click()}
                      className="w-20 h-20 border-2 border-dashed border-border rounded-lg flex items-center justify-center cursor-pointer hover:border-brand/30 transition-colors">
                      <span className="text-text-muted text-[10px] text-center leading-tight">上传<br/>模特图</span>
                    </div>
                  )}
                  <input ref={modelInputRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => handleUpload("model-ref", e.target.files?.[0] || null)} />
                </div>
              </div>

              {/* 默认偏好 — 与 build 页完全一致的选项 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">默认排版风格</label>
                  <select value={editStyle} onChange={(e) => setEditStyle(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm">
                    <option value="">不指定</option>
                    {STYLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                    <option disabled>── Open Design ──</option>
                    {OD_STYLES.map((od) => (
                      <option key={od.value} value={od.value}>{od.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">默认模特偏好</label>
                  <select value={editModel} onChange={(e) => setEditModel(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm">
                    <option value="">不指定</option>
                    {MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 尺码表 */}
              <div>
                <label className="block text-sm font-medium mb-2">尺码表（CSV 格式）</label>
                <p className="text-xs text-text-muted mb-2">每行一个尺码，逗号分隔。<code className="bg-gray-100 px-1 rounded text-xs">S,胸围84,衣长62,肩宽36</code></p>
                <textarea value={editSizeChart} onChange={(e) => setEditSizeChart(e.target.value)}
                  placeholder={"S,胸围84,衣长62,肩宽36\nM,胸围88,衣长64,肩宽37\nL,胸围92,衣长66,肩宽38"}
                  rows={5}
                  className="w-full px-4 py-3 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand resize-none font-mono" />
              </div>

              {/* 其他要求 */}
              <div>
                <label className="block text-sm font-medium mb-2">其他要求</label>
                <p className="text-xs text-text-muted mb-2">特殊排版要求、品牌调性描述、禁忌事项等。生成时自动注入 prompt。</p>
                <textarea value={editRequirements} onChange={(e) => setEditRequirements(e.target.value)}
                  placeholder="例如：必须使用品牌色 #C8A882 作为强调色；模特必须在花园场景中拍摄…"
                  rows={4}
                  className="w-full px-4 py-3 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand resize-none" />
              </div>

              <div className="flex gap-3 pt-4 border-t border-border">
                <button onClick={handleSave} disabled={saving}
                  className="px-6 py-2.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {saving ? "保存中…" : "💾 保存"}
                </button>
                <button onClick={handleDelete}
                  className="px-4 py-2.5 border border-red-200 text-red-600 rounded-lg text-sm hover:bg-red-50 transition-colors">
                  🗑 删除客户
                </button>
                <a href="/build" className="px-4 py-2.5 border border-border text-text-muted rounded-lg text-sm hover:bg-gray-50 transition-colors ml-auto">
                  返回生成页 →
                </a>
              </div>
            </div>
          ) : (
            <div className="border border-border rounded-2xl bg-white p-12 text-center text-text-muted">
              <div className="text-4xl mb-3">👤</div>
              <p>选择一个客户以编辑信息</p>
              <p className="text-xs mt-2">保存后返回生成页，选择该客户即可应用配置</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
