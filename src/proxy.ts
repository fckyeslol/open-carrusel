/**
 * Puerta de entrada del modo hosteado (convención proxy.ts de Next 16, corre en
 * runtime Node). Con HOSTED_MODE apagado deja pasar TODO — la app local de las
 * diseñadoras sigue funcionando exactamente igual que hoy.
 *
 * En modo hosteado, cada request debe venir de:
 *   a) una sesión válida (cookie firmada del login), o
 *   b) el subproceso de Claude / scripts internos del server, que se identifican
 *      con el header X-Internal-Token (viaja por loopback, nunca sale del server).
 *
 * Quedan públicos: el login y los assets de imagen (uploads, avatares, logos,
 * texturas) — Puppeteer los busca por HTTP sin cookies al renderizar láminas.
 */
import { NextRequest, NextResponse } from "next/server";
import { parseSessionValue } from "@/lib/auth";
import { INTERNAL_TOKEN_HEADER, isHostedMode, SESSION_COOKIE } from "@/lib/hosted";

/** Prefijos accesibles sin sesión. */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/uploads/",
  "/avatar-assets/",
  "/30x/",
  "/textures/",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function isInternalRequest(request: NextRequest): boolean {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return false;
  return request.headers.get(INTERNAL_TOKEN_HEADER) === token;
}

export default function proxy(request: NextRequest) {
  if (!isHostedMode()) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (isInternalRequest(request)) return NextResponse.next();

  const userId = parseSessionValue(request.cookies.get(SESSION_COOKIE)?.value);
  if (userId) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "No autenticada" }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Todo menos los estáticos del framework (los assets propios sí pasan por acá).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
