// Filesystem-based generation history — reads from ~/Downloads/aplus-builder/
// Replaces the old IndexedDB-based approach. History now mirrors what's on disk.

export interface HistoryEntry {
  dirName: string;
  timestamp: number;
  imageCount: number;
  variantNames: string[];
}

export interface LoadedOutput {
  html: string;
  images: { name: string; base64: string; mime: string }[];
  variants: { name: string; html: string }[];
}

export async function getHistory(): Promise<HistoryEntry[]> {
  try {
    const res = await fetch("/api/list-history");
    const data = await res.json();
    return data.entries || [];
  } catch {
    return [];
  }
}

export async function loadOutput(dirName: string): Promise<LoadedOutput | null> {
  try {
    const res = await fetch(
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

// Stubs for backward compatibility
export async function saveToHistory(_entry: unknown): Promise<void> {
  // No-op: output is already on disk
}

export async function deleteFromHistory(_id: string): Promise<void> {
  // No-op: deletion from disk is handled elsewhere
}
