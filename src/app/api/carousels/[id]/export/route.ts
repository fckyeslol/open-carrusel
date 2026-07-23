import { NextResponse } from "next/server";
import { getCarousel } from "@/lib/carousels";
import { exportSlide } from "@/lib/export-slides";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Exporta UNA lámina como PNG directo (nunca ZIP).
 *
 * `?slide=N` (1-based) elige la lámina; sin parámetro exporta la primera.
 * Para bajar el carrusel completo el cliente llama una vez por lámina —
 * así el usuario recibe archivos .png de una, sin descomprimir nada.
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
    return NextResponse.json({ error: "No slides to export" }, { status: 400 });
  }

  const slideParam = new URL(request.url).searchParams.get("slide");
  const slideNumber = slideParam ? Number.parseInt(slideParam, 10) : 1;

  if (
    !Number.isInteger(slideNumber) ||
    slideNumber < 1 ||
    slideNumber > carousel.slides.length
  ) {
    return NextResponse.json(
      {
        error: `Invalid slide number "${slideParam}" — carousel has ${carousel.slides.length} slide(s)`,
      },
      { status: 400 }
    );
  }

  try {
    const buffer = await exportSlide(
      carousel.slides[slideNumber - 1],
      carousel.aspectRatio
    );

    const safeName =
      carousel.name.replace(/[^a-zA-Z0-9-_]/g, "_") || carousel.id;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${safeName}-slide-${slideNumber}.png"`,
        "X-Slide-Count": String(carousel.slides.length),
      },
    });
  } catch (error) {
    console.error("Export error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Export failed: ${message}` },
      { status: 500 }
    );
  }
}
