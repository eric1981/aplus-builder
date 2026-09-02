import { NextRequest, NextResponse } from "next/server";
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync, readdirSync } from "fs";
import { join, extname, dirname, relative } from "path";
import { randomUUID } from "crypto";
import { taskStore } from "./task-store";
import { db } from "@/lib/db";
import { validateImageBlob } from "@/lib/upload-validate";
import { consumeQuota, checkRateLimit, clientIp } from "@/lib/limits";
import { getAgentHome, getAgentTimeoutMs, userBase } from "@/lib/config";
import { logAudit } from "@/lib/audit";
import { screenshotPage } from "@/lib/screenshot";
import { getSettingInt, getSettingBool } from "@/lib/settings";
import { startMarketAnalysis, normalizePrediction, type MarketPrediction } from "@/lib/market-analysis";
import { identifyProductName } from "@/lib/product-vision";

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
  /** 任务产出目录（轮询时实时扫描已产出图片用） */
  workDir?: string;
  html?: string;
  images?: TaskImage[];
  variants?: { name: string; html: string }[];
  preference_signal?: string;
  productName?: string;
  error?: string;
  log?: string;
  queuePosition?: number;
  /** 市场潜力预测（并行运行，不阻塞生成） */
  prediction?: {
    status: "running" | "done" | "error";
    data?: MarketPrediction | null;
    error?: string;
  };
};

/**
 * 剥离交付 HTML 中的内部标记属性（data-hermes-protected 等），
 * 避免客户下载的产物暴露内部技术实现。只删属性，保留元素与内容。
 */
function stripInternalMarkers(html: string): string {
  return html.replace(/\s+data-hermes-protected(?:="[^"]*")?/g, "");
}

/** 清洗磁盘上的交付 HTML 文件（index.html / variant_*.html），与内存交付保持一致 */
function stripInternalMarkersOnDisk(workDir: string): void {
  const candidates: string[] = [];
  for (const sub of ["output", ""]) {
    const dir = sub ? join(workDir, sub) : workDir;
    if (!existsSync(dir)) continue;
    candidates.push(join(dir, "index.html"));
    try {
      for (const f of readdirSync(dir)) {
        if (/^variant_\d+\.html$/.test(f)) candidates.push(join(dir, f));
      }
    } catch {}
  }
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const cleaned = stripInternalMarkers(readFileSync(p, "utf-8"));
      writeFileSync(p, cleaned);
    } catch {}
  }
}

const tasks = new Map<string, Task>();
// 并发/队列/重试/联网等运行参数全部来自设置中心（管理后台可改，环境变量兜底）
const curConcurrent = () => getSettingInt("maxConcurrent", 2) || 1;

let activeCount = 0;
const queue: { taskId: string; startFn: () => void }[] = [];

/** 运行中任务的子进程句柄（用于取消） */
const children = new Map<string, ChildProcess>();
/** 已取消的任务（不再自动重试） */
const canceled = new Set<string>();

function updateQueuePositions() {
  for (const { taskId } of queue) {
    const t = tasks.get(taskId);
    if (t) t.queuePosition = 1;
  }
}

