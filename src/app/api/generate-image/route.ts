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
import { writeFile, mkdir, readFile } from "fs/promises";
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
const UPLOADS_DIR = path.resolve(process.cwd(), "public", "uploads");
const AVATARS_DIR = path.resolve(process.cwd(), "30x", "avatars");
const MAX_PROMPT = 2000;
const VALID_RATIOS: AspectRatio[] = ["1:1", "4:5", "9:16"];
/** Lado máximo de la imagen de referencia que se sube a Higgsfield. */
const MAX_REFERENCE_SIDE = 2048;

/**
 * Resuelve una ruta pública local (`/uploads/...` o `/avatar-assets/...`) al
 * archivo real en disco. Devuelve null si la ruta es inválida o se escapa de
 * las carpetas permitidas — nunca se leen archivos arbitrarios.
 */
function resolveLocalImagePath(ref: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) return null;

  if (decoded.startsWith("/uploads/") && segments.length >= 2) {
    const resolved = path.resolve(UPLOADS_DIR, ...segments.slice(1));
    return resolved.startsWith(UPLOADS_DIR + path.sep) ? resolved : null;
  }
  // /avatar-assets/<slug>/<kind>/<file> → 30x/avatars/<slug>/assets/<kind>/<file>
  if (decoded.startsWith("/avatar-assets/") && segments.length >= 3) {
    const [, slug, ...rest] = segments;
    const assetsBase = path.join(AVATARS_DIR, slug, "assets");
    const resolved = path.resolve(assetsBase, ...rest);
    return resolved.startsWith(assetsBase + path.sep) ? resolved : null;
  }
  return null;
}

interface Body {
  prompt?: string;
  aspectRatio?: string;
  quality?: string;
  seed?: number;
  customReferenceId?: string;
  customReferenceStrength?: number;
  styleId?: string;
  styleStrength?: number;
  /**
   * Ruta pública local de una imagen de referencia (`/uploads/...` o
   * `/avatar-assets/...`). Se sube a Higgsfield y Soul la usa como base
   * visual (image→image): composición, persona, ambiente.
   */
  imageReference?: string;
  /** Si es true, además guarda la imagen en la biblioteca de fondos. */
  saveAsBackground?: boolean;
  /** Nombre para la biblioteca de fondos (si saveAsBackground). */
  name?: string;
  /** Categoría para la biblioteca de fondos (si saveAsBackground). */
  category?: string;
}

export async function POST(request: Request) {
  if (!(await isHiggsfieldConfigured())) {
    return NextResponse.json(
      {
        error:
          "Higgsfield no está configurado. Cargá tus claves en el panel /30x, o definí HF_API_KEY y HF_API_SECRET (claves de https://cloud.higgsfield.ai/api-keys).",
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

  // Imagen de referencia (image→image): leerla del disco y normalizarla a JPEG
  // sRGB acotado, que es lo que higgsfield.ts sube a su CDN.
  let imageReferenceBytes: Buffer | undefined;
  if (body.imageReference !== undefined) {
    if (typeof body.imageReference !== "string" || !body.imageReference.trim()) {
      return NextResponse.json({ error: "'imageReference' inválido" }, { status: 400 });
    }
    const localPath = resolveLocalImagePath(body.imageReference.trim());
    if (!localPath) {
      return NextResponse.json(
        {
          error:
            "'imageReference' debe ser una ruta local /uploads/... o /avatar-assets/... (no URLs externas).",
        },
        { status: 400 }
      );
    }
    try {
      const raw = await readFile(localPath);
      imageReferenceBytes = await sharp(raw)
        .resize(MAX_REFERENCE_SIDE, MAX_REFERENCE_SIDE, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .toColorspace("srgb")
        .jpeg({ quality: 92 })
        .toBuffer();
    } catch {
      return NextResponse.json(
        { error: `No se pudo leer la imagen de referencia: ${body.imageReference}` },
        { status: 400 }
      );
    }
  }

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
      imageReferenceBytes,
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
