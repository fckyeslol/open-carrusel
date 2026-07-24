import { NextRequest, NextResponse } from "next/server";
import { authenticate, toPublicUser } from "@/lib/users";
import { createSessionValue, sessionCookieOptions } from "@/lib/auth";
import { isHostedMode, SESSION_COOKIE } from "@/lib/hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rate limit mínimo anti fuerza-bruta: 10 intentos por IP por minuto. */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const g = globalThis as unknown as { __loginAttempts?: Map<string, number[]> };
const attempts = (g.__loginAttempts ??= new Map<string, number[]>());

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length > MAX_ATTEMPTS;
}

export async function POST(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Login solo aplica en modo hosteado" }, { status: 404 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Demasiados intentos — esperá un minuto y probá de nuevo" },
      { status: 429 }
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { username, password } = body;
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return NextResponse.json({ error: "Usuario y contraseña son obligatorios" }, { status: 400 });
  }

  const user = await authenticate(username, password);
  if (!user) {
    return NextResponse.json({ error: "Usuario o contraseña incorrectos" }, { status: 401 });
  }

  const response = NextResponse.json({ user: toPublicUser(user) });
  response.cookies.set(SESSION_COOKIE, createSessionValue(user.id), sessionCookieOptions());
  return response;
}