function tryProcessQueue() {
  while (activeCount < curConcurrent() && queue.length > 0) {
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

function spawnAgent(taskId: string, workDir: string, customTemplateId: string | undefined, userId: string) {
  // 目录在任务创建时由 vision 定名固定，agent 禁止改名，全程不再重命名
  let outputDir = join(workDir, "output");       // 客户交付物放 output/ 子目录
  let indexHtml = join(outputDir, "index.html");
  const manifestPath = join(workDir, "image-manifest.json");  // 元数据留根目录
  const logFile = join(workDir, "agent.log");
  const scriptPath = join(workDir, "run.sh");
  // 任务产出目录（collectAndFinish 内更新），用于计算历史记录的首图相对路径
  let actualOutputDir = outputDir;

  if (!existsSync(scriptPath)) {
    tasks.set(taskId, { status: "error", workDir, error: "恢复失败：缺少 run.sh", log: "" });
    taskStore.markError(taskId, "恢复失败：缺少 run.sh");
    releaseSlot();
    return;
  }

  tasks.set(taskId, { status: "running", workDir, log: "" });

  const child = spawn("/bin/bash", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: getAgentHome() },
    cwd: getAgentHome(),
  });
  children.set(taskId, child);

  let logBuffer = "";
  let settled = false;

  const finalize = (status: "done" | "error", html?: string, errMsg?: string, images?: TaskImage[], signal?: string, variants?: { name: string; html: string }[], productName?: string) => {
    if (settled) return;
    settled = true;
    children.delete(taskId);
    tasks.set(taskId, { status, workDir, html, images, variants, preference_signal: signal, productName, error: errMsg, log: logBuffer.slice(-5000) });
    // 数据库持久化：完成/失败都保留记录（历史 + 审计）
    if (status === "done") {
      const base = userBase(userId);
      taskStore.markDone(taskId, {
        productName,
        dirName: relative(base, workDir),
        imageCount: images?.length || 0,
        firstImage:
          images && images.length > 0
            ? relative(base, join(actualOutputDir, images[0].name))
            : null,
        variantNames: variants?.map((v) => v.name),
      });
    } else {
      taskStore.markError(taskId, errMsg || "任务失败");
      // 失败审计（"任务已取消"已在 DELETE 审计，不重复记录）
      if (errMsg !== "任务已取消") {
        logAudit(userId, "task.error", { taskId, error: errMsg || "任务失败" });
      }
    }
    releaseSlot();
  };

  const readAndEmbed = (filePath: string, imgDir?: string): string | null => {
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      let html = raw.replace(/^```html?\s*\n?/i, "").replace(/\n?```\s*$/, "");
      const endIdx = html.lastIndexOf("</html>");
      if (endIdx !== -1) html = html.substring(0, endIdx + 7);
      return embedImages(html, imgDir || outputDir, workDir);
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
    actualOutputDir = dirname(actualIndex);
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
          const tplProtected = tpl.match(/<[^>]+data-hermes-protected(?:="[^"]*")?[^>]*>/g) || [];
          const outProtected = protectedHtml.match(/<[^>]+data-hermes-protected(?:="[^"]*")?[^>]*>/g) || [];
          for (let i = 0; i < Math.min(tplProtected.length, outProtected.length); i++) {
            protectedHtml = protectedHtml.replace(outProtected[i], tplProtected[i]);
          }
          console.log(`[hermes-cli] 🔒 已保护 ${Math.min(tplProtected.length, outProtected.length)} 个标记元素`);
        }
      }

      const variants: { name: string; html: string }[] = [];
      const STYLE_NAMES = ["Swiss 瑞士风", "Product Launch 暗底Hero风", "Editorial 暖杂志风"];
      // 预加载模板保护数据
      let tplProtected: string[] = [];
      if (customTemplateId) {
        const templatePath = join(process.cwd(), "customer-templates", `${customTemplateId}.html`);
        if (existsSync(templatePath)) {
          const tpl = readFileSync(templatePath, "utf-8");
          tplProtected = tpl.match(/<[^>]+data-hermes-protected(?:="[^"]*")?[^>]*>/g) || [];
        }
      }
      for (let i = 1; i <= 3; i++) {
        const vPath = join(outputDir, `variant_${i}.html`);
        let vHtml = readAndEmbed(vPath);
        if (vHtml) {
          // 变体也做模板保护
          if (tplProtected.length > 0) {
            const outProtected = vHtml.match(/<[^>]+data-hermes-protected(?:="[^"]*")?[^>]*>/g) || [];
            for (let j = 0; j < Math.min(tplProtected.length, outProtected.length); j++) {
              vHtml = vHtml.replace(outProtected[j], tplProtected[j]);
            }
          }
          variants.push({ name: STYLE_NAMES[i - 1] || `变体 ${i}`, html: vHtml });
        }
      }

      // 从 manifest 提取产品名（仅用于展示，不重命名目录 —— 目录已在任务创建时
      // 由 vision 定名固定，agent 也禁止改名；目录名与 DB 全程一致）
      let finalProductName = "";
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          const product = manifest?.product;
          const category: string = typeof product === "object" && product
            ? (product.category || "")
            : typeof product === "string" ? product : "";
          const chinese = category.replace(/\(.*?\)/g, "").trim()
            .replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
          if (chinese) finalProductName = chinese;
        } catch {}
      }

      // 交付前剥离内部标记属性（data-hermes-protected 等），避免产物暴露内部技术实现
      protectedHtml = stripInternalMarkers(protectedHtml);
      for (const v of variants) v.html = stripInternalMarkers(v.html);

      finalize("done", protectedHtml, undefined, images, signal, variants.length > 0 ? variants : undefined, finalProductName || undefined);
      console.log(`[hermes-cli] ✅ HTML ${protectedHtml.length} chars, ${images.length} images, ${variants.length} variants`);
      logAudit(userId, "task.done", { taskId, product: finalProductName || undefined, images: images.length });

      // 同步清洗磁盘交付文件（/api/output 免认证直接访问时同样干净）
      stripInternalMarkersOnDisk(actualOutputDir);

      // 异步生成画廊截图（不再同步阻塞事件循环）
      captureGalleryScreenshotsAsync(outputDir);
      return true;
    } catch (e: any) {
      finalize("error", undefined, e.message);
      return false;
    }
  };

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    if (!collectAndFinish()) finalize("error", undefined, "Agent 超时");
  }, getAgentTimeoutMs());

  // 实时日志：磁盘 agent.log 全量追加；内存 logBuffer 供轮询 GET 展示
  // （"Agent 正在执行什么"），并同步到 tasks map 的 log 字段
  const appendLog = (data: Buffer) => {
    const text = data.toString();
    logBuffer += text;
    appendFileSync(logFile, text);
    const cur = tasks.get(taskId);
    if (cur) cur.log = logBuffer.slice(-6000);
  };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);

  child.on("close", (code) => {
    clearTimeout(timer);
    children.delete(taskId);
    console.log(`[hermes-cli] Task ${taskId} exited code=${code}`);
    if (collectAndFinish()) return;

    const htmlMatch = logBuffer.match(/```html?\s*\n?([\s\S]*?)```/);

    // 用户已取消：不再重试
    if (canceled.has(taskId)) {
      canceled.delete(taskId);
      finalize("error", undefined, "任务已取消");
      return;
    }

    // 日志中直接输出了 HTML（agent 兜底路径）→ 视为成功
    if (htmlMatch) { finalize("done", htmlMatch[1].trim()); return; }

    // 自动重试：Agent 异常退出且未超过上限时，重新入队（占用新槽位）
    const record = taskStore.get(taskId);
    const attempts = record?.attempts || 1;
    if (code !== 0 && attempts < getSettingInt("maxAgentAttempts", 2)) {
      console.log(`[hermes-cli] Task ${taskId} 失败（exit=${code}），自动重试 ${attempts}/${getSettingInt("maxAgentAttempts", 2)}`);
      taskStore.bumpAttempts(taskId);
      tasks.set(taskId, { status: "queued", workDir, log: logBuffer.slice(-2000) });
      queue.unshift({ taskId, startFn: () => spawnAgent(taskId, workDir, customTemplateId, userId) }); // 重试优先
      releaseSlot(); // 释放槽位 → tryProcessQueue 立即拉起重试
      return;
    }

    finalize("error", undefined, `Agent 退出码 ${code}`);
  });

  child.on("error", (err) => { clearTimeout(timer); children.delete(taskId); finalize("error", undefined, err.message); });
}

