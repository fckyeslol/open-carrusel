/**
 * Sesiones del modo hosteado: cookie httpOnly firmada (HMAC-SHA256), sin estado
 * en el server — el payload lleva id de usuaria + expiración y la firma evita
 * manipulación. Suficiente para un equipo chico de diseñadoras; si algún día
 * hace falta revocar sesiones individuales, se migra a sesiones en /data.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "./hosted";
import { signSession, verifySessionSignature } from "./token-crypto";
import { getUserById, User } from "./users";

/** 30 días: las diseñadoras entran a diario, no queremos login constante. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Serializa una sesión: v1.<userId>.<expiraMs>.<firma> */
export function createSessionValue(userId: string): string {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `v1.${userId}.${expires}`;
  return `${payload}.${signSession(payload)}`;
}

/** Devuelve el userId si la cookie es válida y no expiró; null si no. */
export function parseSessionValue(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [version, userId, expiresStr, signature] = parts;
  const payload = `${version}.${userId}.${expiresStr}`;
  if (!verifySessionSignature(payload, signature)) return null;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  return userId;
}

/** Opciones de cookie de sesión (Set-Cookie). */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Usuaria autenticada del request, o null (sin cookie / inválida / borrada). */
export async function getSessionUser(request: NextRequest): Promise<User | null> {
  const userId = parseSessionValue(request.cookies.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  return getUserById(userId);
}
