/**
 * 集中配置（稳定性 P1：路径/超时外置，全部可用环境变量覆盖）。
 *
 * 环境变量：
 *   OUTPUT_BASE      产出根目录（默认 ~/Downloads/aplus-builder）
 *   AGENT_HOME       Agent 进程的 HOME/cwd（默认 ~，即当前用户主目录）
 *   CHROME_PATH      Chrome 可执行文件路径（默认 macOS 路径）
 *   AGENT_TIMEOUT_MINUTES  生图 Agent 总超时（默认 20）
 *   STYLE_TIMEOUT_MINUTES  风格复刻 Agent 总超时（默认 10）
 */
import { join, resolve } from "path";
import { homedir } from "os";

export const AGENT_HOME = process.env.AGENT_HOME || homedir() || "/Users/eric";

export const OUTPUT_BASE = resolve(
  process.env.OUTPUT_BASE ||
    join(AGENT_HOME, "Downloads", "aplus-builder"),
);

export const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const AGENT_TIMEOUT_MS =
  (parseInt(process.env.AGENT_TIMEOUT_MINUTES || "20", 10) || 20) * 60 * 1000;

export const STYLE_TIMEOUT_MS =
  (parseInt(process.env.STYLE_TIMEOUT_MINUTES || "10", 10) || 10) * 60 * 1000;

/** 每用户数据根目录：admin（本地默认用户）沿用旧布局，其余用户隔离到子目录 */
export function userBase(userId: string): string {
  return userId && userId !== "admin" ? join(OUTPUT_BASE, userId) : OUTPUT_BASE;
}
