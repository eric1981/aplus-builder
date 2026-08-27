/**
 * 审计日志（稳定性 P1）：关键操作以 JSONL 追加写入 data/audit.log。
 * 用于多用户场景下的追溯：谁在什么时候做了什么。
 */
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const AUDIT_FILE = join(DATA_DIR, "audit.log");

function ensureFile() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** 追加一条审计记录（不抛异常，审计失败不影响业务） */
export function logAudit(
  userId: string,
  action: string,
  detail?: Record<string, unknown>,
): void {
  try {
    ensureFile();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      user: userId || "admin",
      action,
      ...(detail || {}),
    });
    appendFileSync(AUDIT_FILE, line + "\n", "utf-8");
  } catch {}
}
