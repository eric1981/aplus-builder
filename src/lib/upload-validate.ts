/**
 * 上传文件校验：大小限制（设置中心 maxUploadMb 可配）+ 图片 magic bytes 嗅探。
 * 扩展名以文件真实内容为准，不信任客户端声明的 MIME type。
 */
import { getSettingInt } from "@/lib/settings";

export type SniffedImageExt = "png" | "webp" | "jpg";

/** 当前上传大小上限（字节），管理后台可改 */
export function getMaxUploadBytes(): number {
  return getSettingInt("maxUploadMb", 15) * 1024 * 1024;
}

/** 通过文件头判断真实图片格式，非图片返回 null */
export function sniffImageExt(buf: Buffer): SniffedImageExt | null {
  if (!buf || buf.length < 12) return null;
  // PNG: \x89PNG\r\n\x1a\n
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "png";
  }
  // JPEG: \xff\xd8\xff
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  // WebP: RIFF....WEBP
  if (
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/** 校验上传的 Blob：大小 + 图片格式，返回 (buffer, ext)，不合法返回 null */
export async function validateImageBlob(
  blob: Blob,
): Promise<{ buffer: Buffer; ext: SniffedImageExt } | null> {
  if (!blob || blob.size <= 0) return null;
  if (blob.size > getMaxUploadBytes()) return null;
  const buffer = Buffer.from(await blob.arrayBuffer());
  const ext = sniffImageExt(buffer);
  if (!ext) return null;
  return { buffer, ext };
}
