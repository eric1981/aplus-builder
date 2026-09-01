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

/** 扫描任务目录，收集模特场景图（文件名 scene 后跟数字，如 scene-01 / scene_02），
 *  排除 qc_/hanging/whitebg 等非模特场景图；兼容 output/ 子目录与根目录结构 */
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

    // 汇总所有候选任务的 scene 图，再随机挑 count 张
    const pool: string[] = [];
    for (const r of rows) {
      pool.push(...collectSceneImages(r.work_dir));
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
