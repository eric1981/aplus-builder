"use client";

import { useEffect, useState } from "react";

/**
 * 横向无限轮播（wearview 风格）
 *
 * 内容复制两份，flex 整体左移 50% 实现无缝循环；
 * hover 暂停便于查看。图片源从 /api/hero-images?all=1 拉取品牌方产出
 * （scene 场景图 + hero 首图混合），失败时回退主题静态图。
 */
export default function HorizontalScroller({ fallbackImages }: { fallbackImages: string[] }) {
  const [images, setImages] = useState<string[]>(fallbackImages);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/hero-images?all=1&count=24");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.images) && data.images.length > 0) {
          setImages(data.images);
        }
      } catch {
        // 保持 fallback 静态图
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 少于 6 张就不展示轮播（内容太少滚动效果差）
  const cards = images.length >= 6 ? images : [...images, ...fallbackImages];
  if (cards.length < 6) return null;
  // 复制一份用于无缝循环（translate -50%）
  const doubled = [...cards, ...cards];

  return (
    <div className="scroller-paused relative overflow-hidden" aria-label="作品展示">
      <div className="flex gap-4 animate-scroll-left items-center w-max">
        {doubled.map((src, i) => (
          <div
            key={i}
            className="relative flex-shrink-0 w-[180px] h-[320px] rounded-3xl overflow-hidden shadow-sm"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
        ))}
      </div>
    </div>
  );
}
