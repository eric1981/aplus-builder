import { readdirSync, existsSync } from "fs";
import { join, relative } from "path";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOutputBase } from "@/lib/config";

/**
 * GET /api/hero-images?count=6
 * 首页首屏悬浮模特图：从品牌方产出的「模特场景图」（文件名含 scene）中随机挑 N 张。
 *
 * 安全：拉取范围由服务端环境变量 HERO_IMAGE_USER 控制（默认 admin），
 * 不接受前端指定 userId —— 避免把任意用户的产出公开到首页。
 * 返回的 URL 是相对 OUTPUT_BASE 的 /api/output 路径（逐段 encode）。
 */

/** 产出图绝对路径 → /api/output URL（相对 OUTPUT_BASE，逐段 encode） */
function outputUrl(absPath: string): string {
  const rel = relative(getOutputBase(), absPath);
  return `/api/output/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** 扫描任务目录，收集模特场景图（scene-01 等）；兼容 output/ 子目录与根目录结构 */
function collectSceneImages(workDir: string): string[] {
  const out: string[] = [];
  const candidates = [join(workDir, "output"), workDir];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (
          /\.(jpg|jpeg|png|webp)$/i.test(f) &&
          /scene[\s_-]*\d+/i.test(f) && // scene-01 / scene_02 / scene 1
          !/qc|hanging|whitebg|detail|hero/i.test(f) // 排除质检/挂拍/白底/细节/首图
        ) {
          out.push(join(dir, f));
        }
      }
    } catch {}
  }
  return out;
}

/** 扫描任务目录，收集 hero 首图（xxx-hero.jpg 等） */
function collectHeroImages(workDir: string): string[] {
  const out: string[] = [];
  const candidates = [join(workDir, "output"), workDir];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (
          /\.(jpg|jpeg|png|webp)$/i.test(f) &&
          /hero/i.test(f) &&
          !/scene|qc|hanging|whitebg/i.test(f)
        ) {
          out.push(join(dir, f));
        }
      }
    } catch {}
  }
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const count = Math.min(
      Math.max(parseInt(req.nextUrl.searchParams.get("count") || "6", 10) || 6, 1),
      12,
    );
    // 服务端指定拉取范围：默认 admin（品牌方自己的产出），可用环境变量覆盖
    const userId = process.env.HERO_IMAGE_USER || "admin";

    const rows = db
      .prepare(
        `SELECT work_dir FROM tasks
         WHERE user_id = ? AND status = 'done' AND image_count > 0 AND work_dir IS NOT NULL
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(userId, Math.max(count * 3, 12)) as { work_dir: string }[];

    // 每个任务优先取 1 张（scene 模特场景图优先，无 scene 则该任务退而用 hero 首图），
    // 池子不足 count 时补足：先补其他任务的 hero 图，再补同任务剩余 scene 图。
    // 保证悬浮位满员的同时，尽量让 6 张来自不同任务。
    const tasks: { scenes: string[]; heros: string[] }[] = [];
    for (const r of rows) {
      const scenes = collectSceneImages(r.work_dir);
      const heros = collectHeroImages(r.work_dir);
      if (scenes.length > 0 || heros.length > 0) tasks.push({ scenes, heros });
    }
    const pool: string[] = [];
    // 第一轮：每任务 1 张（scene 优先）
    for (const t of tasks) {
      const src = t.scenes.length > 0
        ? t.scenes[Math.floor(Math.random() * t.scenes.length)]
        : t.heros[Math.floor(Math.random() * t.heros.length)];
      pool.push(src);
    }
    // 补足轮 1：其他任务的 hero 图
    const heroRest = tasks.flatMap((t) => t.heros);
    while (pool.length < count && heroRest.length > 0) {
      const i = Math.floor(Math.random() * heroRest.length);
      const img = heroRest.splice(i, 1)[0];
      if (!pool.includes(img)) pool.push(img);
    }
    // 补足轮 2：同任务剩余 scene 图（此时才允许同款多张）
    const sceneRest = tasks.flatMap((t) => t.scenes);
    while (pool.length < count && sceneRest.length > 0) {
      const i = Math.floor(Math.random() * sceneRest.length);
      const img = sceneRest.splice(i, 1)[0];
      if (!pool.includes(img)) pool.push(img);
    }
    // Fisher-Yates 随机挑
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const images = pool.slice(0, count).map(outputUrl);
    return NextResponse.json({ images });
  } catch {
    return NextResponse.json({ images: [] });
  }
}
