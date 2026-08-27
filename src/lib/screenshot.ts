/**
 * Chrome 无头截图（稳定性 P1）：
 * - 由同步 spawnSync 改为异步 spawn，不再阻塞 Node 事件循环
 * - 全局并发限制（MAX_SCREENSHOT_CONCURRENT，默认 2），截图任务排队执行
 */
import { spawn } from "child_process";
import { CHROME_PATH } from "./config";

export interface ScreenshotJob {
  /** 本地 HTML 文件绝对路径（file:// 打开） */
  htmlPath: string;
  /** 输出 PNG 路径 */
  destPath: string;
}

const MAX_CONCURRENT = parseInt(process.env.MAX_SCREENSHOT_CONCURRENT || "2", 10) || 1;

let active = 0;
const jobs: { job: ScreenshotJob; resolve: (ok: boolean) => void }[] = [];

function run(job: ScreenshotJob): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      CHROME_PATH,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        `--screenshot=${job.destPath}`,
        "--window-size=450,800",
        `file://${job.htmlPath}`,
      ],
      { stdio: "ignore", timeout: 15_000 },
    );
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
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
  while (active < MAX_CONCURRENT && jobs.length > 0) {
    const { job, resolve } = jobs.shift()!;
    active++;
    run(job).then((ok) => {
      active--;
      resolve(ok);
      pump();
    });
  }
}
