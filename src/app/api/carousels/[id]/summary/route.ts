import { NextResponse } from "next/server";
import { getCarousel } from "@/lib/carousels";

/**
 * Lo mínimo que necesitan las tarjetas del tablero, en vez del carrusel entero.
 *
 * Las dos tarjetas que pollean pedían `GET /api/carousels/{id}` completo para usar una
 * fracción: `AssignmentThumb` se bajaba hasta 2.4 MB para renderizar UNA lámina, y
 * `GeneratingCard` se bajaba lo mismo para contar dos arrays. Con ~40 tarjetas
 * refrescándose eso era decenas de megas serializados por vuelta, encima del parseo del
 * store que ya casi tiraba el proceso (ver el caché en `data.ts`).
 *
 * El campo pesado acá es `firstSlideHtml`, y son kilobytes: el historial de undo
 * (`previousVersions`, tres cuartos del store) nunca sale por esta ruta.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const carousel = await getCarousel(id);
  if (!carousel) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const slides = carousel.slides ?? [];
  const first = [...slides].sort((a, b) => a.order - b.order)[0];

  return NextResponse.json({
    aspectRatio: carousel.aspectRatio,
    slideCount: slides.length,
    referenceCount: carousel.referenceImages?.length ?? 0,
    firstSlideHtml: first?.html ?? null,
  });
}
