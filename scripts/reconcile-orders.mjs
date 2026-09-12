#!/usr/bin/env node
/**
 * 订单/支付对账脚本
 *
 * 校验三件事（只读，不修改任何数据）：
 *   ① 订单状态自洽：paid 必须有 external_id 与 paid_at；refunded 必须有 refunded_at
 *   ② 积分口径对齐：payment.credit 流水合计 - payment.refund 流水合计
 *      == 已支付订单积分合计 - 已退款订单积分合计
 *   ③ 幂等键唯一：同一 external_id 只对应一张订单；同一 (provider, event_id) 只有一个事件
 *      （有唯一索引兜底，这里再显式核对一遍，便于人工审查）
 * 另外核对每个用户「余额 == 流水合计」（与 scripts/reconcile-credits.mjs 同一口径）。
 *
 * 用法：node scripts/reconcile-orders.mjs
 * 退出码：0 = 全部一致；1 = 存在不一致（需人工核对）
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const db = new DatabaseSync(join(process.cwd(), "data", "app.db"));
let problems = 0;
const fail = (msg) => { console.log("  ✗ " + msg); problems++; };
const ok = (msg) => console.log("  ✓ " + msg);

console.log("① 订单状态自洽");
const badPaid = db
  .prepare(`SELECT id FROM orders WHERE status = 'paid' AND (external_id IS NULL OR paid_at IS NULL)`)
  .all();
if (badPaid.length) fail(`有 ${badPaid.length} 张已支付订单缺少 external_id/paid_at：${badPaid.map((r) => r.id).join(", ")}`);
else ok("已支付订单字段完整");

const badRefund = db.prepare(`SELECT id FROM orders WHERE status = 'refunded' AND refunded_at IS NULL`).all();
if (badRefund.length) fail(`有 ${badRefund.length} 张已退款订单缺少 refunded_at`);
else ok("已退款订单字段完整");

console.log("② 积分口径对齐（订单 ↔ 流水）");
const ledgerCredit = db.prepare(`SELECT COALESCE(SUM(delta),0) c FROM credit_ledger WHERE reason = 'payment.credit'`).get().c;
const ledgerRefund = db.prepare(`SELECT COALESCE(SUM(-delta),0) c FROM credit_ledger WHERE reason = 'payment.refund'`).get().c;
const paidCredits = db.prepare(`SELECT COALESCE(SUM(credits),0) c FROM orders WHERE status = 'paid'`).get().c;
const refundedCredits = db.prepare(`SELECT COALESCE(SUM(credits),0) c FROM orders WHERE status = 'refunded'`).get().c;
const left = ledgerCredit - ledgerRefund;
const right = paidCredits - refundedCredits;
if (left === right) ok(`流水净额 ${left} = 订单净额 ${right}`);
else fail(`不一致：流水净额 ${left} vs 订单净额 ${right}（入账 ${ledgerCredit}/退款 ${ledgerRefund}；已付订单 ${paidCredits}/已退订单 ${refundedCredits}）`);

console.log("③ 幂等键唯一性");
const dupExt = db
  .prepare(`SELECT external_id, COUNT(*) n FROM orders WHERE external_id IS NOT NULL GROUP BY external_id HAVING n > 1`)
  .all();
if (dupExt.length) fail(`交易号重复：${dupExt.map((r) => r.external_id).join(", ")}`);
else ok("同一支付方交易号只对应一张订单");

const dupEvt = db
  .prepare(`SELECT provider, event_id, COUNT(*) n FROM payment_events WHERE event_id IS NOT NULL GROUP BY provider, event_id HAVING n > 1`)
  .all();
if (dupEvt.length) fail(`回调事件重复：${dupEvt.map((r) => `${r.provider}/${r.event_id}`).join(", ")}`);
else ok("同一回调事件只记录一次");

console.log("④ 用户余额 vs 流水合计");
for (const u of db.prepare(
  `SELECT u.id, u.credits, COALESCE((SELECT SUM(delta) FROM credit_ledger l WHERE l.user_id = u.id), 0) ledger FROM users u`,
).all()) {
  if (Number(u.credits) === Number(u.ledger)) ok(`${u.id}: ${u.credits}`);
  else fail(`${u.id}: 余额 ${u.credits} ≠ 流水合计 ${u.ledger}`);
}

console.log(`\n结论：${problems === 0 ? "全部一致 ✓" : `发现 ${problems} 处不一致，请人工核对`}`);
process.exit(problems === 0 ? 0 : 1);
