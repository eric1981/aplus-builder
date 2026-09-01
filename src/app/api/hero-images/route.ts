import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * GET /api/hero-images?count=6
 * 首页首屏悬浮模特图：从产出中随机挑 N 张（展示"作品墙"）。
 *
 * 安全：拉取范围由服务端环境变量 HERO_IMAGE_USER 控制（默认 admin），
 * 不接受前端指定 userId —— 避免把任意用户的产出公开到首页。
 * 返回的 URL 是相对 OUTPUT_BASE 的 /api/output 路径（逐段 encode）。
 */

/** 产出图相对路径 → /api/output URL（与服务端 outputImageUrl 同逻辑） */
function outputUrl(relPath: string): string {
  return `/api/output/${relPath.split("/").map(encodeURIComponent).join("/")}`;
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
        `SELECT first_image FROM tasks
         WHERE user_id = ? AND status = 'done' AND image_count > 0 AND first_image IS NOT NULL
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(userId, count) as { first_image: string }[];

    const images = rows
      .map((r) => r.first_image)
      .filter((p): p is string => Boolean(p))
      .map(outputUrl);

    return NextResponse.json({ images });
  } catch {
    return NextResponse.json({ images: [] });
  }
}