// ===== POST：创建任务 =====

export async function POST(request: NextRequest) {
  const taskId = randomUUID();

  // 稳定性 P0：限流（成本保护，昂贵的写接口）
  if (!checkRateLimit(clientIp(request.headers))) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
    }

    let imgPath = "";
    let modelRefPath = "";
    let logoPath = "";

    // 多用户隔离：x-user-id 由 proxy 注入；无则视为 admin（本地默认布局）
    const userId = request.headers.get("x-user-id") || "admin";
    const base = userBase(userId);

    // 先取 description 和 product_name 用于目录命名（vision 定名失败时的降级名）
    const description = (formData.get("description") as string) || "";
    const productNameInput = (formData.get("product_name") as string) || "";
    const customerName = (formData.get("customer_name") as string) || "";

    // 客户名安全化（跟 sanitizeProductName 逻辑一致但不需要 taskId fallback）
    const customerDir = customerName
      ? customerName.trim().slice(0, 20)
          .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, "-")
          .replace(/\s+/g, "-").replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
      : "";

    // ── 产品识别定名（Ark Vision）：建目录前先识别产品并定名 ──
    // 目录名从创建起就是最终产品名，agent 全程使用同一路径，消除
    // "生成后按 manifest 重命名目录"导致的 dir_name 与磁盘不一致问题。
    // vision 失败（无 key/超时/网络/非图片）时降级到用户输入/描述命名。
    let visionProductName = "";
    const productImageBlob = formData.get("image_0");
    if (productImageBlob && typeof productImageBlob === "object" && "arrayBuffer" in productImageBlob) {
      const validated = await validateImageBlob(productImageBlob as Blob);
      if (validated) {
        try {
          const identity = await identifyProductName(validated.buffer, validated.ext);
          if (identity?.chinese) {
            visionProductName = identity.chinese;
            console.log(`[product-vision] 📛 识别产品名：${identity.name}`);
          }
        } catch {
          // vision 异常静默降级
        }
      }
    }

    // 目录命名：vision 识别名优先，其次用户 product_name，再次 description
    const namingSource = visionProductName || productNameInput || description;
    const productDir = sanitizeProductName(namingSource, taskId);

    const workDir = customerDir
      ? join(base, customerDir, productDir)
      : join(base, productDir);
    // 交付物目录约定（与 spawnAgent 内部一致）：
    //   detail 模式 → workDir/output（output/ 子目录）
    //   single 模式 → workDir（场景图直接放任务根目录）
    const mode = (formData.get("mode") as string) || "detail";
    const deliverablesDir = mode === "single" ? workDir : join(workDir, "output");
    const inputDir = join(workDir, "input");
    const promptFile = join(workDir, "prompt.txt");

    // 建目录：input/ + 交付目录（mkdirSync recursive 顺带建 workDir）
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(deliverablesDir, { recursive: true });

    // 逐项提取文件（不用 entries() 遍历，避免 Blob instanceof 不可靠）
    const modelImage = formData.get("model_image_0");
    if (modelImage && typeof modelImage === "object" && "arrayBuffer" in modelImage) {
      const validated = await validateImageBlob(modelImage as Blob);
      if (!validated) {
        return NextResponse.json({ error: "模特参考图无效：仅支持 PNG/JPEG/WebP，且不超过 15MB" }, { status: 400 });
      }
      const { buffer, ext } = validated;
      modelRefPath = join(inputDir, `model_ref.${ext}`);
      writeFileSync(modelRefPath, buffer);
    }

    const logoImage = formData.get("logo_image_0");
    if (logoImage && typeof logoImage === "object" && "arrayBuffer" in logoImage) {
      const validated = await validateImageBlob(logoImage as Blob);
      if (!validated) {
        return NextResponse.json({ error: "Logo 无效：仅支持 PNG/JPEG/WebP，且不超过 15MB" }, { status: 400 });
      }
      const { buffer, ext } = validated;
      logoPath = join(inputDir, `logo.${ext}`);
      writeFileSync(logoPath, buffer);
    }

    const productImage = formData.get("image_0");
    if (productImage && typeof productImage === "object" && "arrayBuffer" in productImage) {
      const validated = await validateImageBlob(productImage as Blob);
      if (!validated) {
        return NextResponse.json({ error: "产品图无效：仅支持 PNG/JPEG/WebP，且不超过 15MB" }, { status: 400 });
      }
      const { buffer, ext } = validated;
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
    const category = (formData.get("category") as string) || "";
    // 款式选项（上装/下装：长度 + 版型）
    const topLength = (formData.get("top_length") as string) || "";
    const topFit = (formData.get("top_fit") as string) || "";
    const bottomLength = (formData.get("bottom_length") as string) || "";
    const bottomFit = (formData.get("bottom_fit") as string) || "";

    let uiPrefs: { style?: string; odStyle?: string; model?: string } = {};
    try {
      const raw = formData.get("preferences") as string;
      if (raw) uiPrefs = JSON.parse(raw);
    } catch {}

    // ---- prompt 组装 ----
    const prefLines: string[] = [];
    if (category) prefLines.push(`- 品类：${category}（用户指定，生成时必须匹配此品类）`);
    // AI 识别的产品名（同时用于目录命名）：告知 agent 保持命名一致
    if (visionProductName) {
      prefLines.push(`- 产品名（AI 识别，任务目录以此命名）：${visionProductName}（生成时产品结构与品类以此为准，image-manifest.json 中 product/category 与此一致）`);
    }

    // 款式约束：长度 + 版型（上装/下装），用户指定时必须严格遵守
    const styleSpecs: string[] = [];
    if (topLength) styleSpecs.push(`上装长度为「${topLength}」`);
    if (topFit) styleSpecs.push(`上装版型为「${topFit}」`);
    if (bottomLength) styleSpecs.push(`下装长度为「${bottomLength}」`);
    if (bottomFit) styleSpecs.push(`下装版型为「${bottomFit}」`);
    if (styleSpecs.length > 0) {
      prefLines.push(`- 款式要求：${styleSpecs.join("，")}（用户指定，生成时必须在版型/长度上严格遵守，模特穿着需清晰体现）`);
    }

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
        `- ⛔ 严禁重命名、移动或删除任务目录（${workDir}）及其任何父级目录。`,
        `- 把图片保存到 ${deliverablesDir}/scene_01.png。`,
        `- 在 ${deliverablesDir}/ 下创建一个简单的 index.html，只内嵌这张场景图：<img src="./scene_01.png" style="width:100%;max-width:800px;margin:0 auto;display:block;">`,
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
        `- ⛔ 严禁重命名、移动或删除任务目录（${workDir}）及其任何父级目录。`,
        `- ⚠️ 所有 HTML、变体HTML、图片必须放进 output/ 子目录，不可散落在根目录。`,
        `- 把最终交付物（index.html、变体HTML、图片）全部放到 ${deliverablesDir}/ 下面。`,
        `- 把元数据文件（image-manifest.json）放到 ${workDir}/ 下面。`,
        `- HTML 里的图片使用相对路径（如 ./scene_01.png）。`,
        `- 生成完成后直接写入 index.html，不要无限迭代优化。`,
        `- 在 image-manifest.json 中记录每张图使用的 prompt。`,
        ``,
        `【多版本输出 — 使用同一套图片，生成多个风格变体】`,
        `- 主输出（用户选的风格）：${deliverablesDir}/index.html`,
        ...variantStyles.map((s, i) => `- 变体 ${i + 1}（${s}）：${deliverablesDir}/variant_${i + 1}.html`),
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
      `  --quiet --yolo --max-turns 90${getSettingBool("agentSource") ? " --source web" : ""}`,
    ].join("\n");
    const scriptPath = join(workDir, "run.sh");
    writeFileSync(scriptPath, script, { mode: 0o755 });

    // 队列上限检查（先于配额，避免满队列时白烧配额）
    if (activeCount >= curConcurrent() && queue.length >= getSettingInt("maxQueue", 20)) {
      return NextResponse.json(
        { error: `任务队列已满（最多 ${getSettingInt("maxQueue", 20)} 个排队），请稍后再试` },
        { status: 429 },
      );
    }

    // 稳定性 P0：配额（全局 + 每用户）——仅在任务校验通过、即将创建时消耗
    const quota = consumeQuota(userId);
    if (!quota.ok) {
      return NextResponse.json({ error: quota.reason }, { status: 429 });
    }

    // 持久化任务元数据
    taskStore.add({
      taskId,
      userId,
      status: activeCount >= curConcurrent() ? "queued" : "running",
      workDir,
      mode,
      customTemplateId: customTemplateId || undefined,
      attempts: 1,
      createdAt: Date.now(),
    });

    // 审计：任务创建
    logAudit(userId, "task.create", { taskId, mode, workDir });

    // ---- 并行市场潜力预测（不依赖生成结果，不占生成队列）----
    const marketInput = [
      `请分析这款产品在 Amazon US 市场的销售潜力。`,
      ``,
      `产品图：${imgPath}`,
      `品类：${category || "（未指定，请看图判断）"}`,
      `产品描述：${description || "（未提供，请结合产品图推断）"}`,
      `风格参考：${styleLabel[uiPrefs.style || ""] || uiPrefs.style || "自动"}`,
      ...(customerRequirements ? [`客户要求：${customerRequirements}`] : []),
      ``,
      `请按 ecommerce-market-analysis skill 的要求，联网调研后把预测 JSON 写入：`,
      join(workDir, "sales-prediction.json"),
    ].join("\n");
    const taskForPred = tasks.get(taskId);
    if (taskForPred) taskForPred.prediction = { status: "running" };
    startMarketAnalysis(workDir, marketInput, (pred) => {
      const cur = tasks.get(taskId);
      const normalized = normalizePrediction(pred);
      if (cur) cur.prediction = { status: "done", data: normalized };
      taskStore.updatePrediction(taskId, normalized);
    });

    // 检查并发
    if (activeCount >= curConcurrent()) {
      tasks.set(taskId, { status: "queued", workDir, queuePosition: 1, log: "" });
      queue.push({ taskId, startFn: () => spawnAgent(taskId, workDir, customTemplateId, userId) });
      updateQueuePositions();
      return NextResponse.json({ taskId, queued: true, queuePosition: 1 });
    }

    activeCount++;
    spawnAgent(taskId, workDir, customTemplateId, userId);
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

  // 运行中/排队中：实时扫描磁盘产出目录，已生成的图片一张出一张（渐进展示）。
  // 全量模式图片在 output/ 子目录，单图模式在任务根目录，两个位置都扫。
  if ((task.status === "running" || task.status === "queued") && task.workDir) {
    try {
      const candidates = [join(task.workDir, "output"), task.workDir];
      const seen = new Map<string, TaskImage>();
      for (const dir of candidates) {
        if (!existsSync(dir)) continue;
        for (const img of collectImages(dir)) {
          if (!seen.has(img.name)) seen.set(img.name, img);
        }
      }
      const imgs = [...seen.values()];
      if (imgs.length > 0) task.images = imgs;
    } catch {}
  }

  return NextResponse.json(task);
}

