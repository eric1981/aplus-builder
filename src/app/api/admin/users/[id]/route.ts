import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import {
  getUserById, setUserDisabled, setUserRole, setUserQuota, resetUserPassword, deleteUser,
  rotateUserToken,
} from "@/lib/users";
import { addCredits, consumeCredits, getCreditBalance } from "@/lib/credits";
import { logAudit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });
  const { id } = await params;

  const target = getUserById(id);
  if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  if (target.role === "admin" && id !== admin.id) {
    return NextResponse.json({ error: "不能修改其他管理员" }, { status: 403 });
  }

  let body: {
    disabled?: boolean;
    role?: string;
    password?: string;
    dailyLimit?: number | null;
    monthlyLimit?: number | null;
    creditsAdjust?: number;
    /** 轮换 API token（返回新 token 明文一次） */
    rotateApiToken?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
  }

  let rotatedToken: string | undefined;

  try {
    // 轮换 API token：库中只存哈希，明文仅在响应里出现一次
    if (body.rotateApiToken === true) {
      rotatedToken = rotateUserToken(id);
      logAudit(admin.id, "admin.user_rotate_token", { target: id });
    }
    if (typeof body.disabled === "boolean") {
      setUserDisabled(id, body.disabled);
      logAudit(admin.id, "admin.user_disable", { target: id, disabled: body.disabled });
    }
    if (body.role === "admin" || body.role === "user") {
      setUserRole(id, body.role);
      logAudit(admin.id, "admin.user_role", { target: id, role: body.role });
    }
    if (body.password) {
      if (body.password.length < 8) {
        return NextResponse.json({ error: "密码至少 8 位" }, { status: 400 });
      }
      resetUserPassword(id, body.password);
      logAudit(admin.id, "admin.user_reset_password", { target: id });
    }
    if ("dailyLimit" in body || "monthlyLimit" in body) {
      const dl = body.dailyLimit === undefined ? (target.dailyLimit ?? null) : body.dailyLimit;
      const ml = body.monthlyLimit === undefined ? (target.monthlyLimit ?? null) : body.monthlyLimit;
      setUserQuota(id, dl, ml);
      logAudit(admin.id, "admin.user_quota", { target: id, dailyLimit: dl, monthlyLimit: ml });
    }
    // 积分调整：正=发放 负=扣减（真实写入余额 + 流水）
    if (typeof body.creditsAdjust === "number" && body.creditsAdjust !== 0) {
      const delta = Math.trunc(body.creditsAdjust);
      if (delta > 0) {
        addCredits(id, delta, "admin.topup", `by ${admin.id}`);
        logAudit(admin.id, "admin.credit_topup", { target: id, amount: delta });
      } else {
        const r = consumeCredits(id, -delta, "admin.deduct", `by ${admin.id}`);
        if (!r.ok) {
          return NextResponse.json({ error: `扣减失败：余额不足（当前 ${r.balance}）` }, { status: 400 });
        }
        logAudit(admin.id, "admin.credit_deduct", { target: id, amount: -delta });
      }
    }
    return NextResponse.json({
      ok: true,
      credits: getCreditBalance(id),
      ...(rotatedToken ? { apiToken: rotatedToken, apiTokenNote: "请立即复制保存：服务端只存哈希" } : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });
  const { id } = await params;

  const target = getUserById(id);
  if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  if (target.role === "admin") {
    return NextResponse.json({ error: "不能删除管理员" }, { status: 403 });
  }

  deleteUser(id);
  logAudit(admin.id, "admin.user_delete", { target: id });
  return NextResponse.json({ ok: true });
}
