// Filesystem-based generation history — reads from ~/Downloads/aplus-builder/
// Replaces the old IndexedDB-based approach. History now mirrors what's on disk.

import { apiFetch } from "./apiFetch";

export interface HistoryEntry {
  dirName: string;
  timestamp: number;
  imageCount: number;
  variantNames: string[];
  /** 第一张产出图相对 ~/Downloads/aplus-builder 的路径（用于列表缩略图），无图时为 null */
  firstImage?: string | null;
}

export interface LoadedOutput {
  html: string;
  images: { name: string; base64: string; mime: string }[];
  variants: { name: string; html: string }[];
  /** 市场潜力预测（原始 JSON，可能为空） */
  prediction?: Record<string, unknown> | null;
}

export async function getHistory(): Promise<HistoryEntry[]> {
  try {
    const res = await apiFetch("/api/list-history");
    const data = await res.json();
    return data.entries || [];
  } catch {
    return [];
  }
}

export async function loadOutput(dirName: string): Promise<LoadedOutput | null> {
  try {
    const res = await apiFetch(
      `/api/load-output?dir=${encodeURIComponent(dirName)}`,
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Rewrite relative image paths in HTML to use the output API endpoint,
// so images can be displayed in the iframe preview.
export function rewriteImagePaths(html: string, dirName: string): string {
  return html.replace(
    /(src|href)=["']\.\/([^"']+)["']/g,
    (_m, attr, file) =>
      `${attr}="/api/output/${encodeURIComponent(dirName)}/${file}"`,
  );
}

/**
 * 把产出文件的相对路径（可能含中文、空格、多级目录）转成 /api/output 的 URL。
 * 逐段 encodeURIComponent，保证嵌套目录（客户/产品）与特殊字符文件名都能正确请求。
 */
export function outputImageUrl(relPath: string): string {
  return `/api/output/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

// Stubs for backward compatibility
export async function saveToHistory(_entry: unknown): Promise<void> {
  // No-op: output is already on disk
}

export async function deleteFromHistory(_id: string): Promise<void> {
  // No-op: deletion from disk is handled elsewhere
}
