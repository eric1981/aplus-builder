"use client";

import { useEffect } from "react";

export default function BuildError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Build page error:", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md mx-auto px-4 text-center">
        <div className="text-4xl mb-4">⚠️</div>
        <h2 className="text-lg font-semibold mb-2">页面加载异常</h2>
        <p className="text-sm text-text-muted mb-6">
          {error.message || "发生了未知错误，请刷新重试。"}
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors"
          >
            重试
          </button>
          <a
            href="/"
            className="px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            返回首页
          </a>
        </div>
        <p className="text-xs text-text-muted mt-6">
          如果问题持续，请尝试用无痕窗口打开，或关闭代理隧道直接访问 localhost:3000
        </p>
      </div>
    </div>
  );
}
