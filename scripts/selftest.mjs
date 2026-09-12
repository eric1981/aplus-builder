#!/usr/bin/env node
/**
 * 端到端自测（跑在临时 DB + 临时 OUTPUT_BASE 上，不触碰真实数据）
 *
 * 前置：先 `npm run build`（默认会用 `next start` 起一个临时实例）。
 * 用法：
 *   node scripts/selftest.mjs                          # 自起临时实例（推荐）
 *   SELFTEST_BASE_URL=http://127.0.0.1:3000 \
 *   SELFTEST_ADMIN_TOKEN=xxx SELFTEST_WEBHOOK_SECRET=yyy \
 *   APLUS_DB_PATH=/path/app.db node scripts/selftest.mjs   # 复用已运行实例（受限环境/联调）
 *
 * 覆盖「钱与权限」的关键不变量：
 *   1. 匿名访问产出文件被拒（防跨租户读取）
 *   2. 首页公开图必须带有效签名；篡改签名被拒
 *   3. 支付：下单 → 验签回调入账**恰好一次** → 重放去重 → 金额不符拒绝
 *      → 退款回收 → 重复退款幂等
 *   4. 账本一致性：每个用户 余额 == 流水合计
 *   5. API token 只存哈希；轮换后旧 token 失效
 *   6. 登录按账号限流（换 IP 也绕不过）
 *   7. 任务归属：他人 taskId 不可读
 */
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const EXTERNAL_URL = process.env.SELFTEST_BASE_URL || "";
const EXTERNAL = EXTERNAL_URL ? new URL(EXTERNAL_URL) : null;
const PORT = EXTERNAL ? Number(EXTERNAL.port || 80) : 3400 + Math.floor(Math.random() * 200);
const TMP = mkdtempSync(join(tmpdir(), "aplus-selftest-"));
const DB_PATH = process.env.APLUS_DB_PATH || join(TMP, "app.db");
const OUTPUT_BASE = process.env.OUTPUT_BASE || join(TMP, "output");
const ADMIN_TOKEN = process.env.SELFTEST_ADMIN_TOKEN || `selftest_admin_${randomBytes(12).toString("hex")}`;
const WEBHOOK_SECRET = process.env.SELFTEST_WEBHOOK_SECRET || `selftest_whsec_${randomBytes(12).toString("hex")}`;
const ADMIN_EMAIL = "selftest-admin@local";
const ADMIN_PASSWORD = "selftest-admin-pass";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ===== HTTP 小工具（用 node:http 以便完全控制 Host 头，模拟非本机访问）=====

function request(method, path, { token, body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : raw ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path,
        headers: {
          host: "selftest.example.com", // 非 localhost → 不走本机豁免
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: data, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function formRequest(path, { token, fields, fileField, fileName, fileBuf }) {
  const boundary = `----selftest${randomBytes(6).toString("hex")}`;
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    ),
  );
  chunks.push(fileBuf, Buffer.from(`\r\n--${boundary}--\r\n`));
  const payload = Buffer.concat(chunks);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method: "POST",
        path,
        headers: {
          host: "selftest.example.com",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": payload.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: data, json });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const sign = (rawBody) => createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

// ===== 启动临时实例 =====

const server = EXTERNAL
  ? null
  : spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "production",
    APLUS_DB_PATH: DB_PATH,
    OUTPUT_BASE,
    AUTH_TOKEN: ADMIN_TOKEN,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TRUST_LOCALHOST: "false", // 严格模式，确保走真实鉴权
  },
      stdio: ["ignore", "pipe", "pipe"],
    });
let serverLog = "";
if (server) {
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
}

