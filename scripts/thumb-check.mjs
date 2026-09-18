#!/usr/bin/env node
/**
 * 缩略图工具链自检（部署后确认「预览提速」是否可用）
 *
 * 用法：node scripts/thumb-check.mjs [待测图片路径]
 *   - 不带参数：只报告可用工具链
 *   - 带图片：实际生成一次缩略图并报告压缩比
 *
 * 说明：应用侧 `lib/image-thumb.ts` 的优先级是
 *   sharp（随 Next 安装，跨平台，无需系统包）→ ImageMagick(magick/convert) → macOS sips → 回退原图。
 * 本脚本用同样的探测方式，便于在 ECS 上快速确认；不依赖 TS 运行时。
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const has = (bin) => spawnSync("which", [bin], { stdio: "ignore" }).status === 0;

console.log("=== 缩略图工具链自检 ===");

let sharp = null;
try {
  const mod = await import("sharp");
  sharp = mod?.default ?? mod;
} catch {}
console.log("  sharp   :", sharp ? "可用 ✓（首选：异步、跨平台、无需系统包）" : "不可用 ✗（检查 npm ci 是否完整）");
for (const t of ["magick", "convert", "sips"]) {
  console.log(`  ${t.padEnd(7)}:`, has(t) ? "可用" : "无");
}
if (!sharp && !has("magick") && !has("convert") && !has("sips")) {
  console.log("  ⚠ 无任何缩略图工具：预览会回退原图（Linux 上请 `apt install imagemagick` 或确认 sharp 已装）");
}

const target = process.argv[2];
if (target) {
  if (!existsSync(target)) {
    console.log("  待测图片不存在:", target);
    process.exit(1);
  }
  const before = statSync(target).size;
  console.log(`\n  待测图片: ${target}（${(before / 1024).toFixed(0)} KB）`);

  if (sharp) {
    const dir = mkdtempSync(join(tmpdir(), "thumb-check-"));
    const out = join(dir, `probe${extname(target).toLowerCase() || ".jpg"}`);
    const maxPx = 800;
    try {
      const pipeline = sharp(target, { failOn: "none" });
      const meta = await pipeline.clone().metadata();
      let jpegOut = join(dir, "probe.jpg");
      if (meta?.hasAlpha) {
        const st = await pipeline.clone().stats();
        const alpha = st?.channels?.[3];
        const fullyOpaque = !alpha || Number(alpha.min) >= 255;
        console.log("  透明通道:", fullyOpaque ? "存在但全不透明 → 可转 JPEG" : "有真实透明 → 保留 PNG");
      }
      const dest = out.endsWith(".png") && meta?.hasAlpha ? out : jpegOut;
      const resize = { width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true };
      const p = sharp(target, { failOn: "none" }).rotate().resize(resize);
      if (dest.endsWith(".png")) await p.png({ compressionLevel: 8 }).toFile(dest);
      else await p.jpeg({ quality: 82, mozjpeg: true }).toFile(dest);
      const after = statSync(dest).size;
      console.log(`  缩略图: ${(after / 1024).toFixed(0)} KB（${dest.endsWith(".png") ? "PNG" : "JPEG"}，最长边 ${maxPx}px）`);
      console.log(`  压缩比: ${(before / Math.max(1, after)).toFixed(1)}x → 预览流量下降 ${(100 - (after / before) * 100).toFixed(0)}%`);
    } catch (e) {
      console.log("  ✗ 生成失败:", e instanceof Error ? e.message : e);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log("  跳过实测（sharp 不可用）");
  }
}
