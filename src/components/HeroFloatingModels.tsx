"use client";

import { useEffect, useState } from "react";

/**
 * 首屏悬浮模特图（wearview 风格）
 *
 * 6 张竖版 9:16 图片绝对定位在 hero 两侧（左右各 3），
 * 通过 .animate-float-collage 上下浮动，负 animation-delay 错峰。
 *
 * 图片源：客户端挂载后从 /api/hero-images 随机拉取品牌方产出（作品墙）；
 * 拉取失败或无产出时回退主题配置的静态图（fallbackImages）。
 *
 * 仅在 ≥1280px（xl）显示，移动端隐藏避免遮挡文案。
 */
export default function HeroFloatingModels({ fallbackImages }: { fallbackImages: string[] }) {
  const [images, setImages] = useState<string[]>(fallbackImages);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/hero-images?count=6");
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

  // 左侧 3 张：left + top 错落；右侧 3 张：right + top 错落
  const POSITIONS = [
    // 左 1 / 右 1：顶部
    { side: "left" as const, pos: "left-[1%] xl:left-[2%]", top: "top-[5%]", delay: "-1.2s", opacity: "opacity-70", size: "w-[110px] xl:w-[130px]" },
    { side: "right" as const, pos: "right-[1%] xl:right-[2%]", top: "top-[5%]", delay: "-2.5s", opacity: "opacity-70", size: "w-[110px] xl:w-[130px]" },
    // 左 2 / 右 2：中部偏上
    { side: "left" as const, pos: "left-[9%] xl:left-[11%]", top: "top-[22%]", delay: "-3.5s", opacity: "opacity-60", size: "w-[100px] xl:w-[120px]" },
    { side: "right" as const, pos: "right-[9%] xl:right-[11%]", top: "top-[25%]", delay: "-4.8s", opacity: "opacity-60", size: "w-[100px] xl:w-[120px]" },
    // 左 3 / 右 3：中部偏下
    { side: "left" as const, pos: "left-[2%] xl:left-[4%]", top: "top-[48%]", delay: "-5.2s", opacity: "opacity-55", size: "w-[105px] xl:w-[125px]" },
    { side: "right" as const, pos: "right-[2%] xl:right-[4%]", top: "top-[50%]", delay: "-6s", opacity: "opacity-55", size: "w-[105px] xl:w-[125px]" },
  ];

  const srcs = images.length >= 6 ? images : [...images, ...fallbackImages].slice(0, 6);
  if (srcs.length === 0) return null;

  return (
    <div className="hidden xl:block absolute inset-0 z-0" aria-hidden="true">
      {POSITIONS.map((p, i) => {
        const src = srcs[i % srcs.length];
        if (!src) return null;
        return (
          <div
            key={i}
            className={`absolute ${p.pos} ${p.top} ${p.size} ${p.opacity} aspect-[9/16] rounded-2xl overflow-hidden shadow-xl animate-float-collage [animation-delay:${p.delay}]`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
        );
      })}
    </div>
  );
}
