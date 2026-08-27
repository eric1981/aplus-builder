import { NextRequest, NextResponse } from "next/server";
import { listCustomers, createCustomer, updateCustomer, deleteCustomer } from "@/lib/customer-store";
import { logAudit } from "@/lib/audit";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "未知错误";
}

function userIdOf(request: NextRequest): string {
  return request.headers.get("x-user-id") || "admin";
}

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(listCustomers(userIdOf(request)));
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = userIdOf(request);
    const { name } = await request.json();
    if (!name?.trim()) return NextResponse.json({ error: "客户名称不能为空" }, { status: 400 });
    const profile = createCustomer(name.trim(), userId);
    logAudit(userId, "customer.create", { id: profile.id, name: profile.name });
    return NextResponse.json(profile, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const userId = userIdOf(request);
    const body = await request.json();
    const { id } = body;
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const updated = updateCustomer(id, body, userId);
    logAudit(userId, "customer.update", { id });
    return NextResponse.json(updated);
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const userId = userIdOf(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    deleteCustomer(id, userId);
    logAudit(userId, "customer.delete", { id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
