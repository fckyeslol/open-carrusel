import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { clearClaudeToken, setClaudeToken, toPublicUser } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Guarda el CLAUDE_CODE_OAUTH_TOKEN de la usuaria logueada (cifrado en reposo).
 * El token NUNCA vuelve al cliente — solo el flag hasClaudeToken.
 */
export async function PUT(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo aplica en modo hosteado" }, { status: 404 });
  }
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });

  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.token !== "string") {
    return NextResponse.json({ error: "Falta el token" }, { status: 400 });
  }

  try {
    const updated = await setClaudeToken(user.id, body.token);
    return NextResponse.json({ user: toPublicUser(updated) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo aplica en modo hosteado" }, { status: 404 });
  }
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });
  const updated = await clearClaudeToken(user.id);
  return NextResponse.json({ user: toPublicUser(updated) });
}
