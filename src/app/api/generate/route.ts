import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, appendFileSync, readdirSync } from "fs";
import { join, extname } from "path";
import { randomUUID } from "crypto";

type TaskImage = { name: string; base64: string; mime: string };
type Task = {
  status: "running" | "done" | "error";
  html?: string;
  images?: TaskImage[];
  preference_signal?: string;
  error?: string;
  log?: string;
};

const tasks = new Map<string, Task>();
const AGENT_TIMEOUT = 10 * 60 * 1000;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MIME_MAP: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export async function POST(request: NextRequest) {
  const taskId = randomUUID();
  const workDir = join("/tmp", "ecommerce", taskId);
  const inputDir = join(workDir, "input");
  const outputDir = join(workDir, "output");
  const indexHtml = join(outputDir, "index.html");
  const manifestPath = join(outputDir, "image-manifest.json");
  const promptFile = join(workDir, "prompt.txt");
  const logFile = join(workDir, "agent.log");

  try {
    const formData = await request.formData();

    let imgPath = "";
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("image_") && value instanceof Blob) {
        mkdirSync(inputDir, { recursive: true });
        mkdirSync(outputDir, { recursive: true });
        const buffer = Buffer.from(await value.arrayBuffer());
        const ext = value.type === "image/png" ? "png" : "jpg";
        imgPath = join(inputDir, `product.${ext}`);
        writeFileSync(imgPath, buffer);
        break;
      }
    }

    if (!imgPath) {
      return NextResponse.json({ error: "请上传产品图片" }, { status: 400 });
    }

    const description = (formData.get("description") as string) || "";
    const profileContext = (formData.get("profile_context") as string) || "";

    // 解析用户 UI 显式偏好
    let uiPrefs: { style?: string; odStyle?: string; model?: string } = {};
    try {
      const raw = formData.get("preferences") as string;
      if (raw) uiPrefs = JSON.parse(raw);
    } catch {}

    // ---- prompt 组装：三级优先级 ----

    const prefLines: string[] = [];

    // 1. 显式选择（指令语气）
    if (uiPrefs.odStyle) {
      prefLines.push(`- 排版风格：使用 Open Design 模板 "${uiPrefs.odStyle}"（用户指定，必须使用）`);
    } else if (uiPrefs.style && uiPrefs.style !== "auto") {
      const styleLabel: Record<string, string> = {
        "editorial": "Editorial 暖杂志风", "swiss": "Swiss 瑞士风",
        "product-launch": "Product Launch 暗底Hero风", "xhs-pastel": "小红书 Pastel 马卡龙风",
        "amazon-premium": "Amazon Premium A+ 原生风",
      };
      prefLines.push(`- 排版风格：${styleLabel[uiPrefs.style] || uiPrefs.style}（用户指定，必须使用）`);
    }
    if (uiPrefs.model && uiPrefs.model !== "auto") {
      const modelLabel: Record<string, string> = { "east-asian": "东亚", "european": "欧美", "middle-eastern": "中东/混血" };
      prefLines.push(`- 模特：${modelLabel[uiPrefs.model] || uiPrefs.model}（用户指定，必须使用）`);
    }

    // 2. 画像推断（参考语气）
    if (profileContext) {
      prefLines.push(`\n【用户偏好画像 — 基于历史生成记录，作为参考而非强制】`);
      prefLines.push(profileContext);
    }

    // 3. 啥也没有 → skill 自决

    const descBlock = description.trim()
      ? `\n产品信息：${description}\n`
      : "\n（用户未提供描述，请根据产品图自行分析品类、面料、风格并生成详情页）\n";

    const prompt = [
      `帮我生成这个产品的电商详情页。`,
      ``,
      `产品图：${imgPath}`,
      descBlock,
      ...(prefLines.length > 0 ? [`偏好参考：`, ...prefLines, ``] : []),
      `【重要规则】`,
      `- 不要使用 clarify 询问我任何问题，自己决定所有选择。`,
      `- 把最终产出物（index.html、图片、manifest）全部放到 ${outputDir}/ 下面，不要放到 Downloads。`,
      `- HTML 里的图片使用相对路径（如 ./scene_01.png）。`,
      `- 生成完成后直接写入 index.html，不要无限迭代优化。`,
      `- 在 image-manifest.json 中记录每张图使用的 prompt。`,
    ].join("\n");

    writeFileSync(promptFile, prompt, "utf-8");

    const script = [
      `#!/bin/bash`,
      `set -eo pipefail`,
      `cd /Users/eric`,
      `hermes -p duma -s ecommerce-aplus-detail chat \\`,
      `  -q "$(cat '${promptFile}')" \\`,
      `  --quiet --yolo --max-turns 60 --source web`,
    ].join("\n");
    const scriptPath = join(workDir, "run.sh");
    writeFileSync(scriptPath, script, { mode: 0o755 });

    tasks.set(taskId, { status: "running", log: "" });

    const child = spawn("/bin/bash", [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/Users/eric" },
      cwd: "/Users/eric",
    });

    let logBuffer = "";
    let settled = false;

    const finalize = (status: "done" | "error", html?: string, errMsg?: string, images?: TaskImage[], signal?: string) => {
      if (settled) return;
      settled = true;
      tasks.set(taskId, { status, html, images, preference_signal: signal, error: errMsg, log: logBuffer.slice(-5000) });
    };

    const collectAndFinish = () => {
      if (!existsSync(indexHtml)) return false;

      try {
        const images = collectImages(outputDir);
        const signal = extractPreferenceSignal(manifestPath);

        const raw = readFileSync(indexHtml, "utf-8");
        let html = raw.replace(/^```html?\s*\n?/i, "").replace(/\n?```\s*$/, "");
        const endIdx = html.lastIndexOf("</html>");
        if (endIdx !== -1) html = html.substring(0, endIdx + 7);
        html = embedImages(html, outputDir);

        finalize("done", html, undefined, images, signal);
        console.log(`[hermes-cli] ✅ HTML ${html.length} chars, ${images.length} images, signal: ${signal?.slice(0, 80)}`);
        return true;
      } catch (e: any) {
        finalize("error", undefined, e.message);
        return false;
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!collectAndFinish()) {
        finalize("error", undefined, "Agent 超时，未产出 index.html");
      }
      safeCleanup(workDir);
    }, AGENT_TIMEOUT);

    child.stdout.on("data", (data: Buffer) => {
      logBuffer += data.toString();
      appendFileSync(logFile, data);
    });

    child.stderr.on("data", (data: Buffer) => {
      logBuffer += data.toString();
      appendFileSync(logFile, data);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      console.log(`[hermes-cli] Task ${taskId} exited code=${code}`);
      if (collectAndFinish()) { safeCleanup(workDir); return; }
      const htmlMatch = logBuffer.match(/```html?\s*\n?([\s\S]*?)```/);
      if (htmlMatch) { finalize("done", htmlMatch[1].trim()); }
      else { finalize("error", undefined, `Agent 退出码 ${code}，未产出 index.html`); }
      safeCleanup(workDir);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finalize("error", undefined, err.message);
      safeCleanup(workDir);
    });

    return NextResponse.json({ taskId });
  } catch (error: any) {
    rmSync(workDir, { recursive: true, force: true });
    return NextResponse.json({ error: error.message || "启动失败" }, { status: 500 });
  }
}

