import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { setAgentFlag, setReferral, listAgents, listUnboundUsers, agentSummary } from "@/lib/affiliate";
import { logAudit } from "@/lib/audit";

/**
 * 分销管理（admin）
 * GET  → 代理列表 + 未绑定用户 + 各代理收益汇总
 * POST → { action: 'markAgent', userId, isAgent } 或 { action: 'bind', userId, agentId, note }
 */
export async function GET(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  const agents = listAgents().map((a) => {
    const s = agentSummary(a.id);
    return { ...a, clientCount: s.clientCount, totalConsumed: s.totalConsumed, estimatedEarning: s.estimatedEarning, clients: s.clients };
  });
  return NextResponse.json({ agents, unbound: listUnboundUsers() });
}

export async function POST(request: NextRequest) {
  const admin = requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  let body: { action?: string; userId?: string; isAgent?: boolean; agentId?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体格式错误" }, { status: 400 });
  }

  try {
    if (body.action === "markAgent" && body.userId) {
      const { agentCode } = setAgentFlag(body.userId, Boolean(body.isAgent));
      logAudit(admin.id, "admin.agent_flag", { target: body.userId, isAgent: Boolean(body.isAgent), code: agentCode });
      return NextResponse.json({ ok: true, agentCode });
    }
    if (body.action === "bind" && body.userId) {
      setReferral(body.userId, body.agentId || null, body.note);
      logAudit(admin.id, "admin.referral_bind", { target: body.userId, agentId: body.agentId || null });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
  }
}
