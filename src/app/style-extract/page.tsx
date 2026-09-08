"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { apiFetch } from "@/lib/apiFetch";

interface CustomerInfo {
  id: string; name: string;
}

/** 每张参考图可指定的"参考元素"（对应 agent 映射维度） */
const ROLE_OPTIONS = [
  "整体风格",
  "配色",
  "字体",
  "排版与布局",
  "模块结构",
  "图片处理手法",
  "间距与圆角",
  "特殊元素",
];

interface RefItem {
  id: string;
  dataUrl: string;
  file: File;
  role: string;
  note: string;
}

let _rid = 0;
function newRefId(): string { return `r${Date.now()}_${_rid++}`; }

export default function StyleExtractPage() {
  const [mode, setMode] = useState<"basic" | "advanced">("basic");
  // 基础模式：单张
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  // 高级模式：多张 + 角色
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [requirements, setRequirements] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [resultHtml, setResultHtml] = useState("");
  const [error, setError] = useState("");
  const [customers, setCustomers] = useState<CustomerInfo[]>([]);
  const [assignedCustomer, setAssignedCustomer] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const multiFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch("/api/customers").then(r => r.json()).then(d => { if (Array.isArray(d)) setCustomers(d); }).catch(() => {});
    apiFetch("/api/auth/me").then((r) => { if (r.status === 401) window.location.href = "/login"; }).catch(() => {});
  }, []);

  const handleImageUpload = useCallback((file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    setScreenshotFile(file);
    const reader = new FileReader();
    reader.onload = () => setScreenshot(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  // 高级模式加图（支持多选）
  const handleMultiUpload = useCallback((files: FileList | null) => {
    if (!files) return;
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    list.forEach((file, idx) => {
      const id = newRefId();
      const reader = new FileReader();
      reader.onload = () => {
        setRefs((prev) => {
          const exists = prev.some((p) => p.id === id);
          return exists ? prev : [...prev, { id, dataUrl: reader.result as string, file, role: idx === 0 ? "整体风格" : "配色", note: "" }];
        });
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const removeRef = (id: string) => setRefs((prev) => prev.filter((r) => r.id !== id));
  const patchRef = (id: string, patch: Partial<RefItem>) =>
    setRefs((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const handleSubmit = async () => {
    const hasImg = mode === "basic" ? screenshotFile != null : refs.length > 0;
    if (!hasImg) return;
    setStatus("running");
    setError("");
    setResultHtml("");

    try {
      const fd = new FormData();
      fd.append("mode", mode);
      fd.append("requirements", requirements);
      if (assignedCustomer) fd.append("customer_id", assignedCustomer);
      if (mode === "basic") {
        fd.append("screenshot", screenshotFile!);
      } else {
        refs.forEach((r, i) => {
          fd.append(`ref_${i}`, r.file);
          fd.append(`ref_role_${i}`, r.role);
          fd.append(`ref_note_${i}`, r.note);
        });
      }

      const res = await apiFetch("/api/style-extract", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "启动失败");
      setTaskId(data.taskId);

      // 轮询
      const poll = setInterval(async () => {
        try {
          const r = await apiFetch(`/api/style-extract?taskId=${data.taskId}`);
          const t = await r.json();
          if (t.status === "done") {
            clearInterval(poll);
            setStatus("done");
            setResultHtml(t.html || "");
          } else if (t.status === "error") {
            clearInterval(poll);
            setStatus("error");
            setError(t.error || "未知错误");
          }
        } catch {}
      }, 3000);
    } catch (e: any) {
      setStatus("error");
      setError(e.message);
    }
  };

  const canSubmit = (mode === "basic" ? screenshotFile != null : refs.length > 0) && status !== "running";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 bg-white/85 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-3 sm:px-4 h-12 sm:h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/" className="text-muted hover:text-accent text-xs sm:text-sm">←</a>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight">A+ 风格复刻</h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <a href="/output" className="text-xs text-muted hover:text-accent font-medium">📋 产出</a>
            <a href="/build" className="text-xs bg-accent text-accent-on px-2.5 py-1 rounded-md font-medium hover:bg-accent-active transition-colors">✚ 新建</a>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-6">
        {/* 模式切换 */}
        <div className="flex gap-2">
          {(["basic", "advanced"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium border ${mode === m ? "bg-accent text-accent-on border-accent" : "bg-white text-muted border-border"}`}>
              {m === "basic" ? "基础复刻（单图）" : "高级复刻（多图分工）"}
            </button>
          ))}
        </div>

        {/* 基础：单图 */}
        {mode === "basic" && (
          <div>
            <h2 className="text-base sm:text-lg font-semibold mb-1">参考截图</h2>
            <p className="text-muted text-xs sm:text-sm mb-4">上传一张 A+ 详情页、品牌官网或 Pinterest 截图，AI 将反推其设计风格。</p>
            {screenshot ? (
              <div className="relative w-full max-w-md rounded-xl overflow-hidden bg-gray-100 shadow-sm">
                <img src={screenshot} alt="参考截图" className="w-full object-contain max-h-64" />
                <button onClick={() => { setScreenshot(null); setScreenshotFile(null); }}
                  className="absolute top-2 right-2 w-7 h-7 bg-black/60 text-white rounded-full flex items-center justify-center text-sm hover:bg-black/80">✕</button>
              </div>
            ) : (
              <div onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); handleImageUpload(e.dataTransfer.files?.[0] || null); }}
                onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-border rounded-xl p-8 sm:p-12 text-center cursor-pointer hover:border-accent/30 transition-colors">
                <div className="text-2xl sm:text-3xl mb-2">📸</div>
                <p className="text-muted text-xs sm:text-sm">拖拽或点击上传参考截图</p>
                <p className="text-muted text-[10px] sm:text-xs mt-1">JPG / PNG / WebP</p>
                <input ref={fileRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => handleImageUpload(e.target.files?.[0] || null)} />
              </div>
            )}
          </div>
        )}

        {/* 高级：多图分工 */}
        {mode === "advanced" && (
          <div>
            <h2 className="text-base sm:text-lg font-semibold mb-1">参考图（可多张，每张指定职责）</h2>
            <p className="text-muted text-xs sm:text-sm mb-4">
              上传多张参考图，并为每张指定它贡献什么元素（例如：图 1 管配色、图 2 管排版）。最多 8 张。
            </p>

            {refs.length > 0 && (
              <div className="space-y-3 mb-3">
                {refs.map((r, idx) => (
                  <div key={r.id} className="flex gap-3 p-3 bg-gray-50 rounded-xl border border-border">
                    <div className="w-20 h-24 rounded-lg overflow-hidden bg-white border border-border flex-shrink-0">
                      {r.dataUrl && <img src={r.dataUrl} alt={`参考图 ${idx + 1}`} className="w-full h-full object-cover" />}
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-muted w-20">图 {idx + 1} 负责</span>
                        <select value={r.role} onChange={(e) => patchRef(r.id, { role: e.target.value })}
                          className="flex-1 text-xs border border-border rounded-lg px-2 py-1.5 bg-white">
                          {ROLE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <button onClick={() => removeRef(r.id)}
                          className="w-6 h-6 text-red-400 hover:text-red-600 text-sm flex-shrink-0">✕</button>
                      </div>
                      <input value={r.note} onChange={(e) => patchRef(r.id, { note: e.target.value })}
                        placeholder="补充说明（可选）：如'背景色取这张，文字色参考另一张'…"
                        className="w-full text-xs border border-border rounded-lg px-2 py-1.5 bg-white" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {refs.length < 8 && (
              <div onClick={() => multiFileRef.current?.click()}
                className="border-2 border-dashed border-border rounded-xl p-6 text-center cursor-pointer hover:border-accent/30 transition-colors">
                <div className="text-xl mb-1">➕</div>
                <p className="text-muted text-xs">点击选择图片（可多选）</p>
                <input ref={multiFileRef} type="file" accept="image/*" multiple className="hidden"
                  onChange={(e) => handleMultiUpload(e.target.files)} />
              </div>
            )}
          </div>
        )}

        {/* 要求 */}
        <div>
          <h2 className="text-base sm:text-lg font-semibold mb-1">复刻要求 <span className="text-muted text-xs font-normal ml-2">（可选）</span></h2>
          <p className="text-muted text-xs sm:text-sm mb-4">描述你希望保留或修改的设计元素。</p>
          <textarea value={requirements} onChange={(e) => setRequirements(e.target.value)}
            placeholder="例如：保留整体配色，但把标题字体改成无衬线；或：提取模块结构，但不要用圆角卡片…"
            rows={3}
            className="w-full px-4 py-3 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent resize-none" />
        </div>

        {/* 指定客户 */}
        {customers.length > 0 && (
          <div>
            <h2 className="text-base sm:text-lg font-semibold mb-1">指定客户 <span className="text-muted text-xs font-normal ml-2">（可选）</span></h2>
            <p className="text-muted text-xs sm:text-sm mb-3">复刻完成后自动绑定到该客户，后续生成使用此模板。</p>
            <select value={assignedCustomer} onChange={(e) => setAssignedCustomer(e.target.value)}
              className="text-sm border border-border rounded-lg px-3 py-2 bg-surface max-w-xs">
              <option value="">不指定</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* 提交 */}
        <button onClick={handleSubmit} disabled={!canSubmit}
          className="w-full py-3 bg-accent text-accent-on rounded-xl text-base font-medium hover:bg-accent-active transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
          {status === "running" ? "🎨 正在复刻风格…" : mode === "advanced" ? "🎨 开始高级复刻" : "🎨 开始复刻"}
        </button>

        {/* 进度 */}
        {status === "running" && (
          <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
            <span className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
            <div>
              <p className="font-medium text-blue-800 text-sm">AI 正在分析截图并创建模板…</p>
              <p className="text-xs text-blue-600 mt-0.5">预计 2-4 分钟</p>
            </div>
          </div>
        )}

        {/* 错误 */}
        {status === "error" && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
            ❌ {error}
          </div>
        )}

        {/* 结果 */}
        {status === "done" && resultHtml && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700">
              <span>✅</span>
              <span>模板创建成功！已保存至 customer-templates/{taskId}.html</span>
            </div>
            <details>
              <summary className="text-sm text-muted cursor-pointer hover:text-accent">预览 HTML</summary>
              <div className="mt-2 border border-border rounded-xl overflow-hidden bg-white">
                <iframe srcDoc={resultHtml} sandbox="allow-scripts allow-popups allow-forms" referrerPolicy="no-referrer" className="w-full" style={{ height: "60vh", minHeight: "400px", border: "none" }} />
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
