/**
 * customer-store.ts — 客户档案抽象层
 *
 * 当前实现：JSON 文件系统（customers/<id>/profile.json）
 * 以后换 SQLite：只改这个文件的内部实现，接口保持不变。
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from "fs";
import { join, extname, resolve, sep } from "path";

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

const CUSTOMERS_DIR = join(process.cwd(), "customers");

function ensureDir() { if (!existsSync(CUSTOMERS_DIR)) mkdirSync(CUSTOMERS_DIR, { recursive: true }); }

// ===== 安全校验 =====

/**
 * 拒绝可用于路径穿越的客户 ID。
 * 宽松策略：只拦截会造成目录逃逸的输入（分隔符、相对路径、隐藏目录），
 * 不强制字符集，避免破坏磁盘上已有的合法目录名。
 */
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

/** 断言 target 解析后仍位于 base 之内（防路径越界） */
function assertInside(base: string, target: string): void {
  if (!resolve(target).startsWith(resolve(base) + sep)) {
    throw new Error("路径越界");
  }
}

function customerDir(id: string) {
  assertSafeId(id);
  return join(CUSTOMERS_DIR, id);
}
function profilePath(id: string) {
  assertSafeId(id);
  return join(customerDir(id), "profile.json");
}

// ===== 公开 API =====

/** 列出所有客户 */
export function listCustomers(): CustomerProfile[] {
  ensureDir();
  const ids = readdirSync(CUSTOMERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
  return ids.map((id) => getCustomer(id)).filter(Boolean) as CustomerProfile[];
}

/** 获取单个客户 */
export function getCustomer(id: string): CustomerProfile | null {
  const p = profilePath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

/** 创建客户（目录 + profile.json） */
export function createCustomer(name: string): CustomerProfile {
  ensureDir();
  const id = sanitizeId(name);
  const dir = customerDir(id);
  if (existsSync(dir)) throw new Error(`客户 "${id}" 已存在`);

  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const profile: CustomerProfile = { id, name, createdAt: now, updatedAt: now };
  writeFileSync(profilePath(id), JSON.stringify(profile, null, 2), "utf-8");
  return profile;
}

/** 更新客户信息 */
export function updateCustomer(id: string, updates: Partial<CustomerProfile>): CustomerProfile {
  const current = getCustomer(id);
  if (!current) throw new Error(`客户 "${id}" 不存在`);
  const merged = { ...current, ...updates, id: current.id, updatedAt: new Date().toISOString() };
  writeFileSync(profilePath(id), JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

/** 删除客户及其全部数据 */
export function deleteCustomer(id: string): void {
  const dir = resolve(customerDir(id));
  assertInside(CUSTOMERS_DIR, dir); // 双保险：即便 ID 校验被绕过也不允许删到 customers/ 之外
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

/** 获取客户目录下文件的绝对路径 */
export function getCustomerFilePath(id: string, filename: string): string | null {
  if (!filename || filename === "." || filename === "..") return null;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return null;
  const p = resolve(customerDir(id), filename);
  assertInside(CUSTOMERS_DIR, p); // 防 logo/modelRef 等字段被注入 "../" 后越界读取
  return existsSync(p) ? p : null;
}

/** 客户 Logo 的 base64 data URL */
export function getCustomerLogoDataUrl(id: string): string | null {
  const profile = getCustomer(id);
  if (!profile?.logo) return null;
  const fp = getCustomerFilePath(id, profile.logo);
  if (!fp) return null;
  const ext = extname(fp).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const b64 = readFileSync(fp).toString("base64");
  return `data:${mime};base64,${b64}`;
}

/** 客户模特参考图的 base64 data URL */
export function getCustomerModelRefDataUrl(id: string): string | null {
  const profile = getCustomer(id);
  if (!profile?.modelRef) return null;
  const fp = getCustomerFilePath(id, profile.modelRef);
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
