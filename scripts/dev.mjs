#!/usr/bin/env node
/**
 * 一键启动脚本：处理端口占用，清理旧进程，启动 Next.js dev server。
 *
 * 用法：npm start  或  npm run dev
 */

import { execSync, spawn } from "child_process";

const PORT = 3000;

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`\x1b[2m[${ts}]\x1b[0m \x1b[36maplus-builder\x1b[0m ${msg}`);
}

function logOk(msg) { console.log(`  \x1b[32m✔\x1b[0m ${msg}`); }
function logWarn(msg) { console.log(`  \x1b[33m⚠\x1b[0m ${msg}`); }
function logInfo(msg) { console.log(`  \x1b[34mℹ\x1b[0m ${msg}`); }

// ---- Step 1: 检查并清理端口 ----
log("检查端口占用…");

let pids;
try {
  pids = execSync(`lsof -ti:${PORT}`, { encoding: "utf-8" }).trim();
} catch {
  pids = "";
}

if (pids) {
  const pidList = pids.split("\n").filter(Boolean);
  logWarn(`端口 ${PORT} 被占用 (PID: ${pidList.join(", ")})，正在释放…`);

  // SIGTERM 优雅终止
  for (const pid of pidList) {
    try { process.kill(Number(pid), "SIGTERM"); } catch {}
  }

  // 等待 2 秒，若还在则 SIGKILL
  await new Promise((r) => setTimeout(r, 2000));

  for (const pid of pidList) {
    try {
      process.kill(Number(pid), 0); // 检查是否存活
      process.kill(Number(pid), "SIGKILL");
      logWarn(`强制终止 PID ${pid}`);
    } catch {}
  }

  await new Promise((r) => setTimeout(r, 1000));
  logOk("端口已释放");
} else {
  logOk("端口空闲");
}

// ---- Step 2: 启动 Next.js ----
log(`启动 Next.js dev server (端口 ${PORT})…`);

const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  stdio: "inherit",
  env: { ...process.env },
  shell: true,
});

child.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.log(`\n\x1b[31mNext.js 异常退出 (code=${code})\x1b[0m`);
  }
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  log("正在关闭…");
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
