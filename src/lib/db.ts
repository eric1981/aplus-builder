/**
 * SQLite 数据层（产出数据持久化）：
 * - 数据库文件：<项目>/data/app.db（WAL 模式，崩溃安全）
 * - 表：users / customers / tasks / audit_log / quota
 * - 媒体文件（图片、HTML 交付物）仍在磁盘，库里只存指向磁盘的元数据
 * - 首次启动自动从旧存储（users.json / tasks.json / quota.json / customers/ 磁盘扫描）迁移
 *
 * 使用 Node 24 内置 node:sqlite（零依赖）。若运行环境不支持会抛出明确错误。
 */
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, relative } from "path";
import { DatabaseSync } from "node:sqlite";
import { OUTPUT_BASE } from "./config";

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "app.db");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** 构建期多 worker 并发打开同一库文件时可能遇到写锁，重试等待 */
function withRetry<T>(fn: () => T, attempts = 10): T {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/locked|busy/i.test(msg)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  throw lastErr;
}

function execWithRetry(database: DatabaseSync, sql: string) {
  withRetry(() => database.exec(sql));
}

export function openDb(): DatabaseSync {
  ensureDir();
  const database = new DatabaseSync(DB_PATH);
  execWithRetry(database, "PRAGMA journal_mode = WAL;");
  execWithRetry(database, "PRAGMA foreign_keys = ON;");
  // 并发写（如 next build 多 worker 评估路由模块）时等待锁而非立即报错
  execWithRetry(database, "PRAGMA busy_timeout = 5000;");
  return database;
}

export const db = openDb();

/**
 * 事务包装（安全 P0-5）：多语句写操作必须原子，否则中途失败会留下
 * 「扣了积分没流水」「建了用户没赠送流水」这类账目不一致。
 * 注意：fn 必须同步（node:sqlite 为同步 API），且不要嵌套调用。
 */
export function withTx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
}

/**
 * 积分流水幂等索引：仅对「按 ref 幂等」的流水类型生效
 * （payment.credit = 支付入账、task.refund = 任务失败退款），
 * 保证同一笔外部流水/同一个任务不会被重复入账。
 *
 * 刻意不做 (reason, ref) 全域唯一：admin.topup 的 ref 是备注文本，
 * 两次充值会撞唯一约束。存量数据若已有重复，索引创建失败也不阻断启动。
 */
