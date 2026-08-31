/**
 * 运行时配置中心（管理后台可改，存 SQLite settings 表，环境变量兜底）。
 *
 * - 设置项由 SETTING_DEFS 注册表定义，管理后台据此渲染表单
 * - 读取顺序：DB（管理后台已改）> 环境变量 > 默认值
 * - 内存缓存，setSetting 时失效
 * - 路径类（outputBase/agentHome/chromePath）为部署级配置：仅环境变量生效，
 *   后台只读展示（运行时修改路径会破坏既有数据的目录映射）
 */
import { db } from "@/lib/db";
import { registerSettingsGetter } from "@/lib/config";

export interface SettingDef {
  key: string;
  label: string;
  group: "quota" | "concurrency" | "agent" | "upload" | "system" | "auth";
  type: "number" | "boolean" | "select";
  options?: string[];
  env?: string;
  /** 默认值 */
  default: string | number | boolean;
  unit?: string;
  restartRequired?: boolean;
  description?: string;
}

export const SETTING_DEFS: SettingDef[] = [
  // 配额
  { key: "maxDailyTasks", label: "每日任务配额（全局）", group: "quota", type: "number", env: "MAX_DAILY_TASKS", default: 200, unit: "个/天" },
  { key: "maxMonthlyTasks", label: "每月任务配额（全局）", group: "quota", type: "number", env: "MAX_MONTHLY_TASKS", default: 2000, unit: "个/月" },
  // 并发与队列
  { key: "maxConcurrent", label: "生图 Agent 并发数", group: "concurrency", type: "number", env: "MAX_CONCURRENT", default: 2, unit: "个" },
  { key: "maxQueue", label: "生成任务排队上限", group: "concurrency", type: "number", env: "MAX_QUEUE", default: 20, unit: "个", description: "队列满返回 429" },
  { key: "maxAgentAttempts", label: "Agent 失败自动重试上限", group: "concurrency", type: "number", env: "MAX_AGENT_ATTEMPTS", default: 2, unit: "次", description: "含首次启动" },
  { key: "maxStyleConcurrent", label: "风格复刻并发上限", group: "concurrency", type: "number", env: "MAX_STYLE_CONCURRENT", default: 2, unit: "个" },
  { key: "maxScreenshotConcurrent", label: "Chrome 截图并发上限", group: "concurrency", type: "number", env: "MAX_SCREENSHOT_CONCURRENT", default: 2, unit: "个" },
  { key: "maxAnalysisConcurrent", label: "市场分析并发上限", group: "concurrency", type: "number", env: "MAX_ANALYSIS_CONCURRENT", default: 2, unit: "个", description: "与生图并行，不占生成队列" },
  { key: "rateLimitPerMinute", label: "昂贵接口每分钟限次", group: "concurrency", type: "number", env: "RATE_LIMIT_PER_MINUTE", default: 30, unit: "次/分", description: "生成/风格复刻/截图等接口的限流" },
  // Agent
  { key: "agentSource", label: "Agent 联网（--source web）", group: "agent", type: "boolean", env: "AGENT_SOURCE", default: true, description: "关闭后 agent 不联网抓取" },
  { key: "agentTimeoutMinutes", label: "生图 Agent 超时", group: "agent", type: "number", env: "AGENT_TIMEOUT_MINUTES", default: 20, unit: "分钟" },
  { key: "styleTimeoutMinutes", label: "风格复刻超时", group: "agent", type: "number", env: "STYLE_TIMEOUT_MINUTES", default: 10, unit: "分钟" },
  { key: "analysisTimeoutMinutes", label: "市场分析超时", group: "agent", type: "number", env: "ANALYSIS_TIMEOUT_MINUTES", default: 10, unit: "分钟" },
  // 上传
  { key: "maxUploadMb", label: "单文件上传上限", group: "upload", type: "number", env: "MAX_UPLOAD_MB", default: 15, unit: "MB" },
  // 登录与安全
  { key: "trustLocalhost", label: "本机免登录（localhost = admin）", group: "auth", type: "boolean", env: "TRUST_LOCALHOST", default: false, description: "默认关闭：本机也要求登录，可完整测试登录系统；开启后本机免登录" },
  // 系统（部署级，仅环境变量生效，后台只读展示）
  { key: "outputBase", label: "产出根目录 OUTPUT_BASE", group: "system", type: "select", options: [], env: "OUTPUT_BASE", default: "", restartRequired: true, description: "部署级路径，仅环境变量生效" },
  { key: "agentHome", label: "Agent 工作目录 AGENT_HOME", group: "system", type: "select", options: [], env: "AGENT_HOME", default: "", restartRequired: true, description: "部署级路径，仅环境变量生效" },
  { key: "chromePath", label: "Chrome 路径 CHROME_PATH", group: "system", type: "select", options: [], env: "CHROME_PATH", default: "", restartRequired: true, description: "部署级路径，仅环境变量生效" },
];

const SETTING_MAP = new Map(SETTING_DEFS.map((d) => [d.key, d]));

let cache: Record<string, string> | null = null;

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function loadAll(): Record<string, string> {
  if (cache) return cache;
  try {
    const rows = db
      .prepare(`SELECT key, value FROM settings`)
      .all() as { key: string; value: string }[];
    cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    cache = {};
  }
  return cache;
}

export function invalidateSettings() {
  cache = null;
}

/** 读取原始字符串值：DB > 环境变量 > 默认 */
export function getSetting(key: string): string {
  const def = SETTING_MAP.get(key);
  if (!def) return "";
  const fromDb = loadAll()[key];
  if (fromDb !== undefined) return fromDb;
  if (def.env && process.env[def.env] !== undefined) return process.env[def.env]!;
  return String(def.default);
}

export function getSettingInt(key: string, fallback = 0): number {
  const v = parseInt(getSetting(key), 10);
  return Number.isFinite(v) ? v : fallback;
}

export function getSettingBool(key: string): boolean {
  const v = getSetting(key).toLowerCase();
  return !(v === "false" || v === "0" || v === "none" || v === "no");
}

/** 写入设置（DB + 缓存失效） */
export function setSetting(key: string, value: string): void {
  if (!SETTING_MAP.has(key)) return;
  ensureTable();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
  invalidateSettings();
}

/** 管理后台视图：注册表 + 当前值（含默认/环境来源说明） */
export function listSettingsView(): (SettingDef & { value: string; source: "db" | "env" | "default" })[] {
  const all = loadAll();
  return SETTING_DEFS.map((d) => {
    let value = getSetting(d.key);
    let source: "db" | "env" | "default" = "default";
    if (all[d.key] !== undefined) source = "db";
    else if (d.env && process.env[d.env] !== undefined) source = "env";
    return { ...d, value, source };
  });
}

export function getSettingDef(key: string): SettingDef | undefined {
  return SETTING_MAP.get(key);
}

// 模块加载时确保表存在，并向 config 注册动态读取器
ensureTable();
registerSettingsGetter((key) => loadAll()[key]);
