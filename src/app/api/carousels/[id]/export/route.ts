import { NextResponse } from "next/server";
import { getCarousel } from "@/lib/carousels";
import { exportSlide } from "@/lib/export-slides";
import { exportPdf, exportHtml, exportSvg } from "@/lib/export-formats";
import {
  allPages,
  pageFileSuffix,
  parsePageSelection,
  type PageSelection,
} from "@/lib/page-selection";
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
 *   - `png`  — UNA lámina como PNG.
 *   - `pdf`  — las láminas pedidas en un solo PDF (texto editable).
 *   - `html` — las láminas pedidas como un HTML autocontenido y editable.
 *   - `svg`  — UNA lámina como SVG.
 *
 * `?pages=` elige QUÉ láminas, con la misma sintaxis que el menú de exportación
 * ("1", "1,3", "5-7"; ver `page-selection.ts`). Sin él se exportan todas.
 * `?slide=N` es el alias viejo y equivale a `?pages=N`.
 *
 * PNG y SVG son por-lámina: aceptan una sola lámina por llamada y el cliente
 * hace el bucle. PDF y HTML son un único archivo con todas las pedidas.
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
  const total = carousel.slides.length;

  // Sin selección explícita, PNG y SVG siguen dando la primera lámina — es lo que
  // documentaba `?slide=N` desde el principio y lo que espera cualquier curl viejo.
  const porDefecto =
    format === "png" || format === "svg" ? [1] : allPages(total);
  const selection = resolveSelection(url.searchParams, total, porDefecto);
  if (!selection.ok) {
    return NextResponse.json({ error: selection.error }, { status: 400 });
  }
  const pages = selection.pages;
  const suffix = pageFileSuffix(pages, total);

  try {
    switch (format) {
      case "png": {
        if (pages.length !== 1) return unaSolaLamina("PNG", pages);
        // ?transparent=1 → PNG sin la capa de fondo (para componer en otra
        // herramienta). El nombre del archivo lo marca con `-sin-fondo`.
        const transparent = url.searchParams.get("transparent") === "1";
        const buffer = await exportSlide(
          carousel.slides[pages[0] - 1],
          aspectRatio,
          { transparent }
        );
        const alpha = transparent ? "-sin-fondo" : "";
        return binary(
          buffer,
          "png",
          `${safeName}-slide-${pages[0]}${alpha}.png`,
          { "X-Slide-Count": String(total) }
        );
      }

      case "svg": {
        if (pages.length !== 1) return unaSolaLamina("SVG", pages);
        const svg = await exportSvg(carousel.slides[pages[0] - 1], aspectRatio);
        return text(svg, "svg", `${safeName}-slide-${pages[0]}.svg`, {
          "X-Slide-Count": String(total),
        });
      }

      case "pdf": {
        const buffer = await exportPdf(slidesOf(carousel.slides, pages), aspectRatio);
        return binary(buffer, "pdf", `${safeName}${suffix}.pdf`);
      }

      case "html": {
        const html = await exportHtml(slidesOf(carousel.slides, pages), aspectRatio);
        return text(html, "html", `${safeName}${suffix}.html`);
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

/**
 * Qué láminas se piden. `?pages=` es la forma nueva (la misma sintaxis que escribe la
 * diseñadora en el menú); `?slide=N` se mantiene porque era la única que existía y sigue
 * siendo un alias válido. Sin ninguna de las dos, `porDefecto`.
 */
function resolveSelection(
  params: URLSearchParams,
  total: number,
  porDefecto: number[]
): PageSelection {
  const pedido = params.get("pages") ?? params.get("slide");
  if (pedido !== null) return parsePageSelection(pedido, total);
  return { ok: true, pages: porDefecto };
}

function slidesOf(slides: Slide[], pages: number[]): Slide[] {
  return pages.map((page) => slides[page - 1]);
}

/** PNG y SVG son un archivo por lámina: el bucle lo hace el cliente, no la ruta. */
function unaSolaLamina(format: string, pages: number[]) {
  return NextResponse.json(
    {
      error: `${format} es un archivo por lámina: pedí una sola (llegaron ${pages.length})`,
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
