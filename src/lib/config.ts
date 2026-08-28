/**
 * 集中配置（稳定性 P1）。
 *
 * 三级取值：管理后台设置（settings 表）> 环境变量 > 默认值。
 * 为避免与 settings.ts（依赖 db）循环依赖，本模块不直接 import settings，
 * 而是由 settings.ts 在加载时通过 registerSettingsGetter 注入读取函数。
 *
 * 环境变量（兜底）：
 *   OUTPUT_BASE / AGENT_HOME / CHROME_PATH
 *   AGENT_TIMEOUT_MINUTES / STYLE_TIMEOUT_MINUTES
 */
import { join, resolve } from "path";
import { homedir } from "os";

export const AGENT_HOME = process.env.AGENT_HOME || homedir() || "/Users/eric";

const DEFAULT_OUTPUT_BASE = resolve(join(AGENT_HOME, "Downloads", "aplus-builder"));

export const OUTPUT_BASE = resolve(
  process.env.OUTPUT_BASE || DEFAULT_OUTPUT_BASE,
);

/** settings.ts 注入的动态读取器（key -> 字符串值，仅覆盖已入库的设置） */
type DynGetter = (key: string) => string | undefined;
let dyn: DynGetter | null = null;

export function registerSettingsGetter(fn: DynGetter) {
  dyn = fn;
}

function dynValue(key: string): string | undefined {
  return dyn ? dyn(key) : undefined;
}

/** 产出根目录（管理后台可改，改后新任务写入新目录） */
export function getOutputBase(): string {
  return resolve(dynValue("outputBase") || process.env.OUTPUT_BASE || DEFAULT_OUTPUT_BASE);
}

/** Agent 进程 HOME/cwd */
export function getAgentHome(): string {
  return dynValue("agentHome") || process.env.AGENT_HOME || AGENT_HOME;
}

/** Chrome 可执行文件路径 */
export function getChromePath(): string {
  return (
    dynValue("chromePath") ||
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  );
}

/** 生图 Agent 总超时（ms） */
export function getAgentTimeoutMs(): number {
  const m = parseInt(dynValue("agentTimeoutMinutes") || process.env.AGENT_TIMEOUT_MINUTES || "20", 10);
  return (Number.isFinite(m) && m > 0 ? m : 20) * 60 * 1000;
}

/** 风格复刻 Agent 总超时（ms） */
export function getStyleTimeoutMs(): number {
  const m = parseInt(dynValue("styleTimeoutMinutes") || process.env.STYLE_TIMEOUT_MINUTES || "10", 10);
  return (Number.isFinite(m) && m > 0 ? m : 10) * 60 * 1000;
}

/** 每用户数据根目录：admin（本地默认用户）沿用旧布局，其余用户隔离到子目录 */
export function userBase(userId: string): string {
  const base = getOutputBase();
  return userId && userId !== "admin" ? join(base, userId) : base;
}