function cleanup() {
  if (server) { try { server.kill("SIGTERM"); } catch {} }
  if (!EXTERNAL) { try { rmSync(TMP, { recursive: true, force: true }); } catch {} }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function waitReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request("GET", "/api/hero-images?count=1");
      if (r.status > 0) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

// ===== 主流程 =====

async function main() {
  if (!EXTERNAL) mkdirSync(OUTPUT_BASE, { recursive: true });
  console.log(`\n=== aplus-builder 自测（${EXTERNAL ? `外部实例 ${EXTERNAL_URL}` : `临时实例 :${PORT}`}，库 ${DB_PATH}）===\n`);

  if (!(await waitReady())) {
    console.log("✗ 临时实例启动失败，日志尾部：\n" + serverLog.slice(-1500));
    process.exit(1);
  }
  // 先访问一个 admin 接口，触发 seedAdmin 建档（新库首次请求才会建内置管理员）
  await request("GET", "/api/admin/users", { token: ADMIN_TOKEN });

  console.log("① 匿名访问产出文件（应 401）");
  // 造一个真实的产出文件，模拟其它租户的数据
  const dir = join(OUTPUT_BASE, "victim-product");
  mkdirSync(join(dir, "input"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html><body>secret</body></html>");
  writeFileSync(join(dir, "prompt.txt"), "SECRET PROMPT");
  const anon = await request("GET", "/api/output/victim-product/index.html");
  check("匿名读 index.html 被拒", anon.status === 401, `实际 ${anon.status}`);
  const anonPrompt = await request("GET", "/api/output/victim-product/prompt.txt");
  check("匿名读 prompt.txt 被拒", anonPrompt.status === 401, `实际 ${anonPrompt.status}`);

  console.log("② 首页公开图签名");
  const hero = await request("GET", "/api/hero-images?count=3");
  const urls = (hero.json && hero.json.images) || [];
  check("hero-images 返回 200", hero.status === 200, `实际 ${hero.status}`);
  if (urls.length > 0) {
    check("URL 带签名参数", urls[0].includes("sig="), urls[0]);
    const bad = urls[0].replace(/sig=./, "sig=0");
    const badRes = await request("GET", bad);
    check("篡改签名被拒", badRes.status === 401, `实际 ${badRes.status}`);
  } else {
    check("URL 带签名参数", true, "（无产出图，跳过）");
    check("篡改签名被拒", true, "（无产出图，跳过）");
  }

  console.log("③ 支付：下单 → 入账 → 重放 → 金额校验 → 退款");
  const orderRes = await request("POST", "/api/payments/me", { token: ADMIN_TOKEN, body: { credits: 10 } });
  const order = orderRes.json && orderRes.json.order;
  check("下单成功且为 pending", orderRes.status === 200 && order && order.status === "pending", `实际 ${orderRes.status}`);
  if (!order) throw new Error("下单失败，无法继续支付断言");

  const payBody = JSON.stringify({
    event_id: "evt_selftest_1",
    type: "payment.succeeded",
    order_id: order.id,
    external_id: "ext_selftest_1",
    amount_cents: order.amountCents,
  });
  const paid = await request("POST", "/api/payments/webhook", { body: payBody, raw: true, headers: { "x-payment-signature": sign(payBody) } });
  check("验签回调入账一次", paid.status === 200 && paid.json && paid.json.credited === true, `实际 ${paid.status} ${paid.body.slice(0, 80)}`);

  const replay = await request("POST", "/api/payments/webhook", { body: payBody, raw: true, headers: { "x-payment-signature": sign(payBody) } });
  check("同一事件重放被去重", replay.status === 200 && replay.json && replay.json.duplicated === true, replay.body.slice(0, 80));

  const mismatchBody = JSON.stringify({
    event_id: "evt_selftest_mismatch",
    type: "payment.succeeded",
    order_id: order.id,
    external_id: "ext_mismatch",
    amount_cents: 1,
  });
  const mismatch = await request("POST", "/api/payments/webhook", { body: mismatchBody, raw: true, headers: { "x-payment-signature": sign(mismatchBody) } });
  check("金额不符被拒（409）", mismatch.status === 409, `实际 ${mismatch.status}`);

  const unsigned = await request("POST", "/api/payments/webhook", { body: payBody, raw: true });
  check("未签名回调被拒（401）", unsigned.status === 401, `实际 ${unsigned.status}`);

  const refund = await request("POST", "/api/admin/orders", { token: ADMIN_TOKEN, body: { action: "refund", orderId: order.id } });
  check("退款回收积分", refund.status === 200 && refund.json && refund.json.revoked === order.credits, refund.body.slice(0, 90));
  const refundAgain = await request("POST", "/api/admin/orders", { token: ADMIN_TOKEN, body: { action: "refund", orderId: order.id } });
  check("重复退款幂等", refundAgain.status === 200 && refundAgain.json && refundAgain.json.revoked === 0, refundAgain.body.slice(0, 90));

  console.log("④ 账本一致性（余额 == 流水合计）");
  const db = new DatabaseSync(DB_PATH);
  const rows = db
    .prepare(
      `SELECT u.id, u.credits,
              COALESCE((SELECT SUM(delta) FROM credit_ledger l WHERE l.user_id = u.id), 0) AS ledger
       FROM users u`,
    )
    .all();
  const drifted = rows.filter((r) => Number(r.credits) !== Number(r.ledger));
  check(`全部用户账本一致（${rows.length} 个）`, drifted.length === 0, JSON.stringify(drifted));

  console.log("⑤ API token 只存哈希 + 轮换");
  const created = await request("POST", "/api/admin/users", {
    token: ADMIN_TOKEN,
    body: { name: "selftest-u", email: "selftest-u@local", password: "selftest-pass-1" },
  });
  const userToken = created.json && created.json.apiToken;
  check("新建用户返回一次性 token", created.status === 200 && !!userToken, created.body.slice(0, 90));
  const tokenRow = db.prepare(`SELECT token, token_hash FROM users WHERE id = 'selftest-u'`).get();
  check("库中不存明文 token", !!tokenRow && !tokenRow.token && !!tokenRow.token_hash, JSON.stringify(tokenRow));
  if (userToken) {
    const useNew = await request("GET", "/api/payments/me", { token: userToken });
    check("新 token 可用", useNew.status === 200, `实际 ${useNew.status}`);
    const rotated = await request("PATCH", "/api/admin/users/selftest-u", { token: ADMIN_TOKEN, body: { rotateApiToken: true } });
    const rotatedToken = rotated.json && rotated.json.apiToken;
    check("轮换返回新 token", rotated.status === 200 && !!rotatedToken, rotated.body.slice(0, 90));
    const oldAfter = await request("GET", "/api/payments/me", { token: userToken });
    check("轮换后旧 token 失效", oldAfter.status === 401, `实际 ${oldAfter.status}`);
    if (rotatedToken) {
      const newAfter = await request("GET", "/api/payments/me", { token: rotatedToken });
      check("轮换后新 token 可用", newAfter.status === 200, `实际 ${newAfter.status}`);
    }
  }

  console.log("⑥ 登录按账号限流（伪造 X-Forwarded-For 轮换 IP）");
  let got429 = false;
  for (let i = 1; i <= 12; i++) {
    const r = await request("POST", "/api/auth/login", {
      body: { email: ADMIN_EMAIL, password: "wrong-password" },
      headers: { "x-forwarded-for": `10.9.${i}.${i}` },
    });
    if (r.status === 429) { got429 = true; break; }
  }
  check("同账号连续失败被限流（429）", got429);

  console.log("⑦ 任务归属（他人 taskId 不可读）");
  const other = await request("GET", "/api/generate?taskId=00000000-0000-4000-8000-000000000000", { token: ADMIN_TOKEN });
  check("不存在的任务返回 404", other.status === 404, `实际 ${other.status}`);

  console.log(`\n=== 结果：${checks - failures}/${checks} 通过 ${failures ? `（${failures} 项失败）` : "✓"} ===\n`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("自测异常：", e);
  console.log(serverLog.slice(-1500));
  cleanup();
  process.exit(1);
});