// ===== 取消任务（稳定性 P0：用户可取消排队/运行中任务）=====

export async function DELETE(request: NextRequest) {
  const taskId = request.nextUrl.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
  const task = tasks.get(taskId);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const userId = request.headers.get("x-user-id") || "admin";
  logAudit(userId, "task.cancel", { taskId, status: task.status });

  if (task.status === "queued") {
    // 从排队队列移除
    const idx = queue.findIndex((q) => q.taskId === taskId);
    if (idx !== -1) queue.splice(idx, 1);
    tasks.set(taskId, { status: "error", error: "任务已取消", log: task.log });
    taskStore.markError(taskId, "任务已取消");
    return NextResponse.json({ ok: true, canceled: true });
  }

  if (task.status === "running") {
    canceled.add(taskId);
    const child = children.get(taskId);
    if (child) child.kill("SIGTERM");
    // 状态由 close 回调最终确定（若此时已产出则标记完成，否则"已取消"）
    return NextResponse.json({ ok: true, canceling: true });
  }

  // done / error 无可取消
  return NextResponse.json({ ok: true, canceled: false });
}

// ===== 启动时恢复中断任务 =====

/** 产物完整则补记完成（供运行中/排队中恢复与失败补记共用），返回是否已补记 */
function recoverCompletedOutput(
  t: { taskId: string; userId: string; workDir: string },
  fromError: boolean,
): boolean {
  if (!(existsSync(join(t.workDir, "output", "index.html"))
        || existsSync(join(t.workDir, "index.html")))) {
    return false;
  }
  const scanPath = existsSync(join(t.workDir, "output"))
    ? join(t.workDir, "output")
    : t.workDir;
  let imageCount = 0;
  let firstImage: string | null = null;
  try {
    const files = readdirSync(scanPath).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f)).sort();
    imageCount = files.length;
    if (files.length > 0) {
      firstImage = relative(userBase(t.userId), join(scanPath, files[0]));
    }
  } catch {}
  taskStore.markDone(t.taskId, {
    dirName: relative(userBase(t.userId), t.workDir),
    imageCount,
    firstImage,
    variantNames: [],
  });
  logAudit(t.userId, "task.done", {
    taskId: t.taskId,
    recovered: true,
    fromError: fromError || undefined,
    images: imageCount,
  });
  console.log(
    `[hermes-cli] ✅ ${fromError ? "失败但产物完整，补记完成" : "恢复时发现已完成"}：${t.workDir}`,
  );
  return true;
}

