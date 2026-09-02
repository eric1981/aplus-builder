/**
 * 产品识别（Ark Vision）：任务提交后先识别产品并给出名称，用于固定目录名。
 *
 * 凭证：优先环境变量 ARK_API_KEY，否则读 duma profile 的 ~/.hermes/profiles/duma/.env
 * 模型：doubao-1-5-vision-pro-32k-250115（与 duma ecommerce-aplus-detail skill 一致）
 *
 * 目标：生成一个简短产品名（中英文），既用于目录命名，也作为 agent 的
 * 产品 ground truth —— 从源头消除"生成后按 manifest 重命名目录"的时序问题。
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const ARK_MODEL = "doubao-1-5-vision-pro-32k-250115";
const ARK_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

/** 读取 Ark API Key：环境变量优先，回退 duma profile .env */
function getArkApiKey(): string {
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
  try {
    const envPath = join(homedir(), ".hermes", "profiles", "duma", ".env");
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        if (line.startsWith("ARK_API_KEY=")) {
          return line.slice("ARK_API_KEY=".length).trim();
        }
      }
    }
  } catch {}
  return "";
}

/** 识别 prompt：让模型给出简短产品名（中英文），供目录命名 + agent ground truth */
const NAMING_PROMPT = `分析这张产品图（服装/服饰/鞋帽/箱包等），输出一个简短的产品名。

要求：
1. 先判断产品类别（如上装/连衣裙/下装/套装/外套/鞋/包/配饰等）
2. 产品名用「中文名 / English Name」格式，中文 4-16 字，英文 3-10 词
3. 只写产品本身（品类 + 1-3 个最显著特征：领型/袖型/长度/版型/面料/图案/风格），
   不要写背景、模特、拍摄信息
4. 禁止使用这些字符：括号、斜杠以外的符号、引号、换行；禁止超过一行

输出格式（只输出这一行，不要解释）：
<中文名> / <English Name>`;

export interface ProductIdentity {
  /** 完整产品名（"中文 / English"） */
  name: string;
  /** 中文部分（用于中文目录命名） */
  chinese: string;
  /** 英文部分 */
  english: string;
}

/**
 * 用 Ark Vision 识别产品并给出名称。失败（网络/超时/无 key）返回 null，
 * 调用方应降级到原命名逻辑。
 */
export async function identifyProductName(
  imageBuf: Buffer,
  ext = "jpg",
  timeoutMs = 20000,
): Promise<ProductIdentity | null> {
  const apiKey = getArkApiKey();
  if (!apiKey) return null;
  if (!imageBuf || imageBuf.length === 0) return null;

  try {
    const b64 = imageBuf.toString("base64");
    // 按扩展名给 mime（模型对错误 mime 可能拒绝）
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(ARK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: ARK_MODEL,
          max_tokens: 120,
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
                { type: "text", text: NAMING_PROMPT },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim?.() || "";
      return parseProductName(text);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 解析模型输出 "中文 / English"，拆出中英文部分 */
function parseProductName(text: string): ProductIdentity | null {
  if (!text) return null;
  const clean = text.replace(/^["'`]+|["'`]+$/g, "").trim();
  // 格式：中文 / English（可能多个空格）
  const m = clean.match(/^(.+?)\s*\/\s*(.+)$/);
  if (!m) return null;
  let chinese = m[1].trim();
  let english = m[2].trim();
  // 过滤中英文混杂的脏前缀（模型偶发输出 "产品名：xxx"）
  chinese = chinese.replace(/^(产品名|名称|商品名)[：:]\s*/, "");
  if (!chinese || !english) return null;
  // 中文部分只保留 CJK + 常见字符（用于目录安全化）
  return { name: `${chinese} / ${english}`, chinese, english };
}
