/**
 * Chrome 无头截图（稳定性 P1）：
 * - 由同步 spawnSync 改为异步 spawn，不再阻塞 Node 事件循环
 * - 全局并发限制（设置中心 maxScreenshotConcurrent，默认 2），截图任务排队执行
 */
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getChromePath } from "./config";
import { getSettingInt } from "./settings";

export interface ScreenshotJob {
  /** 本地 HTML 文件绝对路径（file:// 打开） */
  htmlPath: string;
  /** 输出 PNG 路径 */
  destPath: string;
}

let active = 0;
const jobs: { job: ScreenshotJob; resolve: (ok: boolean) => void }[] = [];

function maxConcurrent(): number {
  return getSettingInt("maxScreenshotConcurrent", 2) || 1;
}

function run(job: ScreenshotJob): Promise<boolean> {
  return new Promise((resolve) => {
    // 独立 profile 目录（修复实机截图失败）：
    // 不给 --user-data-dir 时，headless Chrome 会尝试自动创建临时 profile 并失败
    // （实测报 "Failed to create a unique user data directory for headless."），
    // 导致画廊截图 / 模板缩略图全部失败；同时独立目录也避免与用户正在运行的
    // Chrome 抢默认 profile、以及并发任务之间互相干扰。
    let profileDir = "";
    try {
      profileDir = mkdtempSync(join(tmpdir(), "aplus-chrome-"));
    } catch {}

    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
      `--screenshot=${job.destPath}`,
      "--window-size=450,800",
      `file://${job.htmlPath}`,
    ];

    const cleanup = () => {
      if (!profileDir) return;
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {}
    };

    const child = spawn(getChromePath(), args, { stdio: "ignore", timeout: 15_000 });
    child.on("error", () => {
      cleanup();
      resolve(false);
    });
    child.on("close", (code) => {
      cleanup();
      resolve(code === 0);
    });
  });
}

/** 提交一个截图任务（不阻塞调用方），返回是否成功 */
export function screenshotPage(job: ScreenshotJob): Promise<boolean> {
  return new Promise((resolve) => {
    jobs.push({ job, resolve });
    pump();
  });
}

function pump() {
  const cap = maxConcurrent();
  while (active < cap && jobs.length > 0) {
    const { job, resolve } = jobs.shift()!;
    active++;
    run(job).then((ok) => {
      active--;
      resolve(ok);
      pump();
    });
  }
}
