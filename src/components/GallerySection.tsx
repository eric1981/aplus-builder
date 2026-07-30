"use client";

import Link from "next/link";

const CARDS = [
  {
    label: "Editorial 暖杂志",
    desc: "衬线体 · 圆角卡 · 暖白底 — 法式慵懒质感",
    className: "bg-[#FBFBFA]",
    textColor: "text-[#4A4A45]",
    descColor: "text-[#999]",
    img: "/gallery/editorial.png",
    fallback: "📖",
    fontClass: "font-serif",
  },
  {
    label: "Swiss 瑞士风",
    desc: "无衬线 · 全直角 · 黑白灰 — 极简功能美学",
    className: "bg-white",
    textColor: "text-[#111]",
    descColor: "text-[#888]",
    img: "/gallery/swiss.png",
    fallback: "◼️",
    fontClass: "tracking-tight",
  },
  {
    label: "Product Launch",
    desc: "暗底Hero · 暖橙渐变 — 爆品质感冲击",
    className: "bg-[#1A1A1A]",
    textColor: "text-white",
    descColor: "text-white/50",
    img: "/gallery/product-launch.png",
    fallback: "🚀",
    fontClass: "",
  },
];

export default function GallerySection() {
  return (
    <div className="max-w-5xl mx-auto px-4 pb-12 sm:pb-16">
      <div className="text-center mb-8">
        <h2 className="text-xl sm:text-2xl font-bold mb-2">同款产品，三种风格</h2>
        <p className="text-sm text-text-muted">每张图仅需 2-5 分钟，AI 自动完成全流程</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
        {CARDS.map((card) => (
          <Link key={card.label} href="/build" className="group block">
            <div className={`${card.className} rounded-2xl overflow-hidden border border-border shadow-sm hover:shadow-md transition-all`}>
              <div className="aspect-[9/16] relative overflow-hidden">
                <img
                  src={card.img}
                  alt={card.label}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  loading="lazy"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                    (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
                  }}
                />
                <div className="absolute inset-0 hidden items-center justify-center text-5xl">
                  {card.fallback}
                </div>
                {/* 渐变蒙层 */}
                {card.className === "bg-[#1A1A1A]" && (
                  <div className="absolute inset-0 bg-gradient-to-t from-[#1A1A1A] via-[#1A1A1A]/40 to-transparent" />
                )}
                {card.className === "bg-[#FBFBFA]" && (
                  <div className="absolute inset-0 bg-gradient-to-t from-[#FBFBFA] via-transparent to-transparent" />
                )}
              </div>
              <div className="p-4">
                <h3 className={`text-sm font-semibold ${card.textColor} ${card.fontClass}`}>
                  {card.label}
                </h3>
                <p className={`text-[11px] mt-1 ${card.descColor}`}>{card.desc}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
