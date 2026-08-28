/**
 * 任务存储（数据库驱动）：运行时队列与历史记录共用 tasks 表。
 * - 任务创建时 INSERT（status=queued/running），完成/失败时 UPDATE 状态并保留记录
 * - 历史列表直接查库，不再递归扫描产出目录
 */
import { db, ensureMigrated } from "@/lib/db";

export interface PersistedTask {
  taskId: string;
  userId: string;
  status: "running" | "queued";
  workDir: string;
  mode: string;
  customTemplateId?: string;
  attempts: number;
  createdAt: number;
}

export interface HistoryTask {
  taskId: string;
  dirName: string | null;
  productName: string | null;
  imageCount: number;
  firstImage: string | null;
  variantNames: string[];
  createdAt: number;
  error: string | null;
}

function toHistory(row: Record<string, unknown>): HistoryTask {
  let variantNames: string[] = [];
  try {
    variantNames = JSON.parse(String(row.variant_names || "[]"));
  } catch {}
  return {
    taskId: String(row.task_id),
    dirName: row.dir_name ? String(row.dir_name) : null,
    productName: row.product_name ? String(row.product_name) : null,
    imageCount: Number(row.image_count || 0),
    firstImage: row.first_image ? String(row.first_image) : null,
    variantNames,
    createdAt: Number(row.created_at || 0),
    error: row.error ? String(row.error) : null,
  };
}

class TaskStore {
  add(task: PersistedTask) {
    db.prepare(
      `INSERT INTO tasks
        (task_id, user_id, status, mode, work_dir, custom_template_id, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         status = excluded.status,
         updated_at = excluded.updated_at`,
    ).run(
      task.taskId,
      task.userId,
      task.status,
      task.mode,
      task.workDir,
      task.customTemplateId || null,
      task.attempts,
      task.createdAt,
      Date.now(),
    );
  }

  remove(taskId: string) {
    db.prepare(`DELETE FROM tasks WHERE task_id = ?`).run(taskId);
  }

  get(taskId: string): PersistedTask | undefined {
    const row = db
      .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      taskId: String(row.task_id),
      userId: String(row.user_id || "admin"),
      status: row.status === "queued" ? "queued" : "running",
      workDir: String(row.work_dir || ""),
      mode: String(row.mode || "detail"),
      customTemplateId: row.custom_template_id ? String(row.custom_template_id) : undefined,
      attempts: Number(row.attempts || 1),
      createdAt: Number(row.created_at || 0),
    };
  }

  /** 自动重试计数 +1 */
  bumpAttempts(taskId: string) {
    db.prepare(`UPDATE tasks SET attempts = attempts + 1, updated_at = ? WHERE task_id = ?`).run(
      Date.now(),
      taskId,
    );
  }

  /** 恢复时需要重启的任务（运行中/排队中） */
  getRecoverable(): PersistedTask[] {
    const rows = db
      .prepare(`SELECT * FROM tasks WHERE status IN ('running','queued') ORDER BY created_at`)
      .all() as Record<string, unknown>[];
    return rows
      .filter((r) => r.work_dir)
      .map((r) => ({
        taskId: String(r.task_id),
        userId: String(r.user_id || "admin"),
        status: r.status === "queued" ? ("queued" as const) : ("running" as const),
        workDir: String(r.work_dir),
        mode: String(r.mode || "detail"),
        customTemplateId: r.custom_template_id ? String(r.custom_template_id) : undefined,
        attempts: Number(r.attempts || 1),
        createdAt: Number(r.created_at || 0),
      }));
  }

  /** 任务完成：更新状态与产出元数据（历史记录来源） */
  markDone(
    taskId: string,
    meta: {
      productName?: string;
      dirName?: string;
      imageCount: number;
      firstImage?: string | null;
      variantNames?: string[];
    },
  ) {
    db.prepare(
      `UPDATE tasks SET
         status = 'done',
         product_name = COALESCE(?, product_name),
         dir_name = COALESCE(?, dir_name),
         image_count = ?,
         first_image = COALESCE(?, first_image),
         variant_names = ?,
         error = NULL,
         updated_at = ?
       WHERE task_id = ?`,
    ).run(
      meta.productName || null,
      meta.dirName || null,
      meta.imageCount,
      meta.firstImage || null,
      JSON.stringify(meta.variantNames || []),
      Date.now(),
      taskId,
    );
  }

  /** 任务失败/取消：更新状态与错误信息（保留记录供审计/历史） */
  markError(taskId: string, error: string) {
    db.prepare(`UPDATE tasks SET status = 'error', error = ?, updated_at = ? WHERE task_id = ?`).run(
      error,
      Date.now(),
      taskId,
    );
  }

  /** 某用户的历史（已完成且有产出的任务） */
  listHistory(userId: string): HistoryTask[] {
    ensureMigrated(); // 首次查询时执行旧数据迁移
    const rows = db
      .prepare(
        `SELECT task_id, dir_name, product_name, image_count, first_image, variant_names, created_at, error
         FROM tasks
         WHERE user_id = ? AND status = 'done' AND image_count > 0
         ORDER BY created_at DESC
         LIMIT 500`,
      )
      .all(userId) as Record<string, unknown>[];
    return rows.map(toHistory);
  }

  /** 用户最近的任务总数（后台用） */
  countByUser(userId: string): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE user_id = ?`)
      .get(userId) as { c: number } | undefined;
    return Number(row?.c || 0);
  }
}

export const taskStore = new TaskStore();
