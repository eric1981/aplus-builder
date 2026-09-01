import { NextRequest, NextResponse } from "next/server";
import { taskStore } from "@/app/api/generate/task-store";

/**
 * GET /api/list-history
 * 历史记录直接查数据库（tasks 表），不再递归扫描产出目录。
 */
export async function GET(request: NextRequest) {
  try {
    const userId = request.headers.get("x-user-id") || "admin";
    const entries = taskStore.listHistory(userId).map((t) => ({
      taskId: t.taskId,
      userId: t.userId,
      userName: t.userName,
      dirName: t.dirName,
      timestamp: t.createdAt,
      imageCount: t.imageCount,
      variantNames: t.variantNames,
      hasHtml: true,
      firstImage: t.firstImage,
    }));
    return NextResponse.json({ entries });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "未知错误" }, { status: 500 });
  }
}
