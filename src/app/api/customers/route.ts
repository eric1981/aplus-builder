import { NextRequest, NextResponse } from "next/server";
import { listCustomers, createCustomer, updateCustomer, deleteCustomer } from "@/lib/customer-store";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "未知错误";
}

export async function GET() {
  try {
    return NextResponse.json(listCustomers());
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { name } = await request.json();
    if (!name?.trim()) return NextResponse.json({ error: "客户名称不能为空" }, { status: 400 });
    const profile = createCustomer(name.trim());
    return NextResponse.json(profile, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id } = body;
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const updated = updateCustomer(id, body);
    return NextResponse.json(updated);
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    deleteCustomer(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
