import { NextResponse } from "next/server";
import { getPalette, setPalette } from "@/lib/palettes";

/**
 * Paleta de color propia de un avatar (por su style-preset).
 *   GET → { colors: string[] }         colores guardados
 *   PUT { colors: string[] } → { colors } reemplaza la paleta (se normaliza en el server)
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ presetId: string }> }
) {
  const { presetId } = await params;
  const colors = await getPalette(presetId);
  return NextResponse.json({ colors });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ presetId: string }> }
) {
  const { presetId } = await params;
  try {
    const body = await request.json();
    const colors = Array.isArray(body?.colors) ? body.colors : [];
    const saved = await setPalette(presetId, colors);
    return NextResponse.json({ colors: saved });
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
}
