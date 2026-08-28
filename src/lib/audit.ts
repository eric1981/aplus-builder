/**
 * 审计日志（稳定性 P1）：关键操作写入 SQLite audit_log 表。
 * 用于多用户场景下的追溯：谁在什么时候做了什么。
 */
import { db } from "@/lib/db";

/** 插入一条审计记录（不抛异常，审计失败不影响业务） */
export function logAudit(
  userId: string,
  action: string,
  detail?: Record<string, unknown>,
): void {
  try {
    db.prepare(
      `INSERT INTO audit_log (ts, user_id, action, detail) VALUES (?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      userId || "admin",
      action,
      detail ? JSON.stringify(detail) : null,
    );
  } catch {}
}
