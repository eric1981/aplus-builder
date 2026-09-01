import Link from "next/link";
import GallerySection from "../components/GallerySection";
import HeroFloatingModels from "../components/HeroFloatingModels";
import HorizontalScroller from "../components/HorizontalScroller";
import { getCurrentBrand } from "../lib/brand";

export default function Landing() {
  const brand = getCurrentBrand();

  return (
    <div className="bg-gradient-to-b from-white to-gray-50">
      {/* Hero：首屏撑满（min-h-screen 垂直居中），轮播等其余内容在下方 */}
      <div className="relative min-h-screen flex items-center">
        {/* 首屏两侧悬浮模特图（全宽定位，仅大屏显示，z-0 在文字下方） */}
        {brand.hero.images && brand.hero.images.length > 0 && (
          <HeroFloatingModels fallbackImages={brand.hero.images} />
        )}
        <div className="relative z-10 w-full max-w-4xl mx-auto px-4 py-16 sm:py-20 text-center">
        {brand.logoImage && (
          <img
            src={brand.logoImage}
            alt={brand.name}
            className="mx-auto mb-6 sm:mb-8 max-h-24 sm:max-h-32 w-auto object-contain"
          />
        )}
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-full text-xs sm:text-sm text-text-muted mb-6 sm:mb-8">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          {brand.hero.badge}
        </div>
        <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-4 sm:mb-5">
          {brand.hero.title}
        </h1>
        <p className="text-base sm:text-xl text-text-muted max-w-2xl mx-auto mb-3 sm:mb-4">
          {brand.hero.subtitle}
        </p>
        <p className="text-sm sm:text-base text-text-muted max-w-xl mx-auto mb-10 sm:mb-12">
          {brand.hero.pipeline}
        </p>
        <Link
          href="/build"
          className="inline-block px-8 sm:px-10 py-4 sm:py-4.5 bg-brand text-white rounded-xl text-base sm:text-lg font-semibold hover:bg-brand-hover transition-colors shadow-lg shadow-brand/20"
        >
          {brand.hero.cta}
        </Link>
        </div>
      </div>

      {/* 横向作品轮播（wearview 风格，展示产出场景图） */}
      {brand.showScroller !== false && (
        <div className="py-8 sm:py-10 bg-white border-y border-border-soft">
          <div className="max-w-5xl mx-auto px-4 mb-4 sm:mb-6">
            <h2 className="text-lg sm:text-xl font-bold">作品展示</h2>
            <p className="text-xs sm:text-sm text-text-muted mt-1">用 {brand.name} 生成的模特场景图（自动更新）</p>
          </div>
          <HorizontalScroller fallbackImages={brand.hero.images || []} />
        </div>
      )}

      {/* 三步流程 */}
      <div className="max-w-4xl mx-auto px-4 pt-16 sm:pt-24 pb-12 sm:pb-16">
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
