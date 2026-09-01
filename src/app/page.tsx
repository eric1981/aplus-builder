import Link from "next/link";
import GallerySection from "../components/GallerySection";
import HeroFloatingModels from "../components/HeroFloatingModels";
import { getCurrentBrand } from "../lib/brand";

export default function Landing() {
  const brand = getCurrentBrand();

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-gray-50">
      {/* Hero */}
      <div className="relative">
        {/* 首屏两侧悬浮模特图（全宽定位，仅大屏显示，z-0 在文字下方） */}
        {brand.hero.images && brand.hero.images.length > 0 && (
          <HeroFloatingModels images={brand.hero.images} />
        )}
        <div className="relative z-10 max-w-3xl mx-auto px-4 pt-16 sm:pt-24 pb-12 sm:pb-16 text-center">
        {brand.logoImage && (
          <img
            src={brand.logoImage}
            alt={brand.name}
            className="mx-auto mb-6 max-h-20 sm:max-h-24 w-auto object-contain"
          />
        )}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-full text-[10px] sm:text-xs text-text-muted mb-6 sm:mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          {brand.hero.badge}
        </div>
        <h1 className="text-2xl sm:text-4xl md:text-5xl font-bold tracking-tight mb-3 sm:mb-4">
          {brand.hero.title}
        </h1>
        <p className="text-sm sm:text-lg text-text-muted max-w-xl mx-auto mb-2 sm:mb-3">
          {brand.hero.subtitle}
        </p>
        <p className="text-xs sm:text-sm text-text-muted max-w-lg mx-auto mb-8 sm:mb-10">
          {brand.hero.pipeline}
        </p>
        <Link
          href="/build"
          className="inline-block px-6 sm:px-8 py-3 sm:py-3.5 bg-brand text-white rounded-xl text-sm sm:text-base font-medium hover:bg-brand-hover transition-colors shadow-lg shadow-brand/20"
        >
          {brand.hero.cta}
        </Link>
        </div>
      </div>

      {/* 三步流程 */}
      <div className="max-w-4xl mx-auto px-4 pb-12 sm:pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
          {brand.steps.map((item) => (
            <div key={item.step} className="bg-white rounded-2xl border border-border p-4 sm:p-6 hover:shadow-sm transition-shadow">
              <div className="text-xl sm:text-2xl mb-2 sm:mb-3 text-brand font-bold">{item.step}</div>
              <h3 className="font-semibold mb-1 sm:mb-2 text-sm sm:text-base">{item.title}</h3>
              <p className="text-xs sm:text-sm text-text-muted leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 模板画廊 */}
      <GallerySection />

      {/* 特性 */}
      <div className="max-w-4xl mx-auto px-4 pb-16 sm:pb-20">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 text-center">
          {brand.features.map((item) => (
            <div key={item.label} className="bg-white rounded-xl border border-border p-3 sm:p-4">
              <div className="text-lg sm:text-xl font-bold text-brand mb-0.5 sm:mb-1">{item.value}</div>
              <div className="text-xs sm:text-sm font-medium">{item.label}</div>
              <div className="text-[10px] sm:text-[11px] text-text-muted mt-0.5">{item.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
