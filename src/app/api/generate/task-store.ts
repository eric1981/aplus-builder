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
  userId: string;
  userName: string | null;
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
    userId: String(row.user_id || "admin"),
    userName: row.user_name ? String(row.user_name) : null,
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
    try {
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
    } catch {
      // 构建期多 worker 并发或库未就绪时返回空（运行时由 safeInit 保证可用）
      return [];
    }
  }

  /** 失败但已有产出目录的任务（Agent 退出码非 0 但产物齐全，供恢复补记 done） */
  getErroredForRecovery(): { taskId: string; userId: string; workDir: string }[] {
    try {
      const rows = db
        .prepare(
          `SELECT task_id, user_id, work_dir FROM tasks WHERE status = 'error' AND work_dir IS NOT NULL`,
        )
        .all() as Record<string, unknown>[];
      return rows
        .filter((r) => r.work_dir)
        .map((r) => ({
          taskId: String(r.task_id),
          userId: String(r.user_id || "admin"),
          workDir: String(r.work_dir),
        }));
    } catch {
      // 构建期多 worker 并发或库未就绪时返回空
      return [];
    }
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

  /** 保存市场预测（JSON 字符串） */
  updatePrediction(taskId: string, prediction: unknown | null) {
    db.prepare(`UPDATE tasks SET prediction = ?, updated_at = ? WHERE task_id = ?`).run(
      prediction ? JSON.stringify(prediction) : null,
      Date.now(),
      taskId,
    );
  }

  /** 读取任务的市场预测（原始 JSON 对象；无则 null） */
  getPrediction(taskId: string): Record<string, unknown> | null {
    try {
      const row = db
        .prepare(`SELECT prediction FROM tasks WHERE task_id = ?`)
        .get(taskId) as { prediction: string | null } | undefined;
      if (!row?.prediction) return null;
      return JSON.parse(row.prediction);
    } catch {
      return null;
    }
  }

  /** 按产出目录名读取预测（历史恢复用）；支持 admin 视角的 "<userId>/<dirName>" 前缀形式 */
  getPredictionByDir(dirName: string): Record<string, unknown> | null {
    try {
      const find = (dir: string) =>
        db
          .prepare(
            `SELECT prediction FROM tasks WHERE dir_name = ? AND prediction IS NOT NULL
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(dir) as { prediction: string | null } | undefined;
      // 1) 精确匹配（普通用户视角：dir_name 无前缀）
      let row = find(dirName);
      // 2) admin 视角带 "<userId>/" 前缀 → 取最后一段再匹配（预测存在真实任务行上）
      if (!row?.prediction && dirName.includes("/")) {
        const last = dirName.slice(dirName.lastIndexOf("/") + 1);
        if (last) row = find(last);
      }
      if (!row?.prediction) return null;
      return JSON.parse(row.prediction);
    } catch {
      return null;
    }
  }

  /** 某用户的历史（已完成且有产出的任务）；admin 返回全部用户的真实任务（排除旧迁移行） */
  listHistory(userId: string): HistoryTask[] {
    ensureMigrated(); // 首次查询时执行旧数据迁移
    try {
      if (userId === "admin") {
        // admin：所有用户 + admin 自己的真实任务与旧迁移行（legacy- 前缀），
        // 按 dir_name 去重（同目录优先真实行），带用户名。
        // 非 admin 用户任务：dir_name/first_image 加 "<userId>/" 前缀，
        // 因为 admin 的 userBase 是 OUTPUT_BASE 根目录，必须靠前缀定位用户子目录文件。
        const rows = db
          .prepare(
            `SELECT t.task_id, t.user_id, t.dir_name, t.product_name, t.image_count,
                    t.first_image, t.variant_names, t.created_at, t.error,
                    u.name AS user_name
             FROM tasks t LEFT JOIN users u ON u.id = t.user_id
             WHERE t.status = 'done' AND t.image_count > 0
             ORDER BY t.created_at DESC
             LIMIT 500`,
          )
          .all() as Record<string, unknown>[];

        // 去重：同一产出目录（含带 "<userId>/" 前缀的迁移行）只保留一条，
        // 优先真实行（非 legacy）；同类型时保留先遇到的（新）
        const seen = new Map<string, Record<string, unknown>>();
        for (const r of rows) {
          const dir = String(r.dir_name || "");
          const key = dir.includes("/") ? dir.slice(dir.lastIndexOf("/") + 1) : dir;
          if (!key) continue;
          const existing = seen.get(key);
          const curIsLegacy = String(r.task_id).startsWith("legacy-");
          if (!existing) {
            seen.set(key, r);
          } else {
            const oldIsLegacy = String(existing.task_id).startsWith("legacy-");
            // 当前是真实行且已有的是 legacy 行 → 用真实行覆盖
            if (!curIsLegacy && oldIsLegacy) seen.set(key, r);
          }
        }

        return [...seen.values()].map((r) => {
          const uid = String(r.user_id || "admin");
          const h = toHistory(r);
          if (uid !== "admin" && h.dirName && !h.dirName.startsWith(uid + "/")) {
            h.dirName = `${uid}/${h.dirName}`;
          }
          if (uid !== "admin" && h.firstImage && !h.firstImage.startsWith(uid + "/")) {
            h.firstImage = `${uid}/${h.firstImage}`;
          }
          return h;
        });
      }
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
    } catch {
      return [];
    }
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
