import { NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { getCarousel } from "@/lib/carousels";
import { exportAllSlides } from "@/lib/export-slides";
import { completeJob, failJob, PrewaveError } from "@/lib/prewave";
import { setStatus } from "@/lib/assignments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * WRITEBACK: renderiza el carrusel a PNGs y (opcionalmente) cierra el job de la
 * cola de Prewave con `done`.
 *
 * ⚠️ Cerrar el job es un efecto sobre PRODUCCIÓN. Solo ocurre si `deliver: true`
 * (la diseñadora aprieta "Entregar"). Sin eso, solo exporta y devuelve las rutas.
 *
 * PENDIENTE (Fase 7 del plan): subir los PNGs a GCS vía el signed-URL de Prewave y
 * usar esa URL como resultUrl / adjuntarlos como assets del brief. Hoy exporta a
 * public/exports/<id>/ (servido local) y usa esa URL como resultUrl provisorio.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;

  let body: { carouselId?: string; deliver?: boolean; resultUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const carouselId = body.carouselId?.trim();
  if (!carouselId) {
    return NextResponse.json({ error: "carouselId requerido" }, { status: 400 });
  }

  const carousel = await getCarousel(carouselId);
  if (!carousel) {
    return NextResponse.json({ error: "Carrusel no encontrado" }, { status: 404 });
  }
  if (carousel.slides.length === 0) {
    return NextResponse.json({ error: "El carrusel no tiene láminas" }, { status: 422 });
  }

  // Render a PNG.
  let files: { name: string; buffer: Buffer }[];
  try {
    files = await exportAllSlides(carousel.slides, carousel.aspectRatio);
  } catch (e) {
    return NextResponse.json({ error: `Falló el render: ${(e as Error).message}` }, { status: 500 });
  }

  // Guardar en public/exports/<carouselId>/ (servido local; base para la subida a GCS).
  const outDir = path.resolve(process.cwd(), "public", "exports", carouselId);
  await mkdir(outDir, { recursive: true });
  const urls: string[] = [];
  for (const f of files) {
    await writeFile(path.join(outDir, f.name), f.buffer);
    urls.push(`/exports/${carouselId}/${f.name}`);
  }

  const localResultUrl = body.resultUrl?.trim() || `/exports/${carouselId}/`;

  // Cierre del job SOLO si la diseñadora aprieta "Entregar".
  if (body.deliver) {
    try {
      await completeJob(jobId, localResultUrl);
      // Reflejar la entrega en la cola local (si el job vive ahí).
      await setStatus(jobId, "delivered", { resultUrl: localResultUrl });
    } catch (e) {
      const status = e instanceof PrewaveError ? e.status : 500;
      return NextResponse.json(
        { error: `Se exportó pero no se pudo cerrar el job: ${(e as Error).message}`, slides: urls },
        { status }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    delivered: Boolean(body.deliver),
    slides: urls,
    resultUrl: localResultUrl,
  });
}

/** Marca el job como fallido (la diseñadora descarta el referente). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const { searchParams } = new URL(request.url);
  const reason = searchParams.get("reason") || "descartado por la diseñadora";
  try {
    await failJob(jobId, reason);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof PrewaveError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
