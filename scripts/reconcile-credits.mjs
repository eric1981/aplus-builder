#!/usr/bin/env node
/**
 * 积分对账脚本（安全 P0-5 配套）
 *
 * 背景：users.credits 是权威余额，credit_ledger 是流水。存量数据里
 * 「初始 20 分」等发放没有对应流水，导致 余额 ≠ 流水合计（对账差异）。
 *
 * 本脚本为差异用户补一条 `ledger.adjust` 流水，使二者一致 —— **不修改余额**。
 * 幂等：收敛后重复执行不再产生新行。默认 dry-run，加 --apply 才写入。
 *
 * 用法：
 *   node scripts/reconcile-credits.mjs           # 只报告
 *   node scripts/reconcile-credits.mjs --apply   # 写入补账流水
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const apply = process.argv.includes("--apply");
const db = new DatabaseSync(join(process.cwd(), "data", "app.db"));

const rows = db
  .prepare(
    `SELECT u.id AS id, u.name AS name, u.credits AS credits,
            COALESCE((SELECT SUM(l.delta) FROM credit_ledger l WHERE l.user_id = u.id), 0) AS ledger
     FROM users u ORDER BY u.created_at ASC`,
  )
  .all();

let pending = 0;
for (const r of rows) {
  const balance = Number(r.credits || 0);
  const ledger = Number(r.ledger || 0);
  const diff = balance - ledger;
  if (diff === 0) {
    console.log(`✓ ${r.id}（${r.name}）：余额 ${balance} = 流水合计 ${ledger}`);
    continue;
  }
  pending++;
  console.log(
    `${apply ? "→ 已补账" : "[dry-run] 待补账"} ${r.id}（${r.name}）：余额 ${balance} vs 流水合计 ${ledger}，补流水 ${diff > 0 ? "+" : ""}${diff}`,
  );
  if (apply) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO credit_ledger (user_id, delta, reason, balance, ref, created_at)
         VALUES (?, ?, 'ledger.adjust', ?, ?, ?)`,
      ).run(r.id, diff, balance, "reconcile", Date.now());
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }
}

console.log(
  `\n共 ${rows.length} 个用户，${pending} 个需要补账${apply ? "（已写入）" : "（未写入，加 --apply 执行）"}`,
);
