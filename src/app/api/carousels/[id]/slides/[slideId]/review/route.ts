import { NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { getCarousel } from "@/lib/carousels";
import { getPreset } from "@/lib/style-presets";
import { exportSlide } from "@/lib/export-slides";
import { wrapSlideHtml, extractFontFamilies } from "@/lib/slide-html";
import { DIMENSIONS } from "@/types/carousel";
import { chequearLamina } from "@/lib/quality/check-slide.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Los PNGs de revisión son artefactos de trabajo, no entregables. */
const DIR_REVISION = path.resolve(process.cwd(), ".quality");

/**
 * Revisa una lámina: la renderiza a PNG y corre el detector sobre ella.
 *
 * Existe porque el agente escribe HTML a ciegas — hoy no ve su propio output en
 * ningún punto del loop, solo al exportar, cuando ya nadie corrige. Esta ruta le
 * da las dos cosas que le faltan: una imagen para mirar y una lista de defectos
 * verificables.
 *
 * El render usa exportSlide(), el mismo camino que la entrega final, para que lo
 * que el agente revisa sea exactamente lo que se publica. Revisar el preview
 * escondería toda la clase de fallos que solo aparecen al exportar (fuentes que
 * no se pudieron inlinear, imágenes que no resolvieron).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; slideId: string }> }
) {
  const { id, slideId } = await params;

  const carousel = await getCarousel(id);
  if (!carousel) {
    return NextResponse.json({ error: "Carrusel no encontrado" }, { status: 404 });
  }

  const slide = carousel.slides.find((s) => s.id === slideId);
  if (!slide) {
    return NextResponse.json({ error: "Lámina no encontrada" }, { status: 404 });
  }

  const preset = carousel.stylePresetId
    ? await getPreset(carousel.stylePresetId)
    : null;

  const dimensiones = DIMENSIONS[carousel.aspectRatio];

  let revision;
  try {
    revision = await chequearLamina({
      html: slide.html,
      htmlEnvuelto: wrapSlideHtml(slide.html, carousel.aspectRatio),
      aspectRatio: carousel.aspectRatio,
      dimensiones,
      // Las mismas familias que va a cargar el render, no una segunda extracción.
      familiasDeclaradas: extractFontFamilies(slide.html),
      preset,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "El detector falló",
        detalle: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }

  // El render va después del detector y en su propio try: si Puppeteer falla, los
  // hallazgos estáticos siguen siendo útiles y se devuelven igual. Fallar entero
  // acá dejaría al agente sin nada.
  let rutaPng: string | null = null;
  let errorRender: string | null = null;
  try {
    const buffer = await exportSlide(slide, carousel.aspectRatio);
    await mkdir(DIR_REVISION, { recursive: true });
    rutaPng = path.join(DIR_REVISION, `${id}-${slideId}.png`);
    await writeFile(rutaPng, buffer);
  } catch (error) {
    errorRender = error instanceof Error ? error.message : String(error);
  }

  const orden = carousel.slides.findIndex((s) => s.id === slideId) + 1;

  // Las referencias viajan con la respuesta para que comparar cueste un Read y no
  // una búsqueda. Sin esto el agente juzga la lámina aislada —"¿está bien?"— en vez
  // de contra el referente —"¿se parece?"—, que es la única pregunta que importa.
  const referencias = carousel.referenceImages || [];
  const referenciaDeEstaLamina = referencias[orden - 1]?.absPath || null;

  return NextResponse.json({
    lamina: { id: slideId, orden, de: carousel.slides.length },
    carrusel: { id, aspectRatio: carousel.aspectRatio, ...dimensiones },
    png: rutaPng,
    errorRender,
    referencia: referenciaDeEstaLamina,
    referencias: referencias.map((r) => r.absPath),
    ...revision,
  });
}
