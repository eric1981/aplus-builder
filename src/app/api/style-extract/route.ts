import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getCustomer } from "@/lib/customer-store";
import { validateImageBlob } from "@/lib/upload-validate";
import { consumeQuota, checkRateLimit, clientIp } from "@/lib/limits";
import { consumeCredits, creditCostFor } from "@/lib/credits";
import { onTemplateCreated, migrateLegacyTemplates } from "@/lib/style-templates";
import { getAgentHome, getStyleTimeoutMs, OUTPUT_BASE } from "@/lib/config";
import { logAudit } from "@/lib/audit";
import { getSettingInt, getSettingBool } from "@/lib/settings";

const TEMPLATES_DIR = join(process.cwd(), "customer-templates");

type StyleTask = {
  status: "running" | "done" | "error";
  templateId?: string;
  html?: string;
  error?: string;
  log?: string;
};

const tasks = new Map<string, StyleTask>();
let activeStyleCount = 0;

// ===== POST：创建风格复刻任务 =====
export async function POST(request: NextRequest) {
  const taskId = randomUUID();
  const userId = request.headers.get("x-user-id") || "admin";

  // 稳定性 P0：限流 + 并发上限
  if (!checkRateLimit(clientIp(request.headers))) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  if (activeStyleCount >= getSettingInt("maxStyleConcurrent", 2)) {
    return NextResponse.json({ error: `风格复刻并发已达上限（${getSettingInt("maxStyleConcurrent", 2)}），请稍后再试` }, { status: 429 });
  }

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
    }
    const screenshot = formData.get("screenshot") as Blob | null;
    const requirements = (formData.get("requirements") as string) || "";
    const customerId = (formData.get("customer_id") as string) || "";
    const mode = (formData.get("mode") as string) || "basic";

    // 高级复刻：多张参考图 + 每张指定参考元素
    // 收集 ref_{i}（图文件）与 ref_role_{i} / ref_note_{i}
    const advancedRefs: { file: Blob | null; role: string; note: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const f = formData.get(`ref_${i}`) as Blob | null;
      if (f && typeof f === "object" && "arrayBuffer" in f) {
        advancedRefs.push({
          file: f,
          role: (formData.get(`ref_role_${i}`) as string) || "整体风格",
          note: (formData.get(`ref_note_${i}`) as string) || "",
        });
      }
    }

    // 基础模式必须有一张 screenshot；高级模式用 advancedRefs
    const hasBasic = screenshot && typeof screenshot === "object" && "arrayBuffer" in screenshot;
    if (mode === "advanced" ? advancedRefs.length === 0 : !hasBasic) {
      return NextResponse.json({ error: "请上传参考截图" }, { status: 400 });
    }
    if (advancedRefs.length > 8) {
      return NextResponse.json({ error: "高级复刻最多 8 张参考图" }, { status: 400 });
    }

    // 校验并保存所有截图（basic: screenshot 1 张 / advanced: N 张）
    const savedRefs: { path: string; role: string; note: string }[] = [];
    const saveOne = async (blob: Blob, tag: string): Promise<{ path: string; ext: string }> => {
      const validated = await validateImageBlob(blob);
      if (!validated) throw new Error("截图无效：仅支持 PNG/JPEG/WebP 图片，且不超过 15MB");
      const { buffer, ext } = validated;
      const p = join(TEMPLATES_DIR, `${taskId}_${tag}.${ext}`);
      writeFileSync(p, buffer);
      return { path: p, ext };
    };
    try {
      if (mode === "advanced") {
        for (let i = 0; i < advancedRefs.length; i++) {
          const r = advancedRefs[i];
          if (!r.file) continue;
          const saved = await saveOne(r.file, `ref${i}`);
          savedRefs.push({ path: saved.path, role: r.role, note: r.note });
        }
      } else {
        const saved = await saveOne(screenshot as Blob, "ref");
        savedRefs.push({ path: saved.path, role: "整体风格", note: "" });
      }
    } catch (e: any) {
      return NextResponse.json({ error: e.message || "截图无效" }, { status: 400 });
    }

    // 稳定性 P0：配额（日/月成本熔断）——校验通过后才消耗
    const quota = consumeQuota(userId);
    if (!quota.ok) {
      return NextResponse.json({ error: quota.reason }, { status: 429 });
    }

    // 积分真实扣减（模板复刻）
    const creditCost = creditCostFor("style_extract");
    const credit = consumeCredits(userId, creditCost, "style_extract", taskId);
    if (!credit.ok) {
      return NextResponse.json(
        { error: `积分不足：本次需要 ${creditCost} 积分，当前余额 ${credit.balance}（请联系管理员充值）` },
        { status: 402 },
      );
    }
    console.log(`[credits] ${userId} 消耗 ${creditCost} 分（style_extract），余额 ${credit.balance}`);

    // 保存目录确保存在
    mkdirSync(TEMPLATES_DIR, { recursive: true });
    const outputPath = join(TEMPLATES_DIR, `${taskId}.html`);

    // 客户信息（经 customer-store 安全读取，杜绝路径穿越）
    let customerHint = "";
    if (customerId) {
      try {
        const profile = getCustomer(customerId, userId);
        if (profile?.name) {
          customerHint = `\n这个模板将用于客户「${profile.name}」的后续生成。`;
        }
      } catch {
        // 非法 customerId 视为无客户信息，不阻断任务
      }
    }

    // 参考图角色 → 元素说明（对齐 aplus-style-creator 的映射维度）
    const ROLE_HINTS: Record<string, string> = {
      "整体风格": "整页设计语言（配色+字体+排版+模块结构的综合观感）",
      "配色": "色彩系统：背景/文字/强调色/边框色的取色",
      "字体": "字体系统：标题/正文的字体、字重、字号层级",
      "排版与布局": "布局结构：模块顺序、分栏、图文方向、栅格",
      "模块结构": "模块组成：用哪些模块、每模块的内容组织方式",
      "图片处理手法": "图片特征：形状裁切、边框、阴影、蒙层、同网格形状变化",
      "间距与圆角": "间距 padding/gap 与圆角风格",
      "特殊元素": "特殊细节：图标、角标、装饰线、背景纹理等元素",
    };

    // 拼 prompt（单图 / 多图高级复刻）
    const isMulti = savedRefs.length > 1;
    const promptHead = isMulti
      ? `这是「高级复刻」：请分析下面 ${savedRefs.length} 张参考图，每张图有指定的参考职责（元素分工），综合它们创建一个新的 A+ 风格模板。`
      : `请分析这张参考截图，复刻其设计风格并创建一个新的 A+ 风格模板。`;

    const refLines: string[] = [];
    savedRefs.forEach((r, i) => {
      const roleDesc = ROLE_HINTS[r.role] || r.role;
      const noteLine = r.note ? `（补充说明：${r.note}）` : "";
      refLines.push(`图${i + 1}（${r.role}）：${r.path} — 本图负责参考「${roleDesc}」${noteLine}`);
    });

    const prompt = [
      promptHead,
      ``,
      ...refLines,
      ``,
      ...(requirements ? [`用户要求：${requirements}`] : []),
      ...(customerHint ? [customerHint] : []),
      ``,
      ...(isMulti
        ? [
            `【映射规则】`,
            `- 每张图只贡献它被指定的部分（如上图所述），不要拿图 A 的配色套用到只负责排版的图 B 上。`,
            `- 若多个维度来自不同图且冲突，按用户指定优先；未指定的维度从参考图中合理推断。`,
            `- 最终模板是这些元素的一个和谐整体，不是逐张拼贴。`,
          ]
        : []),
      `请完成以下操作：`,
      `1. 视觉反推：按上述分工分析参考图（多图时逐图分析其负责维度）`,
      `2. 创建风格模板：构建完整可复用的 HTML/CSS 模板`,
      `3. 用刚刚创建的风格模板生成一个完整的 HTML 文件，需要的示例图片从 ${OUTPUT_BASE} 目录获取`,
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
      `  --quiet --yolo --max-turns 60${getSettingBool("agentSource") ? " --source web" : ""}`,
    ].join("\n");

    const scriptPath = join(TEMPLATES_DIR, `${taskId}_run.sh`);
    writeFileSync(scriptPath, script, { mode: 0o755 });

    // 启动 agent
    const logFile = join(TEMPLATES_DIR, `${taskId}_agent.log`);
    tasks.set(taskId, { status: "running", log: "" });
    activeStyleCount++;

    let settled = false;
    let logBuffer = "";

    const child = spawn("/bin/bash", [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: getAgentHome() },
      cwd: getAgentHome(),
    });

    child.stdout.on("data", (d: Buffer) => { logBuffer += d.toString(); appendFileSync(logFile, d); });
    child.stderr.on("data", (d: Buffer) => { logBuffer += d.toString(); appendFileSync(logFile, d); });

    const finalize = (status: "done" | "error", html?: string, errMsg?: string) => {
      if (settled) return;
      settled = true;
      activeStyleCount = Math.max(0, activeStyleCount - 1);
      tasks.set(taskId, { status, templateId: taskId, html, error: errMsg, log: logBuffer.slice(-5000) });
      logAudit(userId, status === "done" ? "style.done" : "style.error", { taskId, error: errMsg });
      // 复刻成功：注册模板（归属当前用户）+ 后台生成缩略图
      if (status === "done") {
        onTemplateCreated(taskId, userId).catch(() => {});
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) finalize("error", undefined, "Agent 超时");
    }, getStyleTimeoutMs());

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

// 模块加载时迁移一次旧模板（customer-templates/*.html → style_templates，归 admin）
try {
  const n = migrateLegacyTemplates();
  if (n > 0) console.log(`[style-templates] 迁移 ${n} 个旧模板`);
} catch {}
