import Link from "next/link";

export default function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-gray-50">
      {/* Hero */}
      <div className="max-w-3xl mx-auto px-4 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-full text-xs text-text-muted mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          Powered by Duma Agent
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
          Amazon A+ 详情生成器
        </h1>
        <p className="text-lg text-text-muted max-w-xl mx-auto mb-3">
          上传一张白底产品图，AI 自动完成全流程
        </p>
        <p className="text-sm text-text-muted max-w-lg mx-auto mb-10">
          产品特征分析 → 多场景图生成 → A+ 详情页排版 → 一键下载交付
        </p>
        <Link
          href="/build"
          className="inline-block px-8 py-3.5 bg-brand text-white rounded-xl text-base font-medium hover:bg-brand-hover transition-colors shadow-lg shadow-brand/20"
        >
          ✨ 开始使用
        </Link>
      </div>

      {/* 三步流程 */}
      <div className="max-w-4xl mx-auto px-4 pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {[
            { step: "①", title: "上传产品图", desc: "拖拽或点击上传一张白底产品照，支持 JPG/PNG/WebP。可选填产品描述帮助 AI 更准确。" },
            { step: "②", title: "AI 自动生成", desc: "Agent 分析产品特征，用火山引擎生成 5-8 张场景图，再排版成 A+ 详情页。约 2-5 分钟。" },
            { step: "③", title: "下载交付", desc: "预览 A+ 详情页效果，单独下载每张图或一键打包全部。直接上传 Amazon。" },
          ].map((item) => (
            <div key={item.step} className="bg-white rounded-2xl border border-border p-6 hover:shadow-sm transition-shadow">
              <div className="text-2xl mb-3 text-brand font-bold">{item.step}</div>
              <h3 className="font-semibold mb-2">{item.title}</h3>
              <p className="text-sm text-text-muted leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 特性 */}
      <div className="max-w-4xl mx-auto px-4 pb-20">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          {[
            { label: "内置风格", value: "5 种", sub: "+14 Open Design" },
            { label: "场景图生成", value: "5-8 张", sub: "火山引擎 i2i" },
            { label: "AI 偏好学习", value: "自动", sub: "越用越懂你" },
            { label: "输出格式", value: "HTML+图", sub: "直接上传 Amazon" },
          ].map((item) => (
            <div key={item.label} className="bg-white rounded-xl border border-border p-4">
              <div className="text-xl font-bold text-brand mb-1">{item.value}</div>
              <div className="text-sm font-medium">{item.label}</div>
              <div className="text-[11px] text-text-muted mt-0.5">{item.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="text-center pb-10">
        <p className="text-xs text-text-muted">
          Built with Hermes Agent · 火山引擎 Ark · DeepSeek
        </p>
      </div>
    </div>
  );
}
