/**
 * 任务持久化（稳定性 P0）：
 * - 存储位置从 /tmp（重启即丢）迁移到 <项目>/data/tasks.json（稳定、可备份）
 * - 原子写入（先写临时文件再 rename），避免进程崩溃时损坏 JSON
 * - 记录 attempts（自动重试次数），恢复时不会无限重跑
 *
 * 后续若要换 SQLite/Postgres，只改本文件内部实现，接口保持不变。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "tasks.json");

export interface PersistedTask {
  taskId: string;
  userId: string;
  status: "running" | "queued";
  workDir: string;
  mode: string;
  customTemplateId?: string;
  /** 已启动 Agent 的次数（用于自动重试上限） */
  attempts: number;
  createdAt: number;
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function writeAtomic(data: PersistedTask[]) {
  ensureDir();
  const tmp = STORE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, STORE_PATH);
}

class TaskStore {
  private data: PersistedTask[] = [];

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (existsSync(STORE_PATH)) {
        this.data = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
      }
    } catch {
      // 文件损坏时重置，避免服务起不来
      this.data = [];
      try { writeAtomic(this.data); } catch {}
    }
  }

  private save() {
    try {
      writeAtomic(this.data);
    } catch {}
  }

  add(task: PersistedTask) {
    this.data = this.data.filter((t) => t.taskId !== task.taskId);
    this.data.push(task);
    // 只保留最近 100 条
    if (this.data.length > 100) {
      this.data = this.data.slice(-100);
    }
    this.save();
  }

  remove(taskId: string) {
    this.data = this.data.filter((t) => t.taskId !== taskId);
    this.save();
  }

  get(taskId: string): PersistedTask | undefined {
    return this.data.find((t) => t.taskId === taskId);
  }

  /** 自动重试计数 +1（不改变 status） */
  bumpAttempts(taskId: string) {
    const t = this.get(taskId);
    if (!t) return;
    t.attempts = (t.attempts || 0) + 1;
    this.save();
  }

  getAll(): PersistedTask[] {
    return [...this.data];
  }

  /** 恢复时需要重启的任务 */
  getRecoverable(): PersistedTask[] {
    return this.data.filter(
      (t) => t.status === "running" || t.status === "queued"
    );
  }
}

export const taskStore = new TaskStore();
