/**
 * POST /api/generate-image — generación nativa de imágenes con Higgsfield.
 *
 * Recibe un prompt (y opciones), genera la imagen con la API Cloud de Higgsfield,
 * la pasa por el MISMO pipeline de `sharp` que las subidas (recorte exacto a las
 * dimensiones del formato, sRGB, sin metadata) y la persiste en `public/uploads`
 * para que entre al mismo circuito que una imagen subida. Opcionalmente la
 * registra en la biblioteca de fondos.
 *
 * Respuesta: { id, url, type, width, height, seed, sourceUrl }
 */
import { NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { generateId } from "@/lib/utils";
import { DIMENSIONS, type AspectRatio } from "@/types/carousel";
import {
  generarImagen,
  isHiggsfieldConfigured,
  HiggsfieldError,
  type ImageQuality,
} from "@/lib/higgsfield";
import { createBackground } from "@/lib/backgrounds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// La generación es asíncrona (encola + polling); dale margen como al chat.
export const maxDuration = 300;

const GENERATED_DIR = path.resolve(process.cwd(), "public/uploads/generated");
const MAX_PROMPT = 2000;
const VALID_RATIOS: AspectRatio[] = ["1:1", "4:5", "9:16"];

interface Body {
  prompt?: string;
  aspectRatio?: string;
  quality?: string;
  seed?: number;
  customReferenceId?: string;
  customReferenceStrength?: number;
  styleId?: string;
  styleStrength?: number;
  /** Si es true, además guarda la imagen en la biblioteca de fondos. */
  saveAsBackground?: boolean;
  /** Nombre para la biblioteca de fondos (si saveAsBackground). */
  name?: string;
  /** Categoría para la biblioteca de fondos (si saveAsBackground). */
  category?: string;
}

export async function POST(request: Request) {
  if (!isHiggsfieldConfigured()) {
    return NextResponse.json(
      {
        error:
          "Higgsfield no está configurado. Agregá HF_API_KEY y HF_API_SECRET en .env.local (claves de https://cloud.higgsfield.ai/api-keys).",
      },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "Falta 'prompt'" }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT) {
    return NextResponse.json(
      { error: `El prompt es demasiado largo (máx ${MAX_PROMPT} caracteres)` },
      { status: 400 }
    );
  }

  const aspectRatio: AspectRatio = VALID_RATIOS.includes(body.aspectRatio as AspectRatio)
    ? (body.aspectRatio as AspectRatio)
    : "4:5";
  const quality: ImageQuality = body.quality === "sd" ? "sd" : "hd";
  const { width, height } = DIMENSIONS[aspectRatio];

  try {
    const generated = await generarImagen({
      prompt,
      aspectRatio,
      quality,
      seed: typeof body.seed === "number" ? body.seed : undefined,
      customReferenceId: body.customReferenceId,
      customReferenceStrength: body.customReferenceStrength,
      styleId: body.styleId,
      styleStrength: body.styleStrength,
    });

    // Mismo pipeline que las subidas: sRGB, sin EXIF, recorte exacto al lienzo.
    // `cover` llena las dimensiones del formato (Soul no da el ratio exacto de IG).
    const processed = await sharp(generated.bytes)
      .resize(width, height, { fit: "cover", position: "attention" })
      .toColorspace("srgb")
      .jpeg({ quality: 88 })
      .toBuffer();

    const id = generateId();
    await mkdir(GENERATED_DIR, { recursive: true });
    const filename = `${id}.jpg`;
    await writeFile(path.join(GENERATED_DIR, filename), processed);
    const url = `/uploads/generated/${filename}`;

    // Opcional: registrar en la biblioteca de fondos para reutilizar.
    if (body.saveAsBackground) {
      await createBackground({
        name: body.name?.trim() || prompt.slice(0, 60),
        url,
        category: body.category?.trim() || "generados",
        width,
        height,
      });
    }

    return NextResponse.json({
      id,
      url,
      type: "generated",
      width,
      height,
      seed: generated.seed,
      sourceUrl: generated.url,
    });
  } catch (err) {
    if (err instanceof HiggsfieldError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[generate-image] error inesperado", err);
    return NextResponse.json(
      { error: "Falló la generación de la imagen." },
      { status: 500 }
    );
  }
}