(function recoverTasks() {
  // 0) 磁盘一致性修复：DB 任务行（done/error）与实际产出目录对齐
  //    （Agent 中途改名目录等历史原因导致 dir_name/image_count 过期）
  try {
    const allUsers = (db.prepare(`SELECT id FROM users WHERE role != 'admin'`).all() as { id: string }[])
      .map((r) => r.id);
    const fixed = taskStore.reconcileUserDirs(userBase, allUsers);
    if (fixed > 0) console.log(`[hermes-cli] 🔧 磁盘一致性修复 ${fixed} 个任务`);
  } catch (e) {
    console.log("[hermes-cli] reconcile skipped:", e instanceof Error ? e.message : e);
  }

  // 1) 运行中/排队中任务：产物完整则补记 done，否则重新拉起
  const pending = taskStore.getRecoverable();
  for (const t of pending) {
    if (!existsSync(join(t.workDir, "run.sh"))) {
      tasks.set(t.taskId, { status: "error", workDir: t.workDir, error: "任务数据已丢失", log: "" });
      taskStore.remove(t.taskId);
      logAudit(t.userId, "task.error", { taskId: t.taskId, error: "任务数据已丢失（恢复时）" });
      continue;
    }

    // 如果 output/index.html 或 index.html 已存在，说明 Agent 已完成 → 标记完成并入历史
    if (recoverCompletedOutput(t, false)) continue;

    tasks.set(t.taskId, { status: t.status === "queued" ? "queued" : "running", workDir: t.workDir, log: "" });
    // 恢复重新拉起 Agent 的审计
    logAudit(t.userId, "task.resume", { taskId: t.taskId, workDir: t.workDir });

    if (t.status === "queued") {
      queue.push({ taskId: t.taskId, startFn: () => spawnAgent(t.taskId, t.workDir, t.customTemplateId, t.userId) });
      continue;
    }

    if (activeCount < curConcurrent()) {
      activeCount++;
      spawnAgent(t.taskId, t.workDir, t.customTemplateId, t.userId);
    } else {
      tasks.set(t.taskId, { status: "queued", workDir: t.workDir, queuePosition: 1, log: "" });
      queue.push({ taskId: t.taskId, startFn: () => spawnAgent(t.taskId, t.workDir, t.customTemplateId, t.userId) });
    }
  }

  // 2) 失败（Agent 退出码非 0）但产物完整的任务：补记 done，不重新拉起
  const errored = taskStore.getErroredForRecovery();
  let recoveredErrored = 0;
  for (const t of errored) {
    if (recoverCompletedOutput(t, true)) recoveredErrored++;
  }

  updateQueuePositions();
  if (pending.length > 0) {
    console.log(`[hermes-cli] 🔄 恢复了 ${pending.length} 个中断任务`);
  }
  if (recoveredErrored > 0) {
    console.log(`[hermes-cli] 🔄 补记 ${recoveredErrored} 个失败但产物完整的任务为完成`);
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

function embedImages(html: string, baseDir: string, fallbackDir?: string): string {
  let embedOk = 0;
  let embedMiss = 0;
  const resolvePath = (src: string): string | null => {
    let imgPath: string;
    if (src.startsWith("./")) imgPath = join(baseDir, src.slice(2));
    else if (src.startsWith("../")) imgPath = join(baseDir, "..", src.slice(3));
    else imgPath = join(baseDir, src);
    if (existsSync(imgPath)) return imgPath;
    // fallback: 试试根目录（agent 可能把图片写错位置）
    if (fallbackDir) {
      const fbPath = join(fallbackDir, src.startsWith("./") ? src.slice(2) : src);
      if (existsSync(fbPath)) return fbPath;
    }
    return null;
  };
  const result = html.replace(/src="([^"]+)"/g, (match, src: string) => {
    if (src.startsWith("http") || src.startsWith("data:")) return match;
    const imgPath = resolvePath(src);
    if (!imgPath) {
      embedMiss++;
      console.warn(`[embedImages] MISS: ${src}`);
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

// ===== 画廊截图（异步，不阻塞事件循环）=====

const GALLERY_DIR = join(process.cwd(), "public", "gallery");

function captureGalleryScreenshotsAsync(outputDir: string) {
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
      // fire-and-forget：并发由 screenshot.ts 内部限制
      screenshotPage({ htmlPath, destPath }).catch(() => {});
    }
  } catch {}
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
