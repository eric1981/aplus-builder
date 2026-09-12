import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { listSettingsView, setSetting, getSettingDef } from "@/lib/settings";
import { logAudit } from "@/lib/audit";

/** GET /api/admin/settings — 全部设置（注册表 + 当前值 + 来源） */
export async function GET(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });
  return NextResponse.json({ settings: listSettingsView() });
}

/** PUT /api/admin/settings — 批量更新（{ key: value }），校验 + 持久化 */
export async function PUT(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
  }

  const updated: string[] = [];
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(body)) {
    const def = getSettingDef(key);
    if (!def) {
      errors.push(`未知设置项：${key}`);
      continue;
    }
    if (def.restartRequired) {
      errors.push(`${def.label} 为部署级配置，请用环境变量 ${def.env} 设置`);
      continue;
    }
    const value = String(raw ?? "");
    if (def.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        errors.push(`${def.label} 必须是非负数字`);
        continue;
      }
      // 分成比例必须落在 0–100（>100 会让代理收益超过客户实际消耗）
      if (def.key === "agentCommissionPercent" && n > 100) {
        errors.push(`${def.label} 必须在 0–100 之间`);
        continue;
      }
      // 积分单价上限（与运行时夹取口径一致，避免"设置里写着 20000、实际按 1 元算"）
      if (def.key === "creditPriceYuan" && n > 10_000) {
        errors.push(`${def.label} 不能超过 10000 元/积分`);
        continue;
      }
      // 防止误设 0 导致全局不可用（并发/超时类至少为 1）
      if (def.group === "concurrency" || def.key === "agentTimeoutMinutes" || def.key === "styleTimeoutMinutes") {
        if (n < 1) {
          errors.push(`${def.label} 至少为 1`);
          continue;
        }
      }
    }
    setSetting(key, value);
    updated.push(key);
  }

  if (updated.length > 0) {
    logAudit(admin.id, "admin.settings_update", { keys: updated });
  }
  if (errors.length > 0) {
    // 全都没写进去 → 400（此前误写成 errors.length === updated.length，导致单键校验失败也返回 200，
    // 前端拿不到错误提示）；部分写入 → 200 并把 errors 一并回传。
    return NextResponse.json(
      { ok: updated.length > 0, updated, errors },
      { status: updated.length === 0 ? 400 : 200 },
    );
  }
  return NextResponse.json({ ok: true, updated });
}
