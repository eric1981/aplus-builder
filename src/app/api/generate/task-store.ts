import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const STORE_PATH = join("/tmp", "ecommerce-tasks.json");

export interface PersistedTask {
  taskId: string;
  userId: string;
  status: "running" | "queued";
  workDir: string;
  createdAt: number;
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
      this.data = [];
    }
  }

  private save() {
    try {
      writeFileSync(STORE_PATH, JSON.stringify(this.data, null, 2), "utf-8");
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
