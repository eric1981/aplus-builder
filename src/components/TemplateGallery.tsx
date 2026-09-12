"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/apiFetch";

interface TemplateInfo {
  id: string;
  filename: string;
  thumb: string | null;
  ownerId?: string;
  isPlatform?: boolean;
  createdAt: number;
}

/** 把模板 HTML 里的相对图片路径重写为 asset API 绝对路径（预览 iframe 用） */
function rewriteAssetPaths(html: string, templateId: string): string {
  return html.replace(
    /(src|href)=["']\.\/([^"']+)["']/g,
    (_m, attr, file) => `${attr}="/api/style-extract/templates/asset/${templateId}/${encodeURIComponent(file)}"`,
  );
}

/** 产出中心的"我的模板"分区：复刻的风格模板（本人 + admin），缩略图展示 */
export default function TemplateGallery() {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<{ id: string; html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/style-extract/templates");
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d.templates)) setTemplates(d.templates);
      setLoaded(true);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  // 首次加载后：若存在无缩略图的模板（后端刚触发懒生成截图），6 秒后自动刷新拿缩略图
  useEffect(() => {
    if (!loaded) return;
    const hasMissing = templates.some((t) => !t.thumb);
    if (!hasMissing) return;
    const timer = setTimeout(() => { load(); }, 6000);
    return () => clearTimeout(timer);
  }, [loaded, templates, load]);

  const openPreview = async (t: TemplateInfo) => {
    try {
      const r = await apiFetch(`/api/style-extract/templates?content=${encodeURIComponent(t.id)}`);
      if (!r.ok) { setError("预览加载失败"); return; }
      const d = await r.json();
      setPreview({ id: t.id, html: rewriteAssetPaths(d.html || "", t.id) });
    } catch { setError("预览加载失败"); }
  };

  const remove = async (t: TemplateInfo) => {
    if (!window.confirm("删除该模板？删除后不可恢复。")) return;
    try {
      const r = await apiFetch(`/api/style-extract/templates?id=${encodeURIComponent(t.id)}`, { method: "DELETE" });
      if (!r.ok) { setError("删除失败（可能无权限）"); return; }
      setTemplates((prev) => prev.filter((x) => x.id !== t.id));
    } catch { setError("删除失败"); }
  };

  if (loaded && templates.length === 0) return null; // 无模板不占版面

  return (
    <div>
      <h2 className="text-base sm:text-lg font-semibold mb-3">
        风格模板<span className="text-xs text-text-muted font-normal ml-2">（复刻的风格模板，生成时可选用）</span>
      </h2>

      {error && (
        <p className="text-xs text-red-500 mb-2">⚠️ {error}</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {templates.map((t) => (
          <div key={t.id} className="bg-white border border-border rounded-xl overflow-hidden group">
            <div
              onClick={() => openPreview(t)}
              className="aspect-[3/4] bg-gray-50 cursor-pointer overflow-hidden relative"
            >
              {t.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={t.thumb} alt="模板缩略图" className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-3xl text-gray-300">🎨</div>
              )}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-end">
                <div className="w-full p-1.5 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex gap-1.5">
                  <button onClick={() => openPreview(t)} className="flex-1 py-1 bg-white/90 rounded text-[10px] text-gray-800 font-medium">预览</button>
                  <button onClick={() => remove(t)} className="px-2 py-1 bg-red-500/90 rounded text-[10px] text-white font-medium">删除</button>
                </div>
              </div>
            </div>
            <div className="px-2 py-1.5 text-[10px] text-text-muted truncate" title={t.id}>
              {t.isPlatform ? "平台模板" : "我的模板"} · {new Date(t.createdAt).toLocaleDateString("zh-CN")}
            </div>
          </div>
        ))}
      </div>

      {/* 预览弹层 */}
      {preview && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
              <p className="text-sm font-semibold truncate">模板预览</p>
              <button onClick={() => setPreview(null)} className="text-muted hover:text-red-500">✕ 关闭</button>
            </div>
            <div className="flex-1 overflow-auto p-2 bg-gray-100">
              <iframe
                srcDoc={preview.html}
                sandbox="allow-scripts allow-popups allow-forms"
                referrerPolicy="no-referrer"
                className="w-full"
                style={{ height: "70vh", border: "none", background: "white" }}
                title="模板预览"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
