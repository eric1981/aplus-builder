#!/usr/bin/env node
/**
 * 一键启动脚本：处理端口占用，清理旧进程，启动 Next.js dev server。
 *
 * 用法：npm start  或  npm run dev
 */

import { execSync, spawn } from "child_process";

const PORT = Number(process.env.PORT) || 3000;

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`\x1b[2m[${ts}]\x1b[0m \x1b[36maplus-builder\x1b[0m ${msg}`);
}

function logOk(msg) { console.log(`  \x1b[32m✔\x1b[0m ${msg}`); }
function logWarn(msg) { console.log(`  \x1b[33m⚠\x1b[0m ${msg}`); }
function logInfo(msg) { console.log(`  \x1b[34mℹ\x1b[0m ${msg}`); }

/** 命令是否存在（用 `command -v`，macOS/Linux 的 /bin/sh 都支持） */
function hasCmd(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 查出监听指定端口的 PID（跨平台）。
 * 依次尝试：lsof（macOS 自带；Ubuntu 需 lsof 包）→ ss（iproute2，Ubuntu 默认）
 * → fuser（psmisc）。先判断命令是否存在，避免把"工具缺失"误判成"端口空闲"。
 * @returns {string[]|null} PID 数组；null 表示"无法判断"（三个工具都没有），
 *                          空数组表示"已确认没有监听"。
 */
function findListeners(port) {
  const capture = (cmd) => {
    try {
      return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return `${e?.stdout || ""}${e?.stderr || ""}`; // 非 0 退出（含"无匹配"）时仍取输出
    }
  };

  if (hasCmd("lsof")) {
    const out = capture(`lsof -ti:${port}`);
    const pids = [...new Set((out.match(/^\d+$/gm) || []).map((s) => s.trim()))];
    return pids; // lsof 存在且无匹配 = 端口确实空闲
  }

  if (hasCmd("ss")) {
    const out = capture(`ss -ltnpH "sport = :${port}"`);
    const pids = [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => m[1]))];
    if (!pids.length && out.trim()) {
      logWarn(`端口 ${PORT} 有监听但取不到 PID（可能需要 root）；next 启动时会报 EADDRINUSE`);
    }
    return pids;
  }

  if (hasCmd("fuser")) {
    const out = capture(`fuser -n tcp ${port}`);
    return [...new Set((out.match(/\d+/g) || []).filter((n) => Number(n) > 0))];
  }

  return null; // 无法判断
}

// ---- Step 1: 检查并清理端口 ----
log("检查端口占用…");

const pidList = findListeners(PORT);

if (pidList === null) {
  logInfo("未找到 lsof/ss/fuser，无法检查端口占用（若被占用，next 会自行报 EADDRINUSE）");
} else if (pidList.length) {
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
