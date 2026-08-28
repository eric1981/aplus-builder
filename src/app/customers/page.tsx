"use client";

import { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { STYLE_OPTIONS, OD_STYLES, MODEL_OPTIONS, type BuiltinStyle, type ModelPref } from "@/lib/preference-constants";

interface Customer {
  id: string; name: string; logo?: string; modelRef?: string;
  sizeChartCsv?: string; requirements?: string;
  defaultStyle?: string; defaultModel?: string;
  customTemplateId?: string;
  createdAt: string;
}

interface TemplateInfo {
  id: string; filename: string;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = customers.find(c => c.id === selectedId) || null;

  const [editName, setEditName] = useState("");
  const [editStyle, setEditStyle] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editSizeChart, setEditSizeChart] = useState("");
  const [editRequirements, setEditRequirements] = useState("");
  const [editTemplateId, setEditTemplateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // 资产 data URL（从 API 加载）
  const [logoUrl, setLogoUrl] = useState("");
  const [modelUrl, setModelUrl] = useState("");

  const logoRef = useRef<HTMLInputElement>(null);
  const modelRefRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch("/api/customers").then(r => r.json()).then(d => { if (Array.isArray(d)) setCustomers(d); }).catch(() => {});
    apiFetch("/api/style-extract/templates").then(r => r.json()).then(d => { if (d && Array.isArray(d.templates)) setTemplates(d.templates); }).catch(() => {});
    // 未登录（远程访问无会话）重定向到登录页；localhost 恒为 admin，不会触发
    apiFetch("/api/auth/me").then((r) => { if (r.status === 401) window.location.href = "/login"; }).catch(() => {});
  }, []);

  const select = (c: Customer) => {
    setSelectedId(c.id);
    setEditName(c.name);
    setEditStyle(c.defaultStyle || "");
    setEditModel(c.defaultModel || "");
    setEditSizeChart(c.sizeChartCsv || "");
    setEditRequirements(c.requirements || "");
    setEditTemplateId(c.customTemplateId || "");
    setLogoUrl("");
    setModelUrl("");
    // 加载资产
    if (c.logo) {
      apiFetch(`/api/customers/assets?id=${c.id}&type=logo`)
        .then(r => r.json()).then(d => { if (d.dataUrl) setLogoUrl(d.dataUrl); }).catch(() => {});
    }
    if (c.modelRef) {
      apiFetch(`/api/customers/assets?id=${c.id}&type=model-ref`)
        .then(r => r.json()).then(d => { if (d.dataUrl) setModelUrl(d.dataUrl); }).catch(() => {});
    }
  };

  const handleSave = async () => {
    if (!selectedId) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await apiFetch("/api/customers", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selectedId, name: editName.trim(),
          defaultStyle: editStyle || undefined,
          defaultModel: editModel || undefined,
          sizeChartCsv: editSizeChart || undefined,
          requirements: editRequirements || undefined,
          customTemplateId: editTemplateId || undefined,
        }),
      });
      if (!res.ok) throw new Error("保存失败");
      const updated = await res.json();
      setCustomers(prev => prev.map(c => c.id === selectedId ? { ...c, ...updated } : c));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!selectedId || !confirm("确认删除？")) return;
    await apiFetch("/api/customers", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: selectedId }) });
    setCustomers(prev => prev.filter(c => c.id !== selectedId));
    setSelectedId(null);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const res = await apiFetch("/api/customers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName.trim() }) });
    if (res.ok) {
      const created = await res.json();
      setCustomers(prev => [...prev, created]);
      setShowNew(false);
      select(created);
    }
  };

  const handleLogoUpload = async (file: File | null) => {
    if (!file || !selectedId) return;
    const fd = new FormData();
    fd.append("logo", file);
    const res = await apiFetch(`/api/customers/upload?id=${selectedId}&type=logo`, { method: "POST", body: fd });
    if (res.ok) {
      const data = await res.json();
      setCustomers(prev => prev.map(c => c.id === selectedId ? { ...c, logo: data.filename } : c));
    }
  };

  const handleModelUpload = async (file: File | null) => {
    if (!file || !selectedId) return;
    const fd = new FormData();
    fd.append("model", file);
    const res = await apiFetch(`/api/customers/upload?id=${selectedId}&type=model-ref`, { method: "POST", body: fd });
    if (res.ok) {
      const data = await res.json();
      setCustomers(prev => prev.map(c => c.id === selectedId ? { ...c, modelRef: data.filename } : c));
    }
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

      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* 客户列表 */}
        <div className="md:col-span-1 space-y-1">
          {customers.map(c => (
            <button key={c.id} onClick={() => select(c)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                c.id === selectedId ? "bg-accent/10 text-accent font-medium" : "text-fg hover:bg-surface-warm"
              }`}>
              {c.name}
              {c.customTemplateId && <span className="ml-2 text-[10px] text-muted">🎨</span>}
            </button>
          ))}
          {customers.length === 0 && (
            <p className="text-sm text-muted py-4">暂无客户</p>
          )}
        </div>

        {/* 编辑区 */}
        <div className="md:col-span-2">
          {!selected ? (
            <div className="text-center py-16 text-muted">
              <div className="text-3xl mb-2">👤</div>
              <p>选择一个客户或新建</p>
            </div>
          ) : (
            <div className="space-y-5 p-5 border border-border rounded-2xl bg-surface">
              <div className="flex items-center justify-between">
                <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                  className="text-lg font-semibold border-b border-border bg-transparent px-1 py-0.5 focus:outline-none focus:border-accent w-48" />
                <button onClick={handleDelete} className="text-xs text-red-500 hover:text-red-700">删除</button>
              </div>

              {/* Logo */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">品牌 Logo</label>
                  <div onClick={() => logoRef.current?.click()} className="w-36 h-16 border-2 border-dashed border-border rounded-lg flex items-center justify-center cursor-pointer hover:border-accent/30 overflow-hidden">
                    {selected.logo && logoUrl ? (
                      <img src={logoUrl} alt="Logo" className="max-w-full max-h-full object-contain p-1" />
                    ) : (
                      <span className="text-xs text-muted">点击上传</span>
                    )}
                  </div>
                  <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={e => handleLogoUpload(e.target.files?.[0] || null)} />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">模特参考图</label>
                  <div onClick={() => modelRefRef.current?.click()} className="w-24 h-24 border-2 border-dashed border-border rounded-lg flex items-center justify-center cursor-pointer hover:border-accent/30 overflow-hidden">
                    {selected.modelRef && modelUrl ? (
                      <img src={modelUrl} alt="模特" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-xs text-muted">点击上传</span>
                    )}
                  </div>
                  <input ref={modelRefRef} type="file" accept="image/*" className="hidden" onChange={e => handleModelUpload(e.target.files?.[0] || null)} />
                </div>
              </div>

              {/* 默认偏好 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">默认排版风格</label>
                  <select value={editStyle} onChange={e => setEditStyle(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm">
                    <option value="">不指定</option>
                    {STYLE_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                    <option disabled>── Open Design ──</option>
                    {OD_STYLES.map(od => (
                      <option key={od.value} value={od.value}>  {od.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">默认模特偏好</label>
                  <select value={editModel} onChange={e => setEditModel(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm">
                    <option value="">不指定</option>
                    {MODEL_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 自定义模板 */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  自定义风格模板
                  <span className="text-muted text-xs font-normal ml-2">（A+ 风格复刻产出，优先于排版风格）</span>
                </label>
                {templates.length > 0 ? (
                  <select value={editTemplateId} onChange={e => setEditTemplateId(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm">
                    <option value="">不使用自定义模板</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.filename}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-muted">
                    还没有模板。去 <a href="/style-extract" className="text-accent hover:underline">A+ 风格复刻</a> 创建。
                  </p>
                )}
              </div>

              {/* 尺码表 */}
              <div>
                <label className="block text-sm font-medium mb-2">尺码表（CSV）</label>
                <textarea value={editSizeChart} onChange={e => setEditSizeChart(e.target.value)}
                  placeholder="S,胸围84,衣长62&#10;M,胸围88,衣长64&#10;L,胸围92,衣长66"
                  rows={3} className="w-full px-3 py-2 border border-border rounded-lg text-sm resize-none" />
              </div>

              {/* 其他要求 */}
              <div>
                <label className="block text-sm font-medium mb-2">其他要求</label>
                <textarea value={editRequirements} onChange={e => setEditRequirements(e.target.value)}
                  placeholder="如：必须使用品牌色 #C8A882、不要用暖色调背景…"
                  rows={3} className="w-full px-3 py-2 border border-border rounded-lg text-sm resize-none" />
              </div>

              <div className="flex gap-2 items-center">
                <button onClick={handleSave} disabled={saving}
                  className={`px-6 py-2 rounded-lg text-sm font-medium transition-colors ${
                    saved ? "bg-green-600 text-white" : "bg-accent text-accent-on hover:bg-accent-active"
                  } disabled:opacity-60`}>
                  {saving ? "保存中…" : saved ? "✅ 已保存" : "保存"}
                </button>
                <button onClick={() => setSelectedId(null)}
                  className="px-4 py-2 border border-border text-muted rounded-lg text-sm hover:bg-surface-warm transition-colors">取消</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 新建弹窗 */}
      {showNew && (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50" onClick={() => setShowNew(false)}>
          <div className="bg-white rounded-2xl p-6 w-80 shadow-lg" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">新建客户</h2>
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="客户名称" autoFocus
              className="w-full px-3 py-2 border border-border rounded-lg text-sm mb-4"
              onKeyDown={e => e.key === "Enter" && handleCreate()} />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowNew(false)}
                className="px-4 py-2 text-sm text-muted hover:text-fg">取消</button>
              <button onClick={handleCreate}
                className="px-4 py-2 bg-accent text-accent-on rounded-lg text-sm font-medium">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
