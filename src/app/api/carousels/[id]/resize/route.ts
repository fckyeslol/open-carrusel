import { NextResponse } from "next/server";
import { getCarousel } from "@/lib/carousels";
import { startResize, getResizeState } from "@/lib/resize-runner";
import { ASPECT_RATIOS, otherAspectRatios } from "@/types/carousel";
import type { AspectRatio } from "@/types/carousel";

/**
 * "Generar otros tamaños": crea carruseles HERMANOS en los otros formatos y los
 * re-maqueta con IA. Devuelve los IDs de los hermanos ya mismo; el re-flow corre
 * en background (consultá el progreso con GET).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const carousel = await getCarousel(id);
  if (!carousel) {
    return NextResponse.json({ error: "Carousel not found" }, { status: 404 });
  }
  if (carousel.slides.length === 0) {
    return NextResponse.json(
      { error: "El carrusel no tiene láminas para re-maquetar" },
      { status: 400 }
    );
  }

  // Si ya hay una re-maquetación en curso para este carrusel, no la dupliques.
  const existing = getResizeState(id);
  if (existing && existing.siblings.some((s) => s.status === "pending" || s.status === "running")) {
    return NextResponse.json(existing);
  }

  // Ratios: los que pida el body (validados) o, por defecto, los otros dos.
  let ratios = otherAspectRatios(carousel.aspectRatio);
  try {
    const body = await request.json().catch(() => null);
    const requested = body?.ratios;
    if (Array.isArray(requested) && requested.length > 0) {
      const valid = requested.filter(
        (r: unknown): r is AspectRatio =>
          typeof r === "string" &&
          (ASPECT_RATIOS as string[]).includes(r) &&
          r !== carousel.aspectRatio
      );
      if (valid.length > 0) ratios = [...new Set(valid)];
    }
  } catch {
    /* sin body: usamos el default */
  }

  try {
    const job = await startResize(id, ratios);
    return NextResponse.json(job, { status: 202 });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "No se pudo iniciar la re-maquetación" },
      { status: 500 }
    );
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const state = getResizeState(id);
  if (!state) {
    return NextResponse.json({ error: "No hay re-maquetación para este carrusel" }, { status: 404 });
  }
  return NextResponse.json(state);
}
