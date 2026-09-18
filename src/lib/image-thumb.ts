/**
 * 缩略图生成（跨平台，安全/性能）
 *
 * 背景：预览接口原先直接 `spawnSync("sips", ...)` —— sips 是 **macOS 专有**命令，
 * 部署到 Linux（华为云 ECS）后全部失败，预览会回退原图，流量与等待时间成倍增长；
 * 且 spawnSync 会阻塞 Node 事件循环。
 *
 * 现在的工具链（按优先级自动探测，全部失败则安全回退原图）：
 *   1. **sharp**（Next 的 optionalDependency，通常已随 npm install 装好；
 *      macOS / Linux x64 / arm64 均有预编译包，异步、无子进程）
 *   2. ImageMagick：`magick` 或 `convert`（Linux 上 `apt install imagemagick`）
 *   3. macOS 的 `sips`（保留，兼容本地开发）
 *   4. 回退：返回原图路径（绝不阻断预览）
 *
 * 另外做两件省资源的事：
 *   - 原图已经很小的（<200KB）不重复生成缩略图；
 *   - 并发上限（默认 2），避免多张 4K 图同时解码把内存打满。
 */
import { existsSync, mkdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { join, extname } from "path";

export const THUMB_DIR_NAME = "thumbs";
const DEFAULT_MAX_PX = 800;
const DEFAULT_QUALITY = 82;
/** 小于该体积的原图不值得再生成缩略图（直接复用原图） */
const SKIP_BELOW_BYTES = 200 * 1024;

export interface ThumbOptions {
  /** 最长边（默认 800） */
  maxPx?: number;
  /** JPEG 质量（默认 82） */
  quality?: number;
  /** 小于该体积直接复用原图（默认 200KB） */
  skipBelowBytes?: number;
}

export interface ThumbResult {
  /** 实际可读的图片路径（缩略图或原图） */
  path: string;
  /** 本次是否新生成了缩略图 */
  generated: boolean;
  /** 由哪个工具生成（sharp / magick / convert / sips / original） */
  via: string;
}

// ── 并发限制（简单信号量，避免同时解码多张 4K 图） ──
let running = 0;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (running < 2) { running++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  running++;
}
function release(): void {
  running = Math.max(0, running - 1);
  const next = waiters.shift();
  if (next) next();
}

/**
 * 目标缩略图路径：与原图同目录下的 thumbs/。
 * 默认规则：png → png（可能有透明通道），其余 → jpg；
 * 若 sharp 判定「无透明通道」，实际会改写成 jpg（体积可小 5–10 倍）。
 */
export function thumbPathFor(srcPath: string, forceJpeg = false): { out: string; ext: string } {
  const slash = srcPath.lastIndexOf("/");
  const dir = join(slash >= 0 ? srcPath.slice(0, slash) : ".", THUMB_DIR_NAME);
  const name = slash >= 0 ? srcPath.slice(slash + 1) : srcPath;
  const ext = (extname(name).slice(1) || "jpeg").toLowerCase();
  const outExt = forceJpeg ? "jpg" : ext === "png" ? "png" : "jpg";
  const base = ext ? name.slice(0, name.length - ext.length - 1) : name;
  return { out: join(dir, `${base}.${outExt}`), ext: outExt };
}

/** 已存在的缩略图（jpg 或 png 任一） */
function existingThumb(srcPath: string): string | null {
  for (const candidate of [thumbPathFor(srcPath, true).out, thumbPathFor(srcPath).out]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 探测可执行文件是否存在（用 which，避免 shell:true） */
function hasBinary(bin: string): boolean {
  try {
    return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

interface SharpApi {
  /** sharp 函数本体（用于 metadata / stats 探测） */
  fn: any;
  /** 生成缩略图 */
  apply: (src: string, out: string, maxPx: number, quality: number) => Promise<void>;
}

/**
 * 动态加载 sharp（Next 的 optionalDependency）。
 * 注意 interop：在 Next 的 server bundle 里 `import("sharp")` 的形态可能是
 * `fn` / `{ default: fn }` / `{ default: { default: fn } }`，这里逐层解包，
 * 避免"看起来可用、实际回退到 ImageMagick/原图"的静默降级。
 */
async function loadSharp(): Promise<SharpApi | null> {
  try {
    const mod: any = await import("sharp");
    let fn: any = mod?.default ?? mod;
    if (typeof fn !== "function" && typeof fn?.default === "function") fn = fn.default;
    if (typeof fn !== "function") return null;
    return {
      fn,
      apply: async (src, out, maxPx, quality) => {
        const resize = { width: maxPx, height: maxPx, fit: "inside" as const, withoutEnlargement: true };
        const img = fn(src, { failOn: "none" }).rotate().resize(resize);
        if (out.endsWith(".png")) await img.png({ compressionLevel: 8 }).toFile(out);
        else await img.jpeg({ quality, mozjpeg: true }).toFile(out);
      },
    };
  } catch {
    return null;
  }
}

function runTool(bin: string, args: string[]): boolean {
  try {
    const r = spawnSync(bin, args, { stdio: "ignore", timeout: 20_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 当前环境可用的缩略图工具链（供部署自检脚本/日志使用） */
export async function thumbnailToolchain(): Promise<string[]> {
  const tools: string[] = [];
  if (await loadSharp()) tools.push("sharp");
  if (hasBinary("magick")) tools.push("magick");
  if (hasBinary("convert")) tools.push("convert");
  if (hasBinary("sips")) tools.push("sips");
  return tools;
}

/**
 * 确保缩略图存在并返回可读路径。任何环节失败都回退原图（不抛异常）。
 */
export async function ensureThumb(srcPath: string, opts: ThumbOptions = {}): Promise<ThumbResult> {
  const maxPx = opts.maxPx ?? DEFAULT_MAX_PX;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const skipBelow = opts.skipBelowBytes ?? SKIP_BELOW_BYTES;

  try {
    if (!existsSync(srcPath)) return { path: srcPath, generated: false, via: "original" };
    const size = statSync(srcPath).size;
    if (size > 0 && size < skipBelow) return { path: srcPath, generated: false, via: "original" };

    const cached = existingThumb(srcPath);
    if (cached) return { path: cached, generated: false, via: "cache" };

    const { out, ext } = thumbPathFor(srcPath);
    await acquire();
    try {
      mkdirSync(out.slice(0, out.lastIndexOf("/")) || ".", { recursive: true });
      const cached2 = existingThumb(srcPath);
      if (cached2) return { path: cached2, generated: false, via: "cache" };

      // 1) sharp（首选：异步、跨平台、无需系统包）
      //    JPEG 体积远小于 PNG；只有「确实带透明像素」时才保留 PNG。
      //    注意：设计/生图链路常产出 RGBA 但实际全不透明的照片（PIL 默认 RGBA），
      //    这类图也能安全转 JPEG —— 实测 4.2MB RGBA PNG → 数百 KB JPEG。
      const sharpApi = await loadSharp();
      if (sharpApi) {
        try {
          const pipeline = sharpApi.fn(srcPath, { failOn: "none" });
          const meta = await pipeline.clone().metadata();
          let sharpOut = thumbPathFor(srcPath, true).out; // 默认 JPEG
          if (meta?.hasAlpha) {
            const st = await pipeline.clone().stats();
            const alpha = st?.channels?.[3];
            const fullyOpaque = !alpha || Number(alpha.min) >= 255;
            if (!fullyOpaque) sharpOut = thumbPathFor(srcPath).out; // 真有透明 → PNG
          }
          await sharpApi.apply(srcPath, sharpOut, maxPx, quality);
          if (existsSync(sharpOut)) return { path: sharpOut, generated: true, via: "sharp" };
        } catch (e) {
          console.warn("[thumb] sharp 生成失败，回退其它工具：", e instanceof Error ? e.message : e);
        }
      }

      // 2) ImageMagick（magick 新命令 / convert 老命令）
      const imArgs = [`-resize`, `${maxPx}x${maxPx}>`, `-quality`, String(quality), srcPath, out];
      if (hasBinary("magick") && runTool("magick", imArgs) && existsSync(out)) {
        return { path: out, generated: true, via: "magick" };
      }
      if (hasBinary("convert") && runTool("convert", imArgs) && existsSync(out)) {
        return { path: out, generated: true, via: "convert" };
      }

      // 3) macOS sips（保留本地开发兼容）
      if (hasBinary("sips")) {
        const sipsArgs = ["-Z", String(maxPx), "-s", "format", ext === "png" ? "png" : "jpeg", srcPath, "--out", out];
        if (runTool("sips", sipsArgs) && existsSync(out)) {
          return { path: out, generated: true, via: "sips" };
        }
      }
    } finally {
      release();
    }
  } catch {}

  // 4) 全部失败：用原图（旧行为）
  return { path: srcPath, generated: false, via: "original" };
}
