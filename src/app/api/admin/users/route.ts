import { NextRequest, NextResponse } from "next/server";
import { getInternalApiToken, INTERNAL_TOKEN_HEADER, isHostedMode } from "@/lib/hosted";
import {
  createUser,
  getUserByUsername,
  setPrewaveToken,
  toPublicUser,
} from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Alta/actualización de usuarias desde el server (operación de admin), protegida
 * por el token interno (mismo que usa el subproceso). El JWT de Prewave viaja en
 * el BODY por HTTPS —no en args ni env— y se guarda cifrado; nunca se loggea.
 *
 * Si la usuaria ya existe, actualiza su token de Prewave (idempotente para
 * re-correr el alta de todo el equipo sin duplicar).
 */
export async function POST(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo en modo hosteado" }, { status: 404 });
  }
  // Auth: solo con el token interno (no hay sesión de admin todavía).
  if (request.headers.get(INTERNAL_TOKEN_HEADER) !== getInternalApiToken()) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  let body: {
    username?: string;
    displayName?: string;
    password?: string;
    prewaveToken?: string;
    requirePasswordChange?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  if (!username) {
    return NextResponse.json({ error: "Falta username/email" }, { status: 400 });
  }

  try {
    const existing = await getUserByUsername(username);
    let user = existing;

    if (!existing) {
      if (typeof body.password !== "string" || body.password.length < 6) {
        return NextResponse.json(
          { error: "Falta password (mín 6) para crear la usuaria" },
          { status: 400 }
        );
      }
      user = await createUser({
        username,
        displayName: typeof body.displayName === "string" ? body.displayName : username,
        password: body.password,
        requirePasswordChange: body.requirePasswordChange ?? false,
      });
    }

    if (typeof body.prewaveToken === "string" && body.prewaveToken.trim()) {
      user = await setPrewaveToken(user!.id, body.prewaveToken);
    }

    return NextResponse.json({ user: toPublicUser(user!), created: !existing });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
