/**
 * 公开资源 URL 签名（安全 P0-1）
 *
 * 背景：/api/output/* 曾是免认证通道，且未登录时身份回落为 admin，
 * 导致任何人都能读取 OUTPUT_BASE 下**所有租户**的文件（产品原图、prompt.txt、
 * input-meta.json 等）。修复后该通道默认要求登录并做租户隔离；
 * 唯一合法的匿名消费者是首页作品墙（/api/hero-images 返回的模特场景图）。
 *
 * 方案：服务端为「明确要公开的图」签发 HMAC 签名（密钥持久化在 data/.asset-secret，
 * 0600），匿名请求只有携带有效签名且为图片扩展名时才放行。签名是对
 * 「规范化后的编码相对路径」做的，攻击者无法用一张已公开图的签名去读别的路径。
 *
 * 密钥来源优先级：环境变量 ASSET_URL_SECRET > data/.asset-secret（首次自动生成）。
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const SECRET_FILE = join(DATA_DIR, ".asset-secret");

let cachedSecret: string | null = null;

function loadSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.ASSET_URL_SECRET;
  if (fromEnv) {
    cachedSecret = fromEnv;
    return fromEnv;
  }
  try {
    if (existsSync(SECRET_FILE)) {
      const s = readFileSync(SECRET_FILE, "utf-8").trim();
      if (s) {
        cachedSecret = s;
        return s;
      }
    }
    mkdirSync(DATA_DIR, { recursive: true });
    const generated = randomBytes(32).toString("hex");
    writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    cachedSecret = generated;
    return generated;
  } catch {
    // 落盘失败：退化为进程内临时密钥（重启后旧签名失效，仅影响首页图缓存）
    cachedSecret = randomBytes(32).toString("hex");
    return cachedSecret;
  }
}

/** 把 pathname 中的路径片段规范化为「逐段 encode」形式，保证签名两端一致 */
export function canonicalEncodedPath(rawPath: string): string {
  try {
    return rawPath
      .split("/")
      .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
      .join("/");
  } catch {
    return "";
  }
}

/** 为规范化编码路径生成签名（32 hex） */
export function signAssetPath(encodedPath: string): string {
  return createHmac("sha256", loadSecret()).update(encodedPath).digest("hex").slice(0, 32);
}

/** 校验签名（常量时间比较） */
export function verifyAssetPath(encodedPath: string, sig: string | null | undefined): boolean {
  if (!encodedPath || !sig || sig.length !== 32) return false;
  const expected = signAssetPath(encodedPath);
  try {
    return timingSafeEqual(Buffer.from(expected, "utf-8"), Buffer.from(sig, "utf-8"));
  } catch {
    return false;
  }
}
