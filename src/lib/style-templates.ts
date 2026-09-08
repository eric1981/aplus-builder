/**
 * 复刻风格模板元数据：customer-templates/*.html 的归属与展示
 *
 * - style_templates 表：id(=模板文件名去 .html) / owner_id / filename / thumb / created_at
 * - 可见性：本人 + admin（owner_id = 自己 或 admin）
 * - 手工旧模板（065b2155 等）迁移时归 admin，保持全用户可用
 */
import { db, ensureMigrated } from "@/lib/db";
import { readdirSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, basename } from "path";

/** 模板文件实际目录 */
export const TEMPLATES_DIR = join(process.cwd(), "customer-templates");
/** 缩略图目录（public 下，前端可直接访问） */
export const THUMBS_DIR = join(process.cwd(), "public", "template-thumbs");
/** 缩略图公网 URL 前缀 */
export const THUMBS_URL = "/template-thumbs";

export interface StyleTemplate {
  id: string;
  ownerId: string;
  filename: string;
  thumb: string | null; // 相对 public 的 URL，如 /template-thumbs/xxx.png
  createdAt: number;
}

function toTpl(row: Record<string, unknown>): StyleTemplate {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    filename: String(row.filename),
    thumb: row.thumb ? String(row.thumb) : null,
    createdAt: Number(row.created_at || 0),
  };
}

/** 注册模板（复刻完成时调用）；重复 id 则跳过（保留首次归属） */
export function registerTemplate(templateId: string, filename: string, ownerId: string): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO style_templates (id, owner_id, filename, created_at) VALUES (?, ?, ?, ?)`,
    ).run(templateId, ownerId, filename, Date.now());
  } catch {}
}

/** 记录缩略图路径 */
export function setTemplateThumb(templateId: string, thumbUrl: string): void {
  try {
    db.prepare(`UPDATE style_templates SET thumb = ? WHERE id = ?`).run(thumbUrl, templateId);
  } catch {}
}

/** 当前用户可见模板（本人复刻 + admin 的）；admin 可见全部 */
export function listVisibleTemplates(userId: string): StyleTemplate[] {
  ensureMigrated();
  try {
    const rows = userId === "admin"
      ? db.prepare(`SELECT * FROM style_templates ORDER BY created_at DESC`).all()
      : db.prepare(`SELECT * FROM style_templates WHERE owner_id = ? OR owner_id = 'admin' ORDER BY created_at DESC`).all(userId);
    return rows.map(toTpl);
  } catch {
    return [];
  }
}

/** 删除模板（owner 本人或 admin）：删元数据 + 磁盘 HTML 文件 + 缩略图 */
export function deleteTemplate(templateId: string, userId: string): { ok: boolean; reason?: string } {
  try {
    const row = db.prepare(`SELECT * FROM style_templates WHERE id = ?`).get(templateId) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, reason: "模板不存在" };
    if (String(row.owner_id) !== userId && userId !== "admin") {
      return { ok: false, reason: "无权删除他人模板" };
    }
    // 删主 HTML + 缩略图
    try {
      const f = String(row.filename);
      if (existsSync(join(TEMPLATES_DIR, f))) unlinkSync(join(TEMPLATES_DIR, f));
      const thumbPath = join(THUMBS_DIR, `${templateId}.png`);
      if (existsSync(thumbPath)) unlinkSync(thumbPath);
    } catch {}
    db.prepare(`DELETE FROM style_templates WHERE id = ?`).run(templateId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "删除失败" };
  }
}

/** 从模板 HTML 文件名推断（无元数据时的兜底，如旧文件） */
export function inferTemplateId(filename: string): string {
  return basename(filename, ".html");
}

/** 迁移：把 customer-templates 里的 .html 首次注册（未在表里的归 admin） */
export function migrateLegacyTemplates(): number {
  let added = 0;
  try {
    if (!existsSync(TEMPLATES_DIR)) return 0;
    const existing = new Set(
      (db.prepare(`SELECT id FROM style_templates`).all() as { id: string }[]).map((r) => r.id),
    );
    for (const f of readdirSync(TEMPLATES_DIR)) {
      if (!f.endsWith(".html") || f.startsWith(".")) continue;
      const id = inferTemplateId(f);
      // 复刻产生的辅助文件（_agent.log/_prompt.txt 等不是 .html，天然排除）
      if (!existing.has(id)) {
        db.prepare(`INSERT OR IGNORE INTO style_templates (id, owner_id, filename, created_at) VALUES (?, 'admin', ?, ?)`)
          .run(id, f, Date.now());
        added++;
      }
    }
    // 清理：表里有但磁盘已删的
    const diskFiles = new Set(readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".html")));
    const stale = db.prepare(`SELECT id, filename FROM style_templates`).all() as { id: string; filename: string }[];
    for (const r of stale) {
      if (!diskFiles.has(r.filename)) db.prepare(`DELETE FROM style_templates WHERE id = ?`).run(r.id);
    }
  } catch {}
  return added;
}

/** 生成缩略图（异步：Chrome 截图模板 HTML 首屏） */
export async function ensureThumbnail(templateId: string): Promise<string | null> {
  try {
    mkdirSync(THUMBS_DIR, { recursive: true });
    const tplPath = join(TEMPLATES_DIR, `${templateId}.html`);
    if (!existsSync(tplPath)) return null;
    const dest = join(THUMBS_DIR, `${templateId}.png`);
    const url = `${THUMBS_URL}/${templateId}.png`;
    // 已有缩略图则直接返回
    if (existsSync(dest)) return url;
    const { screenshotPage } = await import("@/lib/screenshot");
    const ok = await screenshotPage({ htmlPath: tplPath, destPath: dest });
    if (ok) {
      setTemplateThumb(templateId, url);
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

/** 复刻任务完成时：注册 + 生成缩略图（不阻塞返回） */
export async function onTemplateCreated(templateId: string, ownerId: string): Promise<void> {
  registerTemplate(templateId, `${templateId}.html`, ownerId);
  // 后台生成缩略图（Chrome 截图，可能较慢）
  ensureThumbnail(templateId).catch(() => {});
}
