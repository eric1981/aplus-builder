import { NextRequest, NextResponse } from "next/server";
import { spawn, spawnSync } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync, readdirSync } from "fs";
import { join, extname, dirname } from "path";
import { randomUUID } from "crypto";
import { taskStore, type PersistedTask } from "./task-store";

const OUTPUT_BASE = join("/Users", "eric", "Downloads", "aplus-builder");

function sanitizeProductName(description: string, taskId: string): string {
  const tid = taskId.slice(0, 8);
  if (!description.trim()) return `未命名产品-${tid}`;
  const cleaned = description.trim().slice(0, 40)
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, "-")
    .replace(/\s+/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const base = cleaned || "未命名产品";
  return `${base}-${tid}`;
}

type TaskImage = { name: string; base64: string; mime: string };
type Task = {
  status: "running" | "done" | "error" | "queued";
  html?: string;
  images?: TaskImage[];
  variants?: { name: string; html: string }[];
  preference_signal?: string;
  error?: string;
  log?: string;
  queuePosition?: number;
};

const tasks = new Map<string, Task>();
const AGENT_TIMEOUT = 20 * 60 * 1000;
const MAX_CONCURRENT = 2;

let activeCount = 0;
const queue: { taskId: string; startFn: () => void }[] = [];

function updateQueuePositions() {
  for (const { taskId } of queue) {
    const t = tasks.get(taskId);
    if (t) t.queuePosition = 1;
  }
}

function tryProcessQueue() {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift()!;
    activeCount++;
    next.startFn();
    updateQueuePositions();
  }
}

function releaseSlot() {
  activeCount = Math.max(0, activeCount - 1);
  tryProcessQueue();
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MIME_MAP: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

// ===== Agent 启动（被 POST 和 recovery 共用）=====

function spawnAgent(taskId: string, workDir: string, customTemplateId?: string) {
  const outputDir = join(workDir, "output");       // 客户交付物放 output/ 子目录
  const indexHtml = join(outputDir, "index.html");
  const manifestPath = join(workDir, "image-manifest.json");  // 元数据留根目录
  const logFile = join(workDir, "agent.log");
  const scriptPath = join(workDir, "run.sh");

  if (!existsSync(scriptPath)) {
    tasks.set(taskId, { status: "error", error: "恢复失败：缺少 run.sh", log: "" });
    taskStore.remove(taskId);
    releaseSlot();
    return;
  }

  tasks.set(taskId, { status: "running", log: "" });

  const child = spawn("/bin/bash", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: "/Users/eric" },
    cwd: "/Users/eric",
  });

  let logBuffer = "";
  let settled = false;

  const finalize = (status: "done" | "error", html?: string, errMsg?: string, images?: TaskImage[], signal?: string, variants?: { name: string; html: string }[]) => {
    if (settled) return;
    settled = true;
    tasks.set(taskId, { status, html, images, variants, preference_signal: signal, error: errMsg, log: logBuffer.slice(-5000) });
    taskStore.remove(taskId);
    releaseSlot();
  };

  const readAndEmbed = (filePath: string): string | null => {
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      let html = raw.replace(/^```html?\s*\n?/i, "").replace(/\n?```\s*$/, "");
      const endIdx = html.lastIndexOf("</html>");
      if (endIdx !== -1) html = html.substring(0, endIdx + 7);
      return embedImages(html, outputDir);
    } catch {
      return null;
    }
  };

  const collectAndFinish = () => {
    // 主路径 output/index.html，兼容旧路径根目录 index.html
    const actualIndex = existsSync(indexHtml) ? indexHtml
      : existsSync(join(workDir, "index.html")) ? join(workDir, "index.html")
      : null;
    if (!actualIndex) return false;
    const actualOutputDir = dirname(actualIndex);
    try {
      const images = collectImages(actualOutputDir);
      const signal = extractPreferenceSignal(manifestPath);
      const html = readAndEmbed(actualIndex);
      if (!html) throw new Error("Failed to read index.html");

      // 后端强制保护：用客户模板的原始内容覆盖 data-hermes-protected 元素
      let protectedHtml = html;
      if (customTemplateId) {
        const templatePath = join(process.cwd(), "customer-templates", `${customTemplateId}.html`);
        if (existsSync(templatePath)) {
          const tpl = readFileSync(templatePath, "utf-8");
          // 逐个提取模板中所有 data-hermes-protected 元素，覆盖到输出中
          const tplProtected = tpl.match(/<[^>]+data-hermes-protected="[^"]*"[^>]*>/g) || [];
          const outProtected = protectedHtml.match(/<[^>]+data-hermes-protected="[^"]*"[^>]*>/g) || [];
          for (let i = 0; i < Math.min(tplProtected.length, outProtected.length); i++) {
            protectedHtml = protectedHtml.replace(outProtected[i], tplProtected[i]);
          }
          console.log(`[hermes-cli] 🔒 已保护 ${Math.min(tplProtected.length, outProtected.length)} 个标记元素`);
        }
      }

      const variants: { name: string; html: string }[] = [];
      const STYLE_NAMES = ["Swiss 瑞士风", "Product Launch 暗底Hero风", "Editorial 暖杂志风"];
      for (let i = 1; i <= 3; i++) {
        const vPath = join(outputDir, `variant_${i}.html`);
        const vHtml = readAndEmbed(vPath);
        if (vHtml) variants.push({ name: STYLE_NAMES[i - 1] || `变体 ${i}`, html: vHtml });
      }

      finalize("done", protectedHtml, undefined, images, signal, variants.length > 0 ? variants : undefined);
      console.log(`[hermes-cli] ✅ HTML ${protectedHtml.length} chars, ${images.length} images, ${variants.length} variants`);

      captureGalleryScreenshots(outputDir);
      return true;
    } catch (e: any) {
      finalize("error", undefined, e.message);
      return false;
    }
  };

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    if (!collectAndFinish()) finalize("error", undefined, "Agent 超时");
  }, AGENT_TIMEOUT);

  child.stdout.on("data", (data: Buffer) => { logBuffer += data.toString(); appendFileSync(logFile, data); });
  child.stderr.on("data", (data: Buffer) => { logBuffer += data.toString(); appendFileSync(logFile, data); });

  child.on("close", (code) => {
    clearTimeout(timer);
    console.log(`[hermes-cli] Task ${taskId} exited code=${code}`);
    if (collectAndFinish()) return;
    const htmlMatch = logBuffer.match(/```html?\s*\n?([\s\S]*?)```/);
    if (htmlMatch) { finalize("done", htmlMatch[1].trim()); }
    else { finalize("error", undefined, `Agent 退出码 ${code}`); }
  });

  child.on("error", (err) => { clearTimeout(timer); finalize("error", undefined, err.message); });
}