// ===== 轮询 =====

export async function GET(request: NextRequest) {
  const taskId = request.nextUrl.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
  const task = tasks.get(taskId);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (tasks.size > 100) {
    const keys = [...tasks.keys()];
    for (let i = 0; i < keys.length - 100; i++) tasks.delete(keys[i]);
  }
  return NextResponse.json(task);
}

// ===== 偏好信号提取 =====

function extractPreferenceSignal(manifestPath: string): string | undefined {
  try {
    if (!existsSync(manifestPath)) return undefined;
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);

    const entries = Array.isArray(manifest) ? manifest : manifest.images || manifest.entries || [];
    if (!entries.length) return undefined;

    // 从 prompt 中提取风格、模特、场景关键词
    const keywords = { style: new Set<string>(), model: new Set<string>(), scene: new Set<string>() };

    const stylePatterns: [RegExp, string][] = [
      [/editorial|暖杂志|衬线体|圆角卡/gi, "Editorial"],
      [/swiss|瑞士|无衬线|黑白灰|全直角/gi, "Swiss"],
      [/product.?launch|暗底|hero.*橙|爆品/gi, "Product Launch"],
      [/小红书|pastel|马卡龙|种草/gi, "小红书 Pastel"],
      [/amazon.*premium|全出血|文字蒙层|原生/gi, "Amazon Premium"],
    ];
    const modelPatterns: [RegExp, string][] = [
      [/东亚|east.?asian|asian.*model|韩系|日系/gi, "东亚"],
      [/欧美|european|caucasian|white.*model|blonde/gi, "欧美"],
      [/中东|middle.?east|arab|persian|混血/gi, "中东/混血"],
    ];
    const scenePatterns: [RegExp, string][] = [
      [/咖啡|cafe|café/gi, "咖啡厅"],
      [/街拍|street|urban|outdoor/gi, "街拍"],
      [/工作室|studio.*light|影棚/gi, "工作室"],
      [/自然|garden|park|outdoor.*nature/gi, "户外自然"],
      [/公寓|apartment|indoor|室内/gi, "室内"],
      [/建筑|architecture|楼/gi, "建筑"],
      [/海滩|beach|海边/gi, "海滩"],
    ];

    for (const entry of entries) {
      const prompt = (entry.prompt || entry.description || "").toLowerCase();
      for (const [re, label] of stylePatterns) if (re.test(prompt)) keywords.style.add(label);
      for (const [re, label] of modelPatterns) if (re.test(prompt)) keywords.model.add(label);
      for (const [re, label] of scenePatterns) if (re.test(prompt)) keywords.scene.add(label);
    }

    const parts: string[] = [];
    if (keywords.style.size > 0) parts.push(`风格: ${[...keywords.style].join("/")}`);
    if (keywords.model.size > 0) parts.push(`模特: ${[...keywords.model].join("/")}`);
    if (keywords.scene.size > 0) parts.push(`场景: ${[...keywords.scene].join("/")}`);

    return parts.length > 0 ? parts.join("; ") : undefined;
  } catch {
    return undefined;
  }
}

// ===== 工具 =====

function collectImages(dir: string): TaskImage[] {
  const results: TaskImage[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const ext = extname(name).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      try {
        const data = readFileSync(join(dir, name));
        results.push({ name, base64: data.toString("base64"), mime: MIME_MAP[ext] || "image/jpeg" });
      } catch {}
    }
  } catch {}
  return results;
}

function embedImages(html: string, baseDir: string): string {
  return html.replace(/src="([^"]+)"/g, (match, src: string) => {
    if (src.startsWith("http") || src.startsWith("data:")) return match;
    let imgPath: string;
    if (src.startsWith("./")) imgPath = join(baseDir, src.slice(2));
    else if (src.startsWith("../")) imgPath = join(baseDir, "..", src.slice(3));
    else imgPath = join(baseDir, src);
    if (!existsSync(imgPath)) return match;
    try {
      const data = readFileSync(imgPath);
      const ext = imgPath.split(".").pop()?.toLowerCase() || "jpg";
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      return `src="data:${mime};base64,${data.toString("base64")}"`;
    } catch { return match; }
  });
}

function safeCleanup(workDir: string) {
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
