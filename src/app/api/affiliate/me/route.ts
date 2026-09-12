import { NextRequest, NextResponse } from "next/server";
import { agentSummary } from "@/lib/affiliate";
import { db } from "@/lib/db";
import { callerId as resolveCallerId } from "@/lib/request-user";

/**
 * GET /api/affiliate/me
 * 当前用户若为代理：返回专属码 + 名下客户/消耗/收益汇总。
 * 非代理返回 { isAgent: false }。
 */
export async function GET(request: NextRequest) {
  const userId = resolveCallerId(request);
  if (!userId) return NextResponse.json({ isAgent: false });
  try {
    const row = db
      .prepare(`SELECT is_agent, agent_code FROM users WHERE id = ?`)
      .get(userId) as { is_agent: number; agent_code: string | null } | undefined;
    const isAgent = Boolean(row?.is_agent);
    if (!isAgent) return NextResponse.json({ isAgent: false });

    const summary = agentSummary(userId);
    return NextResponse.json({
      isAgent: true,
      agentCode: row?.agent_code || "",
      ...summary,
    });
  } catch {
    return NextResponse.json({ isAgent: false });
  }
}