// ===== POST：创建任务 =====

export async function POST(request: NextRequest) {
  const taskId = randomUUID();

  try {
    const formData = await request.formData();

    let imgPath = "";
    let modelRefPath = "";
    let logoPath = "";

    // 先取 description 和 product_name 用于目录命名
    const description = (formData.get("description") as string) || "";
    const productNameInput = (formData.get("product_name") as string) || "";
    const customerName = (formData.get("customer_name") as string) || "";

    const productDir = sanitizeProductName(productNameInput || description, taskId);

    // 客户名安全化（跟 sanitizeProductName 逻辑一致但不需要 taskId fallback）
    const customerDir = customerName
      ? customerName.trim().slice(0, 20)
          .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, "-")
          .replace(/\s+/g, "-").replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
      : "";

    const workDir = customerDir
      ? join(OUTPUT_BASE, customerDir, productDir)
      : join(OUTPUT_BASE, productDir);
    const inputDir = join(workDir, "input");
    const outputDir = workDir;
    const promptFile = join(workDir, "prompt.txt");

    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    // 逐项提取文件（不用 entries() 遍历，避免 Blob instanceof 不可靠）
    const modelImage = formData.get("model_image_0");
    if (modelImage && typeof modelImage === "object" && "arrayBuffer" in modelImage) {
      const blob = modelImage as Blob;
      const buffer = Buffer.from(await blob.arrayBuffer());
      const ext = blob.type === "image/png" ? "png" : "jpg";
      modelRefPath = join(inputDir, `model_ref.${ext}`);
      writeFileSync(modelRefPath, buffer);
    }

    const logoImage = formData.get("logo_image_0");
    if (logoImage && typeof logoImage === "object" && "arrayBuffer" in logoImage) {
      const blob = logoImage as Blob;
      const buffer = Buffer.from(await blob.arrayBuffer());
      const ext = blob.type === "image/png" ? "png" : "jpg";
      logoPath = join(outputDir, `logo.${ext}`);
      writeFileSync(logoPath, buffer);
    }

    const productImage = formData.get("image_0");
    if (productImage && typeof productImage === "object" && "arrayBuffer" in productImage) {
      const blob = productImage as Blob;
      const buffer = Buffer.from(await blob.arrayBuffer());
      const ext = blob.type === "image/png" ? "png" : "jpg";
      imgPath = join(inputDir, `product.${ext}`);
      writeFileSync(imgPath, buffer);
    }

    if (!imgPath) {
      return NextResponse.json({ error: "请上传产品图片" }, { status: 400 });
    }

    const profileContext = (formData.get("profile_context") as string) || "";

    // 客户数据
    const customerId = (formData.get("customer_id") as string) || "";
    const customerSizeChart = (formData.get("customer_size_chart") as string) || "";
    const customerRequirements = (formData.get("customer_requirements") as string) || "";
    const customTemplateId = (formData.get("custom_template_id") as string) || "";

    let uiPrefs: { style?: string; odStyle?: string; model?: string } = {};
    try {
      const raw = formData.get("preferences") as string;
      if (raw) uiPrefs = JSON.parse(raw);
    } catch {}

    // ---- prompt 组装 ----
    const prefLines: string[] = [];

    // 客户自定义风格模板优先级最高
    if (customTemplateId) {
      const templatePath = join(process.cwd(), "customer-templates", `${customTemplateId}.html`);
      prefLines.push(`- 排版风格：使用客户自定义模板 \"${templatePath}\"（必须严格参考此模板的视觉风格、配色、字体、模块结构来生成详情页）`);
    } else if (uiPrefs.odStyle) {
      prefLines.push(`- 排版风格：使用 Open Design 模板 "${uiPrefs.odStyle}"（用户指定，必须使用）`);
    } else if (uiPrefs.style && uiPrefs.style !== "auto") {
      const styleLabel: Record<string, string> = {
        "editorial": "Editorial 暖杂志风", "swiss": "Swiss 瑞士风",
        "product-launch": "Product Launch 暗底Hero风", "xhs-pastel": "小红书 Pastel 马卡龙风",
        "amazon-premium": "Amazon Premium A+ 原生风",
      };
      prefLines.push(`- 排版风格：${styleLabel[uiPrefs.style] || uiPrefs.style}（用户指定，必须使用）`);
    }

    const styleLabel: Record<string, string> = {
      "editorial": "Editorial 暖杂志风", "swiss": "Swiss 瑞士风",
      "product-launch": "Product Launch 暗底Hero风", "xhs-pastel": "小红书 Pastel 马卡龙风",
      "amazon-premium": "Amazon Premium A+ 原生风",
    };
    const ALL_STYLES = ["Editorial 暖杂志风", "Swiss 瑞士风", "Product Launch 暗底Hero风"];
    const variantStyles = (() => {
      if (customTemplateId) return []; // 客户自定义模板不生成变体，模板本身即为完整视觉系统
      if (uiPrefs.odStyle) return ALL_STYLES;
      if (!uiPrefs.style || uiPrefs.style === "auto") return ALL_STYLES;
      const selected = styleLabel[uiPrefs.style] || "";
      return ALL_STYLES.filter((s) => !s.startsWith(selected.slice(0, 4))).slice(0, 2);
    })();

    if (uiPrefs.model && uiPrefs.model !== "auto") {
      const modelLabel: Record<string, string> = { "east-asian": "东亚", "european": "欧美", "middle-eastern": "中东/混血" };
      prefLines.push(`- 模特：${modelLabel[uiPrefs.model] || uiPrefs.model}（用户指定，必须使用）`);
    }

    if (profileContext) {
      prefLines.push(`\n【用户偏好画像 — 基于历史生成记录，作为参考而非强制】`);
      prefLines.push(profileContext);
    }

    const mode = (formData.get("mode") as string) || "detail";

    const descBlock = description.trim()
      ? `\n产品信息：${description}\n`
      : (mode === "single"
          ? "\n（用户未提供描述，请根据产品图自行分析品类、面料、风格并生成场景图）\n"
          : "\n（用户未提供描述，请根据产品图自行分析品类、面料、风格并生成详情页）\n");

    let prompt: string;

    if (mode === "single") {
      // ===== 单图模式：只出 1 张场景图 =====
      prompt = [
        `帮我生成1张产品场景图。`,
        ``,
        `产品图：${imgPath}`,
        ...(modelRefPath ? [`模特参考图：${modelRefPath}`] : []),
        descBlock,
        ...(prefLines.length > 0 ? [`偏好参考：`, ...prefLines, ``] : []),
        ...(customerName ? [``, `【客户档案 — ${customerName}】`, `以下为该客户的特定要求，生成时必须遵守：`] : []),
        ...(customerRequirements ? [`- 其他要求：${customerRequirements}`] : []),
        ...(customerName ? [``] : []),
        `【重要规则】`,
        `- 只生成一张场景图，把产品放到合适的场景中（例如咖啡厅、街头、工作室等）。`,
        `- 不要生成白底抠图、多角度图、详情页长图或多张场景图，就一张。`,
        `- 不要生成 HTML 详情页 —— 只出一张场景图。`,
        `- 不要询问我任何问题，自己决定所有选择。`,
        `- 把图片保存到 ${outputDir}/scene_01.png。`,
        `- 在 ${outputDir}/ 下创建一个简单的 index.html，只内嵌这张场景图：<img src="./scene_01.png" style="width:100%;max-width:800px;margin:0 auto;display:block;">`,
        `- 在 image-manifest.json 中记录图片使用的 prompt。`,
        `- 生成完成后直接结束，不要迭代优化。`,
      ].join("\n");
    } else {
      // ===== 详情页模式 =====
      prompt = [
        `帮我生成这个产品的电商详情页。`,
        ``,
        `产品图：${imgPath}`,
        ...(modelRefPath ? [`模特参考图：${modelRefPath}`] : []),
        ...(logoPath ? [`品牌 Logo：${logoPath}（请将 Logo 嵌入详情页顶部品牌区或底部页脚，使用 <img src="./logo.png"> 引用，保持原始比例不拉伸变形）`] : []),
        descBlock,
        ...(prefLines.length > 0 ? [`偏好参考：`, ...prefLines, ``] : []),
        ...(customerName ? [``, `【客户档案 — ${customerName}】`, `以下为该客户的特定要求，生成时必须遵守：`] : []),
        ...(customerSizeChart ? [`- 尺码表（CSV 格式，请解析并在详情页中正确展示）：\n${customerSizeChart}`] : []),
        ...(customerRequirements ? [`- 其他要求：${customerRequirements}`] : []),
        ...(customerName ? [``] : []),
        ...(customTemplateId ? [
          `【模板保护标记】`,
          `- 客户模板 HTML 中所有带 data-hermes-protected 属性的元素及其内容，严禁任何修改。`,
          `- 包括但不限于：Logo、品牌标识、版权信息、品牌色定义（CSS 变量）。`,
          `- 这些标记元素必须原样保留在输出 HTML 中，不得删除、替换、修改属性或内容。`,
          ``
        ] : []),
        `【重要规则】`,
        `- 不要使用 clarify 询问我任何问题，自己决定所有选择。`,
        `- 把最终交付物（index.html、变体HTML、图片）全部放到 ${outputDir}/ 下面。`,
        `- 把元数据文件（image-manifest.json）放到 ${workDir}/ 下面。`,
        `- HTML 里的图片使用相对路径（如 ./scene_01.png）。`,
        `- 生成完成后直接写入 index.html，不要无限迭代优化。`,
        `- 在 image-manifest.json 中记录每张图使用的 prompt。`,
        ``,
        `【多版本输出 — 使用同一套图片，生成多个风格变体】`,
        `- 主输出（用户选的风格）：${outputDir}/index.html`,
        ...variantStyles.map((s, i) => `- 变体 ${i + 1}（${s}）：${outputDir}/variant_${i + 1}.html`),
        `- 所有变体 HTML 都必须包含相同的一套图片，只改变排版/字体/颜色/布局。`,
        `- 每个变体的风格必须适合该产品的品类和调性，不要选与产品气质冲突的模板或配色。`,
        `- 文件名必须严格使用 index.html、variant_1.html、variant_2.html。`,
      ].join("\n");
    }

    writeFileSync(promptFile, prompt, "utf-8");

    const script = [
      `#!/bin/bash`,
      `set -eo pipefail`,
      `cd /Users/eric`,
      `hermes -p duma -s ecommerce-aplus-detail chat \\`,
      `  -q "$(cat '${promptFile}')" \\`,
      `  --quiet --yolo --max-turns 90 --source web`,
    ].join("\n");
    const scriptPath = join(workDir, "run.sh");
    writeFileSync(scriptPath, script, { mode: 0o755 });

    // 持久化任务元数据
    taskStore.add({
      taskId,
      userId: "anonymous",
      status: activeCount >= MAX_CONCURRENT ? "queued" : "running",
      workDir,
      mode,
      createdAt: Date.now(),
    });

    // 检查并发
    if (activeCount >= MAX_CONCURRENT) {
      tasks.set(taskId, { status: "queued", queuePosition: 1, log: "" });
      queue.push({ taskId, startFn: () => spawnAgent(taskId, workDir, customTemplateId) });
      updateQueuePositions();
      return NextResponse.json({ taskId, queued: true, queuePosition: 1 });
    }

    activeCount++;
    spawnAgent(taskId, workDir, customTemplateId);
    return NextResponse.json({ taskId });
  } catch (error: any) {
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

// ===== 启动时恢复中断任务 =====

(function recoverTasks() {
  const pending = taskStore.getRecoverable();
  for (const t of pending) {
    if (!existsSync(join(t.workDir, "run.sh"))) {
      tasks.set(t.taskId, { status: "error", error: "任务数据已丢失", log: "" });
      taskStore.remove(t.taskId);
      continue;
    }

    // 如果 output/index.html 或 index.html 已存在，说明 Agent 已完成
    if (existsSync(join(t.workDir, "output", "index.html"))
        || existsSync(join(t.workDir, "index.html"))) {
      taskStore.remove(t.taskId);
      console.log(`[hermes-cli] ✅ 恢复时发现已完成：${t.workDir}`);
      continue;
    }

    tasks.set(t.taskId, { status: t.status === "queued" ? "queued" : "running", log: "" });

    if (t.status === "queued") {
      queue.push({ taskId: t.taskId, startFn: () => spawnAgent(t.taskId, t.workDir) });
      continue;
    }

    if (activeCount < MAX_CONCURRENT) {
      activeCount++;
      spawnAgent(t.taskId, t.workDir);
    } else {
      tasks.set(t.taskId, { status: "queued", queuePosition: 1, log: "" });
      queue.push({ taskId: t.taskId, startFn: () => spawnAgent(t.taskId, t.workDir) });
    }
  }
  updateQueuePositions();
  if (pending.length > 0) {
    console.log(`[hermes-cli] 🔄 恢复了 ${pending.length} 个中断任务`);
  }
})();

// ===== 偏好信号提取 =====

function extractPreferenceSignal(manifestPath: string): string | undefined {
  try {
    if (!existsSync(manifestPath)) return undefined;
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);

    const entries = Array.isArray(manifest) ? manifest : manifest.images || manifest.entries || [];
    if (!entries.length) return undefined;

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
  let embedOk = 0;
  let embedMiss = 0;
  const result = html.replace(/src="([^"]+)"/g, (match, src: string) => {
    if (src.startsWith("http") || src.startsWith("data:")) return match;
    let imgPath: string;
    if (src.startsWith("./")) imgPath = join(baseDir, src.slice(2));
    else if (src.startsWith("../")) imgPath = join(baseDir, "..", src.slice(3));
    else imgPath = join(baseDir, src);
    if (!existsSync(imgPath)) {
      embedMiss++;
      console.warn(`[embedImages] MISS: ${src} → ${imgPath} (not found)`);
      return match;
    }
    try {
      const data = readFileSync(imgPath);
      const ext = imgPath.split(".").pop()?.toLowerCase() || "jpg";
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      embedOk++;
      return `src="data:${mime};base64,${data.toString("base64")}"`;
    } catch (e) {
      embedMiss++;
      console.warn(`[embedImages] ERROR: ${src} → ${imgPath}`, e);
      return match;
    }
  });
  if (embedMiss > 0) console.warn(`[embedImages] ${embedOk} embedded, ${embedMiss} MISSING`);
  return result;
}

// ===== 画廊截图 =====

const GALLERY_DIR = join(process.cwd(), "public", "gallery");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function captureGalleryScreenshots(outputDir: string) {
  try {
    mkdirSync(GALLERY_DIR, { recursive: true });
    const htmlFiles = [
      { src: "index.html", dest: "editorial.png" },
      { src: "variant_1.html", dest: "swiss.png" },
      { src: "variant_2.html", dest: "product-launch.png" },
    ];
    for (const { src, dest } of htmlFiles) {
      const htmlPath = join(outputDir, src);
      if (!existsSync(htmlPath)) continue;
      const destPath = join(GALLERY_DIR, dest);
      try {
        spawnSync(CHROME, [
          "--headless=new", "--disable-gpu", "--no-sandbox",
          `--screenshot=${destPath}`, "--window-size=450,800",
          `file://${htmlPath}`,
        ], { timeout: 15000 });
      } catch {}
    }
  } catch {}
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
