import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { changePassword, toPublicUser } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo aplica en modo hosteado" }, { status: 404 });
  }
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });

  let body: { current?: string; next?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.current !== "string" || typeof body.next !== "string") {
    return NextResponse.json({ error: "Faltan campos" }, { status: 400 });
  }

  try {
    const updated = await changePassword(user.id, body.current, body.next);
    return NextResponse.json({ user: toPublicUser(updated) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