function ensureLedgerIdempotencyIndex() {
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idem ON credit_ledger(reason, ref)
       WHERE ref IS NOT NULL AND reason IN ('payment.credit', 'task.refund')`,
    );
  } catch (e) {
    console.warn(
      "[db] 流水幂等索引创建失败（不影响启动）：",
      e instanceof Error ? e.message : e,
    );
  }
}

/** 安全初始化：schema + 存量列升级 + 旧数据迁移，均带锁重试 */
function safeInit() {
  withRetry(() => initSchema());
  withRetry(() => ensureUserColumns());
  withRetry(() => ensureTasksColumns());
  withRetry(() => ensureLedgerIdempotencyIndex());
}

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE,
      token         TEXT,
      password_hash TEXT,
      role          TEXT NOT NULL DEFAULT 'user',
      disabled      INTEGER NOT NULL DEFAULT 0,
      daily_limit   INTEGER,
      monthly_limit INTEGER,
      credits       INTEGER NOT NULL DEFAULT 20,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS customers (
      user_id           TEXT NOT NULL DEFAULT 'admin',
      id                TEXT NOT NULL,
      name              TEXT NOT NULL,
      logo              TEXT,
      model_ref         TEXT,
      template          TEXT,
      size_chart_csv    TEXT,
      requirements      TEXT,
      default_style     TEXT,
      default_model     TEXT,
      custom_template_id TEXT,
      notes             TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id           TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL DEFAULT 'admin',
      status            TEXT NOT NULL,
      mode              TEXT NOT NULL DEFAULT 'detail',
      work_dir          TEXT,
      product_name      TEXT,
      dir_name          TEXT,
      image_count       INTEGER NOT NULL DEFAULT 0,
      first_image       TEXT,
      variant_names     TEXT,
      custom_template_id TEXT,
      attempts          INTEGER NOT NULL DEFAULT 1,
      error             TEXT,
      prediction        TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, status, created_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'admin',
      action  TEXT NOT NULL,
      detail  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, ts);

    CREATE TABLE IF NOT EXISTS quota (
      day         TEXT PRIMARY KEY,
      day_count   INTEGER NOT NULL DEFAULT 0,
      month       TEXT NOT NULL,
      month_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS credit_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      delta      INTEGER NOT NULL,            -- 正=发放 负=消耗
      reason     TEXT NOT NULL,               -- 如 'task.detail' / 'task.single' / 'style_extract' / 'admin.topup'
      balance    INTEGER NOT NULL,            -- 变动后余额（快照，便于审计）
      ref        TEXT,                        -- 关联（task_id / admin 备注）
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at);

    -- 分销绑定：客户 → 代理（单层）
    CREATE TABLE IF NOT EXISTS referrals (
      user_id    TEXT PRIMARY KEY,            -- 被绑定的客户
      agent_id   TEXT NOT NULL,               -- 代理
      source     TEXT NOT NULL DEFAULT 'manual',  -- qr=扫码 / manual=管理员手动
      note       TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_agent ON referrals(agent_id);

    -- 代理佣金流水（安全 P0-6）：消耗发生时按**当时**比例逐笔固化，
    -- 避免"实时用当前比例重算历史收益"导致改比例即篡改历史。
    -- reversed=1 表示对应消耗已退款（不再计入收益，但保留审计痕迹）。
    CREATE TABLE IF NOT EXISTS commission_ledger (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT NOT NULL,
      client_id       TEXT NOT NULL,
      consumption_ref TEXT,                    -- 关联消耗（taskId）
      reason          TEXT,                    -- 消耗原因
      base_amount     INTEGER NOT NULL,        -- 该笔消耗积分（正数）
      rate            INTEGER NOT NULL,        -- 计提时的分成比例 %
      amount          INTEGER NOT NULL,        -- 固化的佣金积分
      reversed        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_commission_agent ON commission_ledger(agent_id, created_at);
    -- 幂等：同一客户的同一笔消耗只计提一次佣金（consumption_ref 为空的手工补录不受限）
    CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_ref
      ON commission_ledger(client_id, consumption_ref) WHERE consumption_ref IS NOT NULL;

    -- 支付订单（接支付通道的核心账本）
    -- 流程：pending → paid（入账积分）→ refunded（回收积分并退款）
    CREATE TABLE IF NOT EXISTS orders (
      id           TEXT PRIMARY KEY,               -- 本地订单号（ord_xxx）
      user_id      TEXT NOT NULL,
      credits      INTEGER NOT NULL,               -- 购买积分数
      amount_cents INTEGER NOT NULL,               -- 应付金额（分）
      currency     TEXT NOT NULL DEFAULT 'CNY',
      provider     TEXT NOT NULL DEFAULT 'manual', -- manual/wechat/alipay/stripe/generic
      status       TEXT NOT NULL DEFAULT 'pending',-- pending/paid/refunded/canceled
      external_id  TEXT,                           -- 支付方交易号（入账幂等键）
      note         TEXT,
      created_at   INTEGER NOT NULL,
      paid_at      INTEGER,
      refunded_at  INTEGER,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
    -- 幂等：同一个支付方交易号只能落在一张订单上（防回调重放重复入账）
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external
      ON orders(external_id) WHERE external_id IS NOT NULL;

    -- 支付回调事件（审计 + 幂等：同一事件只处理一次）
    CREATE TABLE IF NOT EXISTS payment_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      provider     TEXT NOT NULL,
      event_id     TEXT,
      event_type   TEXT NOT NULL,
      order_id     TEXT,
      external_id  TEXT,
      amount_cents INTEGER,
      signature_ok INTEGER NOT NULL DEFAULT 0,
      applied      INTEGER NOT NULL DEFAULT 0,     -- 是否实际改动了订单/积分
      reason       TEXT,                           -- 未处理原因（签名失败/金额不符/订单不存在…）
      payload      TEXT,                           -- 原始报文（脱敏后审计）
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pay_events_created ON payment_events(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_events_idem
      ON payment_events(provider, event_id) WHERE event_id IS NOT NULL;

    -- 复刻风格模板元数据（customer-templates/*.html）
    -- id = 模板文件名（不含 .html，复刻模板为 taskId，手工模板为原名）
    CREATE TABLE IF NOT EXISTS style_templates (
      id           TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL,             -- 谁复刻的（手工模板归 admin）
      filename     TEXT NOT NULL,             -- 实际文件名 xxx.html
      thumb        TEXT,                      -- 缩略图相对路径（public 下或磁盘）
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_style_tpl_owner ON style_templates(owner_id);
  `);
}

/** 存量库升级：tasks 表补充预测列 */
function ensureTasksColumns() {
  try {
    const cols = db
      .prepare(`PRAGMA table_info(tasks)`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === "prediction")) {
      db.exec(`ALTER TABLE tasks ADD COLUMN prediction TEXT`);
    }
  } catch {}
}

