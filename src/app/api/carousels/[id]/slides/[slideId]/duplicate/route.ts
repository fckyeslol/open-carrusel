import { NextResponse } from "next/server";
import { duplicateSlide } from "@/lib/carousels";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; slideId: string }> }
) {
  const { id, slideId } = await params;
  const slide = await duplicateSlide(id, slideId);
  if (!slide) {
    return NextResponse.json(
      { error: "Carousel/slide not found or max slides reached" },
      { status: 400 }
    );
  }
  return NextResponse.json(slide, { status: 201 });
}
