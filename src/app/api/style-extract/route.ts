import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const TEMPLATES_DIR = join(process.cwd(), "customer-templates");
const TASK_TIMEOUT = 10 * 60 * 1000; // 10 分钟

type StyleTask = {
  status: "running" | "done" | "error";
  templateId?: string;
  html?: string;
  error?: string;
  log?: string;
};

const tasks = new Map<string, StyleTask>();

// ===== 读取 customer profile =====
function getCustomerProfile(customerId: string): { name?: string } | null {
  try {
    const profilePath = join(process.cwd(), "customers", customerId, "profile.json");
    if (!existsSync(profilePath)) return null;
    return JSON.parse(readFileSync(profilePath, "utf-8"));
  } catch {
    return null;
  }
}

// ===== POST：创建风格复刻任务 =====
export async function POST(request: NextRequest) {
  const taskId = randomUUID();

  try {
    const formData = await request.formData();
    const screenshot = formData.get("screenshot") as Blob | null;
    const requirements = (formData.get("requirements") as string) || "";
    const customerId = (formData.get("customer_id") as string) || "";

    if (!screenshot || typeof screenshot !== "object" || !("arrayBuffer" in screenshot)) {
      return NextResponse.json({ error: "请上传参考截图" }, { status: 400 });
    }

    // 保存截图
    mkdirSync(TEMPLATES_DIR, { recursive: true });
    const ext = screenshot.type === "image/png" ? "png" : "jpg";
    const screenshotPath = join(TEMPLATES_DIR, `${taskId}_ref.${ext}`);
    const buffer = Buffer.from(await screenshot.arrayBuffer());
    writeFileSync(screenshotPath, buffer);

    const outputPath = join(TEMPLATES_DIR, `${taskId}.html`);

    // 客户信息
    let customerHint = "";
    if (customerId) {
      const profile = getCustomerProfile(customerId);
      if (profile?.name) {
        customerHint = `\n这个模板将用于客户「${profile.name}」的后续生成。`;
      }
    }

    // 拼 prompt
    const prompt = [
      `请分析这张参考截图，复刻其设计风格并创建一个新的 A+ 风格模板。`,
      ``,
      `参考截图：${screenshotPath}`,
      ``,
      ...(requirements ? [`用户要求：${requirements}`] : []),
      ...(customerHint ? [customerHint] : []),
      ``,
      `请完成以下操作：`,
      `1. 视觉反推：分析截图的配色、字体、间距、排版、模块结构`,
      `2. 创建风格模板：构建完整可复用的 HTML/CSS 模板`,
      `3. 用刚刚创建的风格模板生成一个完整的 HTML 文件，需要的示例图片从 /Users/eric/Downloads/aplus-builder 目录获取`,
      `4. 将 HTML 文件保存到：${outputPath}`,
      ``,
      `【重要规则】`,
      `- 不要使用 clarify 询问我任何问题`,
      `- HTML 必须内联所有 CSS（不要外部文件）`,
      `- 图片用相对路径引用（如 ./example.jpg），不要用 data: 或 http: URL`,
      `- 模板要完整、可直接用于后续批量生成`,
    ].join("\n");

    const promptFile = join(TEMPLATES_DIR, `${taskId}_prompt.txt`);
    writeFileSync(promptFile, prompt);

    // 写 run.sh
    const script = [
      `#!/bin/bash`,
      `cd /Users/eric`,
      `~/.hermes/hermes-agent/venv/bin/hermes -p duma -s aplus-style-creator chat \\`,
      `  -q "$(cat '${promptFile}')" \\`,
      `  --quiet --yolo --max-turns 60 --source web`,
    ].join("\n");

    const scriptPath = join(TEMPLATES_DIR, `${taskId}_run.sh`);
    writeFileSync(scriptPath, script, { mode: 0o755 });

    // 启动 agent
    const logFile = join(TEMPLATES_DIR, `${taskId}_agent.log`);
    tasks.set(taskId, { status: "running", log: "" });

    let settled = false;
    let logBuffer = "";

    const child = spawn("/bin/bash", [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/Users/eric" },
      cwd: "/Users/eric",
    });

    child.stdout.on("data", (d: Buffer) => { logBuffer += d.toString(); appendFileSync(logFile, d); });
    child.stderr.on("data", (d: Buffer) => { logBuffer += d.toString(); appendFileSync(logFile, d); });

    const finalize = (status: "done" | "error", html?: string, errMsg?: string) => {
      if (settled) return;
      settled = true;
      tasks.set(taskId, { status, templateId: taskId, html, error: errMsg, log: logBuffer.slice(-5000) });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) finalize("error", undefined, "Agent 超时（10 分钟）");
    }, TASK_TIMEOUT);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (existsSync(outputPath)) {
        try {
          const html = readFileSync(outputPath, "utf-8");
          finalize("done", html);
        } catch (e: any) {
          finalize("error", undefined, `读取输出文件失败：${e.message}`);
        }
      } else {
        finalize("error", undefined, `Agent 退出码 ${code}，未生成模板文件`);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finalize("error", undefined, err.message);
    });

    return NextResponse.json({ taskId });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "启动失败" }, { status: 500 });
  }
}

// ===== GET：轮询状态 =====
export async function GET(request: NextRequest) {
  const taskId = request.nextUrl.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "Missing taskId" }, { status: 400 });

  const task = tasks.get(taskId);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  return NextResponse.json(task);
}
