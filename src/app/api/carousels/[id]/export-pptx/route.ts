import { NextResponse } from "next/server";
import { getCarousel } from "@/lib/carousels";
import { exportCarouselToPptx } from "@/lib/export-pptx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  _request: Request,
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

  try {
    const pptxBuffer = await exportCarouselToPptx(
      carousel.slides,
      carousel.aspectRatio
    );

    const safeName = carousel.name.replace(/[^a-zA-Z0-9-_]/g, "_");
    return new Response(new Uint8Array(pptxBuffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="carousel-${safeName}.pptx"`,
      },
    });
  } catch (error) {
    console.error("PPTX export error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `PPTX export failed: ${message}` },
      { status: 500 }
    );
  }
}
