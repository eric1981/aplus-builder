/**
 * 平台适配层（跨平台：macOS 本地开发 + Linux / 华为云 ECS 生产）
 *
 * 背景：项目里原先散落着 macOS 假设，它们在 Linux 上表现为**静默失败**：
 *   - `getChromePath()` 兜底 `/Applications/Google Chrome.app/...` → 截图全挂，只有一行 warn；
 *   - 产出根目录默认 `~/Downloads/aplus-builder` → Linux 上写进系统盘（部署文档要求放数据盘）；
 *   - 可执行文件探测依赖 `which`、端口检测依赖 `lsof` → Ubuntu 最小安装不一定有。
 *
 * 这里把平台判断收口到一处：
 *   - **macOS 行为与改造前完全一致**（Chrome 首选路径、产出默认目录都不变）；
 *   - Linux 走各自的候选列表与标准路径；
 *   - 所有探测都是"找到就用，找不到给兜底值"，绝不抛异常。
 *
 * 注意：本模块依赖 fs/os/path，只能在服务端（Node runtime）引入。
 * 现有引用方 `lib/config.ts` 本身已是服务端模块，因此不会污染客户端 bundle。
 */
import { existsSync, statSync } from "fs";
import { delimiter, join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";

export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function homeDir(): string {
  try {
    return homedir() || "";
  } catch {
    return "";
  }
}

/** 可执行文件判定（存在 + 有执行位；失败一律 false，不抛异常） */
export function isExecutable(p: string): boolean {
  try {
    if (!p || !existsSync(p)) return false;
    return (statSync(p).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * 平台标准 PATH。
 * 用途：进程 PATH 缺失时的兜底（systemd 直接拉起、或环境被清空）——否则 agent
 * 子进程里的 `python3` / `ffmpeg` / `curl` 全部找不到。
 */
export function defaultPath(): string {
  const parts = IS_MAC
    ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    : ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
  const h = homeDir();
  if (h) parts.push(join(h, ".local", "bin"));
  return parts.join(delimiter);
}

/**
 * 保证 PATH 中含 `<home>/.local/bin`（hermes 的软链常放在这里）。
 * 已存在则不重复追加；保持原有顺序，只做追加，不改变既有解析优先级。
 */
export function ensureLocalBinInPath(pathValue: string, h: string): string {
  const parts = (pathValue || "").split(delimiter).filter(Boolean);
  if (h) {
    const localBin = join(h, ".local", "bin");
    if (!parts.includes(localBin)) parts.push(localBin);
  }
  return parts.join(delimiter);
}

/**
 * 在 PATH 中查找可执行文件并返回绝对路径（找不到返回 null）。
 * 不依赖 `which` / `where`，也不 spawn 子进程；PATH 为空时用 defaultPath() 兜底。
 */
export function findInPath(bin: string): string | null {
  if (!bin) return null;
  if (bin.includes("/") || bin.includes("\\")) return isExecutable(bin) ? bin : null;
  const raw = process.env.PATH && process.env.PATH.trim() ? process.env.PATH : defaultPath();
  for (const dir of raw.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (isExecutable(p)) return p;
  }
  return null;
}

/** Chrome/Chromium 候选列表（按"最可能"排序：固定安装路径 → PATH 里的命令名） */
function chromeCandidates(): string[] {
  const h = homeDir();
  const fixed = IS_MAC
    ? [
        MAC_CHROME,
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        h ? join(h, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome") : "",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/opt/google/chrome/chrome",
        "/usr/lib/chromium/chromium",
      ];
  const names = IS_MAC
    ? ["chromium", "google-chrome"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  return [...fixed, ...names.map((n) => findInPath(n) || "")].filter(Boolean);
}

/** 一个都没探测到时返回的平台常见名（让 spawn 抛 ENOENT 而不是空字符串） */
export function chromeFallbackName(): string {
  return IS_MAC ? MAC_CHROME : "google-chrome";
}

let chromeCache: string | null = null;
let chromeWarned = false;

/**
 * 探测 Chrome/Chromium 可执行文件。
 * - 命中即缓存（同一台机器上 Chrome 路径不会中途变化）；
 * - 未命中**不缓存**，装完 Chrome 后无需重启进程即可生效；
 * - 未命中只 warn 一次，避免每个截图任务刷一行日志。
 */
export function defaultChromePath(): string {
  if (chromeCache) return chromeCache;
  const candidates = chromeCandidates();
  for (const c of candidates) {
    if (isExecutable(c)) {
      chromeCache = c;
      return c;
    }
  }
  if (!chromeWarned) {
    chromeWarned = true;
    console.warn(
      `[platform] 未找到 Chrome/Chromium，截图（画廊样张/模板缩略图）会失败。` +
        `已尝试：${candidates.join(" | ")}。请安装 Chrome/Chromium，或用 CHROME_PATH 指定路径。`,
    );
  }
  return chromeFallbackName();
}

/**
 * 产出根目录默认值（未显式配置 OUTPUT_BASE 时使用）。
 * - macOS：`~/Downloads/aplus-builder` —— **与改造前一致**，不动本地习惯；
 * - Linux：优先数据盘 `/data/aplus-builder`（ECS 上产出图体积最大，应落 EVS 数据盘），
 *   没有 `/data`（如容器/普通 VM）时退回家目录下的 `aplus-builder-output`。
 *
 * 生产环境仍建议在 `.env.local` 显式设置 OUTPUT_BASE（见 `.env.local.example`）。
 */
export function defaultOutputBase(agentHome: string): string {
  if (IS_MAC) return join(agentHome, "Downloads", "aplus-builder");
  const dataDisk = process.env.APLUS_DATA_DISK || "/data";
  if (existsSync(dataDisk)) return join(dataDisk, "aplus-builder");
  return join(agentHome, "aplus-builder-output");
}

/**
 * 本地文件 → file:// URL。
 * Chrome 截图时用：产出目录名是中文产品名，直接拼 `file://${path}` 在含空格/特殊字符时
 * 会生成非法 URL（macOS 上 Chrome 常常容忍，Linux 上不保证）。
 */
export function fileUrl(p: string): string {
  return pathToFileURL(p).href;
}
