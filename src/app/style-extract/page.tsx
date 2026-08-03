"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface CustomerInfo {
  id: string; name: string;
}

export default function StyleExtractPage() {
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [requirements, setRequirements] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [resultHtml, setResultHtml] = useState("");
  const [error, setError] = useState("");
  const [customers, setCustomers] = useState<CustomerInfo[]>([]);
  const [assignedCustomer, setAssignedCustomer] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/customers").then(r => r.json()).then(setCustomers).catch(() => {});
  }, []);

  const handleImageUpload = useCallback((file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    setScreenshotFile(file);
    const reader = new FileReader();
    reader.onload = () => setScreenshot(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleSubmit = async () => {
    if (!screenshotFile) return;
    setStatus("running");
    setError("");
    setResultHtml("");

    try {
      const fd = new FormData();
      fd.append("screenshot", screenshotFile);
      fd.append("requirements", requirements);
      if (assignedCustomer) fd.append("customer_id", assignedCustomer);

      const res = await fetch("/api/style-extract", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "启动失败");
      setTaskId(data.taskId);

      // 轮询
      const poll = setInterval(async () => {
        try {
          const r = await fetch(`/api/style-extract?taskId=${data.taskId}`);
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

  const canSubmit = screenshotFile != null && status !== "running";

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
        {/* 截图上传 */}
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
          {status === "running" ? "🎨 正在复刻风格…" : "🎨 开始复刻"}
        </button>

        {/* 进度 */}
        {status === "running" && (
          <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
            <span className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
            <div>
              <p className="font-medium text-blue-800 text-sm">Agent 正在分析截图并创建模板…</p>
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
                <iframe srcDoc={resultHtml} className="w-full" style={{ height: "60vh", minHeight: "400px", border: "none" }} />
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
