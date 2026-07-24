import { NextResponse } from "next/server";
import { getCarousel } from "@/lib/carousels";
import { exportSlide } from "@/lib/export-slides";
import { exportPdf, exportHtml, exportSvg } from "@/lib/export-formats";
import type { Slide, AspectRatio } from "@/types/carousel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ExportFormat = "png" | "pdf" | "html" | "svg";

const CONTENT_TYPE: Record<ExportFormat, string> = {
  png: "image/png",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
};

/**
 * Exporta un carrusel en varios formatos.
 *
 * `?format=` elige el formato (default `png`):
 *   - `png`  — UNA lámina como PNG (requiere `?slide=N`, 1-based; default 1).
 *   - `pdf`  — carrusel completo en un PDF (texto editable). Con `?slide=N`
 *              exporta solo esa lámina en su propio PDF.
 *   - `html` — carrusel completo como HTML autocontenido y editable.
 *   - `svg`  — UNA lámina como SVG (requiere `?slide=N`; default 1).
 *
 * PNG y SVG son por-lámina: el cliente llama una vez por lámina y recibe
 * archivos sueltos. PDF y HTML son un único archivo por carrusel.
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

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") || "png") as ExportFormat;

  if (!(format in CONTENT_TYPE)) {
    return NextResponse.json(
      { error: `Unknown format "${format}"` },
      { status: 400 }
    );
  }

  const safeName = carousel.name.replace(/[^a-zA-Z0-9-_]/g, "_") || carousel.id;
  const aspectRatio = carousel.aspectRatio as AspectRatio;

  // Láminas por-lámina (png/svg) validan y resuelven la lámina pedida.
  const slideParam = url.searchParams.get("slide");
  const slideNumber = slideParam ? Number.parseInt(slideParam, 10) : 1;
  const slideIndexValid =
    Number.isInteger(slideNumber) &&
    slideNumber >= 1 &&
    slideNumber <= carousel.slides.length;

  try {
    switch (format) {
      case "png": {
        if (!slideIndexValid) return invalidSlide(slideParam, carousel.slides);
        const buffer = await exportSlide(
          carousel.slides[slideNumber - 1],
          aspectRatio
        );
        return binary(buffer, "png", `${safeName}-slide-${slideNumber}.png`, {
          "X-Slide-Count": String(carousel.slides.length),
        });
      }

      case "svg": {
        if (!slideIndexValid) return invalidSlide(slideParam, carousel.slides);
        const svg = await exportSvg(carousel.slides[slideNumber - 1], aspectRatio);
        return text(svg, "svg", `${safeName}-slide-${slideNumber}.svg`, {
          "X-Slide-Count": String(carousel.slides.length),
        });
      }

      case "pdf": {
        // Con ?slide=N → PDF de una sola lámina; sin él → carrusel completo.
        const slides: Slide[] = slideParam
          ? slideIndexValid
            ? [carousel.slides[slideNumber - 1]]
            : []
          : carousel.slides;
        if (slideParam && !slideIndexValid)
          return invalidSlide(slideParam, carousel.slides);
        const buffer = await exportPdf(slides, aspectRatio);
        const suffix = slideParam ? `-slide-${slideNumber}` : "";
        return binary(buffer, "pdf", `${safeName}${suffix}.pdf`);
      }

      case "html": {
        const html = await exportHtml(carousel.slides, aspectRatio);
        return text(html, "html", `${safeName}.html`);
      }
    }
  } catch (error) {
    console.error("Export error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Export failed: ${message}` },
      { status: 500 }
    );
  }
}

function invalidSlide(slideParam: string | null, slides: Slide[]) {
  return NextResponse.json(
    {
      error: `Invalid slide number "${slideParam}" — carousel has ${slides.length} slide(s)`,
    },
    { status: 400 }
  );
}

function binary(
  buffer: Buffer,
  format: ExportFormat,
  filename: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": CONTENT_TYPE[format],
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...extraHeaders,
    },
  });
}

function text(
  body: string,
  format: ExportFormat,
  filename: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPE[format],
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...extraHeaders,
    },
  });
}