/** 存量库升级：users 表补充认证相关列（SQLite 无 ADD COLUMN IF NOT EXISTS） */
function ensureUserColumns() {
  try {
    const cols = db
      .prepare(`PRAGMA table_info(users)`)
      .all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    const adds: { col: string; ddl: string }[] = [
      { col: "email", ddl: `ALTER TABLE users ADD COLUMN email TEXT` },
      { col: "token", ddl: `ALTER TABLE users ADD COLUMN token TEXT` },
      { col: "password_hash", ddl: `ALTER TABLE users ADD COLUMN password_hash TEXT` },
      { col: "disabled", ddl: `ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0` },
      { col: "daily_limit", ddl: `ALTER TABLE users ADD COLUMN daily_limit INTEGER` },
      { col: "monthly_limit", ddl: `ALTER TABLE users ADD COLUMN monthly_limit INTEGER` },
      { col: "credits", ddl: `ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 20` },
      { col: "is_agent", ddl: `ALTER TABLE users ADD COLUMN is_agent INTEGER NOT NULL DEFAULT 0` },
      { col: "agent_code", ddl: `ALTER TABLE users ADD COLUMN agent_code TEXT` },
    ];
    for (const { col, ddl } of adds) {
      if (!names.has(col)) db.exec(ddl);
    }
  } catch {}
}

// ===== 一次性迁移（旧存储 → SQLite）=====

const IMAGE_RE = /\.(jpg|jpeg|png|webp)$/i;
const VARIANT_RE = /^variant_\d+\.html$/;

