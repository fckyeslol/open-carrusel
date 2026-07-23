import { NextResponse } from "next/server";
import { redoSlide } from "@/lib/carousels";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; slideId: string }> }
) {
  const { id, slideId } = await params;
  const slide = await redoSlide(id, slideId);
  if (!slide) {
    return NextResponse.json(
      { error: "Not found or no versions to redo" },
      { status: 404 }
    );
  }
  return NextResponse.json(slide);
}
