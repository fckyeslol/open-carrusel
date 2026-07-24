import { NextResponse } from "next/server";
import {
  saveAvatarAsset,
  deleteAvatarAsset,
  isAssetKind,
  isValidSlug,
  MAX_ASSET_SIZE,
} from "@/lib/avatar-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Anti-CSRF: un POST multipart es "simple request" (sin preflight), así que una
 * página maliciosa abierta en el navegador podría escribir archivos en la
 * carpeta versionada. Solo aceptamos requests sin Origin (curl, el agente) o
 * con Origin del propio localhost.
 */
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    if (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1") return true;
    // Modo hosteado: el navegador manda el Origin del dominio público — es
    // same-origin si coincide con el Host del propio request.
    return originUrl.host === request.headers.get("host");
  } catch {
    return false;
  }
}

/**
 * Sube un asset de marca al avatar: multipart/form-data con `kind`
 * (logo|fotos|fondos|referencias) y `file`. El archivo queda en
 * 30x/avatars/<slug>/assets/<kind>/ (versionado en git).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Origen no permitido" }, { status: 403 });
  }
  if (!isValidSlug(slug)) {
    return NextResponse.json({ error: "Avatar desconocido" }, { status: 404 });
  }

  // Cortar ANTES de bufferear el body: formData() lo lee entero a memoria.
  // Margen de 1MB por el overhead del multipart.
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_ASSET_SIZE + 1024 * 1024) {
    return NextResponse.json({ error: "Máximo 10MB por archivo" }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Mandá multipart/form-data con los campos 'kind' y 'file'" },
      { status: 400 }
    );
  }

  const kind = String(formData.get("kind") || "");
  if (!isAssetKind(kind)) {
    return NextResponse.json(
      { error: "kind debe ser logo, fotos, fondos o referencias" },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo" }, { status: 400 });
  }
  if (file.size > MAX_ASSET_SIZE) {
    return NextResponse.json({ error: "Máximo 10MB por archivo" }, { status: 413 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const saved = await saveAvatarAsset(slug, kind, file.name, buffer);
    return NextResponse.json({ ok: true, ...saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "No se pudo guardar el asset";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Borra un asset: /api/avatar-assets/<slug>?kind=fotos&file=retrato.jpg */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Origen no permitido" }, { status: 403 });
  }
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || "";
  const file = url.searchParams.get("file") || "";

  if (!isValidSlug(slug) || !isAssetKind(kind) || !file) {
    return NextResponse.json({ error: "Parámetros inválidos" }, { status: 400 });
  }

  const removed = await deleteAvatarAsset(slug, kind, file);
  if (!removed) {
    return NextResponse.json({ error: "No existe ese asset" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