function scanTaskDir(absPath: string, dirName: string, userId: string, base: string) {
  const hasHtml =
    existsSync(join(absPath, "output", "index.html")) ||
    existsSync(join(absPath, "index.html"));
  if (!hasHtml) return;
  const scanPath = existsSync(join(absPath, "output"))
    ? join(absPath, "output")
    : absPath;
  let files: string[] = [];
  try {
    files = readdirSync(scanPath);
  } catch {
    return;
  }
  const images = files.filter((f) => IMAGE_RE.test(f)).sort();
  if (images.length === 0) return;
  const variants = files.filter((f) => VARIANT_RE.test(f)).sort();
  const firstImage =
    relative(base, join(scanPath, images[0]));
  db.prepare(
    `INSERT OR IGNORE INTO tasks
      (task_id, user_id, status, mode, product_name, dir_name, image_count, first_image, variant_names, attempts, error, created_at, updated_at)
     VALUES (?, ?, 'done', 'detail', ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
  ).run(
    `legacy-${userId}-${dirName}`,
    userId,
    dirName,
    dirName,
    images.length,
    firstImage,
    JSON.stringify(variants.map((f) => f.replace(".html", ""))),
    statSync(absPath).mtimeMs,
    Date.now(),
  );
}

/** 迁移一次旧数据：users.json / tasks.json / quota.json / customers/ 磁盘 / 产出目录扫描 */
export function migrateLegacy() {
  // 1) users：data/users.json → users 表
  if (countRows("users") === 0) {
    const usersFile = join(DATA_DIR, "users.json");
    try {
      if (existsSync(usersFile)) {
        const rows = JSON.parse(readFileSync(usersFile, "utf-8")) as {
          id: string; name: string; token: string; role?: string;
        }[];
        const ins = db.prepare(
          `INSERT OR IGNORE INTO users (id, name, token, role, created_at) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const u of rows) {
          if (!u?.id || !u?.token) continue;
          ins.run(u.id, u.name || u.id, u.token, u.role || "user", new Date().toISOString());
        }
      }
    } catch {}
  }

  // 2) tasks：data/tasks.json 的运行/排队记录 + 产出目录扫描（历史）
  const taskJsonFile = join(DATA_DIR, "tasks.json");
  try {
    if (existsSync(taskJsonFile)) {
      const rows = JSON.parse(readFileSync(taskJsonFile, "utf-8")) as {
        taskId: string; userId?: string; status: string; workDir: string;
        mode?: string; customTemplateId?: string; attempts?: number; createdAt?: number;
      }[];
      const ins = db.prepare(
        `INSERT OR IGNORE INTO tasks
          (task_id, user_id, status, mode, work_dir, custom_template_id, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const t of rows) {
        if (!t?.taskId) continue;
        ins.run(
          t.taskId,
          t.userId || "admin",
          t.status === "queued" ? "queued" : "running",
          t.mode || "detail",
          t.workDir,
          t.customTemplateId || null,
          t.attempts || 1,
          t.createdAt || Date.now(),
          Date.now(),
        );
      }
    }
  } catch {}

  // 产出目录扫描：admin 根目录 + 各用户子目录
  if (existsSync(OUTPUT_BASE)) {
    const topLevel = readdirSync(OUTPUT_BASE, { withFileTypes: true });
    for (const entry of topLevel) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const topPath = join(OUTPUT_BASE, entry.name);
      // 用户子目录（非 admin 用户的隔离目录：其下有 customers/ 与产品目录）
      if (existsSync(join(topPath, "customers"))) {
        // 该目录是某用户的数据根（该用户目录名即 userId）
        const userId = entry.name;
        const subDirs = readdirSync(topPath, { withFileTypes: true });
        for (const sub of subDirs) {
          if (!sub.isDirectory() || sub.name === "customers") continue;
          const subPath = join(topPath, sub.name);
          scanTaskDir(subPath, `${userId}/${sub.name}`, userId, topPath);
        }
        continue;
      }
      // admin 一级产品目录
      scanTaskDir(topPath, entry.name, "admin", OUTPUT_BASE);
      // admin 二级（客户/产品）
      if (existsSync(join(topPath, "output"))) continue;
      try {
        const subs = readdirSync(topPath, { withFileTypes: true });
        for (const sub of subs) {
          if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
          scanTaskDir(join(topPath, sub.name), `${entry.name}/${sub.name}`, "admin", OUTPUT_BASE);
        }
      } catch {}
    }
  }

  // 3) customers：customers/<id>/profile.json → customers 表
  if (countRows("customers") === 0) {
    const legacyCustomers = join(process.cwd(), "customers");
    try {
      if (existsSync(legacyCustomers)) {
        const ids = readdirSync(legacyCustomers, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => d.name);
        const ins = db.prepare(
          `INSERT OR IGNORE INTO customers
            (user_id, id, name, logo, model_ref, template, size_chart_csv, requirements,
             default_style, default_model, custom_template_id, notes, created_at, updated_at)
           VALUES ('admin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const id of ids) {
          try {
            const p = JSON.parse(
              readFileSync(join(legacyCustomers, id, "profile.json"), "utf-8"),
            );
            if (!p?.id) continue;
            ins.run(
              p.id, p.name || p.id, p.logo || null, p.modelRef || null, p.template || null,
              p.sizeChartCsv || null, p.requirements || null, p.defaultStyle || null,
              p.defaultModel || null, p.customTemplateId || null, p.notes || null,
              p.createdAt || new Date().toISOString(), p.updatedAt || new Date().toISOString(),
            );
          } catch {}
        }
      }
    } catch {}
  }

  // 4) quota：data/quota.json → quota 表
  if (countRows("quota") === 0) {
    const quotaFile = join(DATA_DIR, "quota.json");
    try {
      if (existsSync(quotaFile)) {
        const q = JSON.parse(readFileSync(quotaFile, "utf-8")) as {
          day?: string; dayCount?: number; month?: string; monthCount?: number;
        };
        if (q?.day) {
          db.prepare(
            `INSERT OR IGNORE INTO quota (day, day_count, month, month_count) VALUES (?, ?, ?, ?)`,
          ).run(q.day, q.dayCount || 0, q.month || q.day.slice(0, 7), q.monthCount || 0);
        }
      }
    } catch {}
  }

  // 5) audit_log：data/audit.log（JSONL）→ audit_log 表
  if (countRows("audit_log") === 0) {
    const auditFile = join(DATA_DIR, "audit.log");
    try {
      if (existsSync(auditFile)) {
        const lines = readFileSync(auditFile, "utf-8").split("\n").filter(Boolean);
        const ins = db.prepare(
          `INSERT OR IGNORE INTO audit_log (ts, user_id, action, detail) VALUES (?, ?, ?, ?)`,
        );
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            if (!e?.ts || !e?.action) continue;
            ins.run(e.ts, e.user || "admin", e.action, JSON.stringify(e));
          } catch {}
        }
      }
    } catch {}
  }
}

function countRows(table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as
      | { c: number }
      | undefined;
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}

// ===== 惰性迁移（首次请求时执行一次，避免 next build 多 worker 并发写库）=====

let migrated = false;

/** 首次调用时执行旧数据迁移（幂等，仅一次） */
export function ensureMigrated() {
  if (migrated) return;
  try {
    migrateLegacy();
  } catch (e) {
    // 迁移失败不阻断服务（例如被并发写锁），下次调用重试
    console.warn("[db] 旧数据迁移未完成：", e instanceof Error ? e.message : e);
  } finally {
    migrated = true;
  }
}

safeInit();
