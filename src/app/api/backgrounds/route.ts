import { NextResponse } from "next/server";
import { listBackgrounds, createBackground } from "@/lib/backgrounds";

const MAX_NAME = 120;
const MAX_CATEGORY = 60;

export async function GET() {
  const backgrounds = await listBackgrounds();
  return NextResponse.json({ backgrounds });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body inválido: se esperaba JSON" }, { status: 400 });
  }

  const { url, name, category, width, height } = (body ?? {}) as Record<string, unknown>;

  // La URL tiene que venir del propio endpoint de upload. Además del prefijo,
  // limitamos el charset del nombre de archivo: la URL termina interpolada en un
  // valor CSS (`url('…')`), así que comillas, paréntesis o backslashes no tienen
  // por qué existir acá aunque hoy el sink sea CSSOM y no concatenación.
  const URL_PATTERN = /^\/uploads\/backgrounds\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/;
  if (typeof url !== "string" || !URL_PATTERN.test(url)) {
    return NextResponse.json(
      { error: "url debe ser una ruta /uploads/backgrounds/… devuelta por /api/upload" },
      { status: 400 }
    );
  }
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "name es obligatorio" }, { status: 400 });
  }
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
    return NextResponse.json({ error: "width y height deben ser números positivos" }, { status: 400 });
  }

  const background = await createBackground({
    url,
    name: name.trim().slice(0, MAX_NAME),
    category:
      typeof category === "string" && category.trim()
        ? category.trim().slice(0, MAX_CATEGORY)
        : "general",
    width,
    height,
  });

  return NextResponse.json(background, { status: 201 });
}
