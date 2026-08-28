/**
 * customer-store.ts — 客户档案抽象层（数据库驱动）
 *
 * 元数据存 SQLite customers 表；媒体文件（Logo、模特图）仍在磁盘
 * （<customersRoot>/<id>/ 目录），库里只存文件名。
 *
 * 多用户：所有公开函数可传 userId（默认 "admin"）；
 * admin 沿用旧磁盘布局，其他用户隔离到 <OUTPUT_BASE>/<userId>/customers/。
 */

import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join, extname, resolve, sep } from "path";
import { db, ensureMigrated } from "@/lib/db";
import { userBase } from "@/lib/config";

export interface CustomerProfile {
  id: string;
  name: string;
  /** 品牌 Logo 文件名（相对客户目录），如 "logo.png" */
  logo?: string;
  /** 专属模特参考图文件名，如 "model-ref.jpg" */
  modelRef?: string;
  /** 定制 HTML 模板文件名，如 "template.html" */
  template?: string;
  /** 尺码表 CSV 内容（文本，直接存 JSON 内） */
  sizeChartCsv?: string;
  /** 其他要求 / 备注 */
  requirements?: string;
  /** 默认排版风格 */
  defaultStyle?: string;
  /** 默认模特偏好 */
  defaultModel?: string;
  /** 备注 */
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** 用户客户的磁盘根目录：admin 沿用旧布局，其余用户隔离到各自产出目录下 */
function customersRoot(userId: string): string {
  return userId && userId !== "admin"
    ? join(userBase(userId), "customers")
    : join(process.cwd(), "customers");
}

// ===== 安全校验 =====

function assertSafeId(id: string): void {
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.startsWith(".") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error(`非法客户 ID`);
  }
}

function assertInside(base: string, target: string): void {
  if (!resolve(target).startsWith(resolve(base) + sep)) {
    throw new Error("路径越界");
  }
}

function customerDir(userId: string, id: string) {
  assertSafeId(id);
  return join(customersRoot(userId), id);
}

// ===== 行 ↔ 对象映射 =====

function rowToProfile(row: Record<string, unknown>): CustomerProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    logo: row.logo ? String(row.logo) : undefined,
    modelRef: row.model_ref ? String(row.model_ref) : undefined,
    template: row.template ? String(row.template) : undefined,
    sizeChartCsv: row.size_chart_csv ? String(row.size_chart_csv) : undefined,
    requirements: row.requirements ? String(row.requirements) : undefined,
    defaultStyle: row.default_style ? String(row.default_style) : undefined,
    defaultModel: row.default_model ? String(row.default_model) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toUndef(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

// ===== 公开 API =====

/** 列出某用户的所有客户 */
export function listCustomers(userId: string = "admin"): CustomerProfile[] {
  ensureMigrated(); // 首次查询时执行旧数据迁移
  const rows = db
    .prepare(`SELECT * FROM customers WHERE user_id = ? ORDER BY created_at ASC`)
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToProfile);
}

/** 获取单个客户 */
export function getCustomer(id: string, userId: string = "admin"): CustomerProfile | null {
  ensureMigrated();
  const row = db
    .prepare(`SELECT * FROM customers WHERE user_id = ? AND id = ?`)
    .get(userId, id) as Record<string, unknown> | undefined;
  return row ? rowToProfile(row) : null;
}

/** 创建客户（DB 记录 + 磁盘目录） */
export function createCustomer(name: string, userId: string = "admin"): CustomerProfile {
  const id = sanitizeId(name);
  if (getCustomer(id, userId)) throw new Error(`客户 "${id}" 已存在`);

  const dir = customerDir(userId, id);
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO customers (user_id, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, id, name, now, now);
  return { id, name, createdAt: now, updatedAt: now };
}

/** 更新客户信息 */
export function updateCustomer(
  id: string,
  updates: Partial<CustomerProfile>,
  userId: string = "admin",
): CustomerProfile {
  const current = getCustomer(id, userId);
  if (!current) throw new Error(`客户 "${id}" 不存在`);
  const merged = { ...current, ...updates, id: current.id, updatedAt: new Date().toISOString() };

  db.prepare(
    `UPDATE customers SET
       name = ?, logo = ?, model_ref = ?, template = ?, size_chart_csv = ?,
       requirements = ?, default_style = ?, default_model = ?, custom_template_id = ?,
       notes = ?, updated_at = ?
     WHERE user_id = ? AND id = ?`,
  ).run(
    merged.name,
    toUndef(merged.logo) ?? null,
    toUndef(merged.modelRef) ?? null,
    toUndef(merged.template) ?? null,
    toUndef(merged.sizeChartCsv) ?? null,
    toUndef(merged.requirements) ?? null,
    toUndef(merged.defaultStyle) ?? null,
    toUndef(merged.defaultModel) ?? null,
    toUndef((merged as { customTemplateId?: string }).customTemplateId) ?? null,
    toUndef(merged.notes) ?? null,
    merged.updatedAt,
    userId,
    id,
  );
  return merged;
}

/** 删除客户：DB 记录 + 磁盘目录（含媒体文件） */
export function deleteCustomer(id: string, userId: string = "admin"): void {
  const dir = resolve(customerDir(userId, id));
  assertInside(customersRoot(userId), dir);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  db.prepare(`DELETE FROM customers WHERE user_id = ? AND id = ?`).run(userId, id);
}

/** 获取客户目录的绝对路径（供上传等写入场景使用） */
export function getCustomerDir(id: string, userId: string = "admin"): string {
  const dir = resolve(customerDir(userId, id));
  assertInside(customersRoot(userId), dir);
  return dir;
}

/** 获取客户目录下文件的绝对路径 */
export function getCustomerFilePath(
  id: string,
  filename: string,
  userId: string = "admin",
): string | null {
  if (!filename || filename === "." || filename === "..") return null;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return null;
  const p = resolve(customerDir(userId, id), filename);
  assertInside(customersRoot(userId), p);
  return existsSync(p) ? p : null;
}

/** 客户 Logo 的 base64 data URL */
export function getCustomerLogoDataUrl(id: string, userId: string = "admin"): string | null {
  const profile = getCustomer(id, userId);
  if (!profile?.logo) return null;
  const fp = getCustomerFilePath(id, profile.logo, userId);
  if (!fp) return null;
  const ext = extname(fp).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const b64 = readFileSync(fp).toString("base64");
  return `data:${mime};base64,${b64}`;
}

/** 客户模特参考图的 base64 data URL */
export function getCustomerModelRefDataUrl(id: string, userId: string = "admin"): string | null {
  const profile = getCustomer(id, userId);
  if (!profile?.modelRef) return null;
  const fp = getCustomerFilePath(id, profile.modelRef, userId);
  if (!fp) return null;
  const ext = extname(fp).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const b64 = readFileSync(fp).toString("base64");
  return `data:${mime};base64,${b64}`;
}

// ===== 内部 =====

function sanitizeId(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "unnamed";
}
