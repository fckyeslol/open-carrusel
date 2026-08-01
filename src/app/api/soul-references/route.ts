/**
 * GET  /api/soul-references — lista las referencias de persona (SoulIds) de la cuenta.
 * POST /api/soul-references — crea una a partir de varias fotos de la misma persona.
 *
 * Por qué existe: una imagen de referencia normal (image→image) le da a Soul la
 * composición, no la CARA. Pedir "Elon Musk" pasando su foto devolvía a alguien
 * parecido pero distinto, y la diseñadora terminaba buscando la imagen a mano — el
 * trabajo que la herramienta venía a sacarle. La identidad se sostiene con una SoulId:
 * una referencia de personaje entrenada con varias fotos, que después viaja como
 * `customReferenceId` en cada generación.
 *
 * El POST recibe multipart: `nombre` + N archivos en `fotos`. Las normaliza a JPEG con
 * el mismo pipeline de sharp que las subidas y se las pasa a `crearSoulId`.
 */
import { NextResponse } from "next/server";
import sharp from "sharp";
import {
  crearSoulId,
  listarSoulIds,
  isHiggsfieldConfigured,
  HiggsfieldError,
  SOUL_MIN_IMAGENES,
  SOUL_MAX_IMAGENES,
} from "@/lib/higgsfield";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Entrenar no se espera acá, pero subir 20 fotos al CDN sí lleva su tiempo.
export const maxDuration = 300;

/** Lado máximo de cada foto que se sube. Más grande no mejora el parecido. */
const MAX_LADO = 1536;
const MAX_BYTES = 10 * 1024 * 1024;

export async function GET() {
  if (!(await isHiggsfieldConfigured())) {
    return NextResponse.json({ referencias: [], configurado: false });
  }
  return NextResponse.json({ referencias: await listarSoulIds(), configurado: true });
}

export async function POST(request: Request) {
  if (!(await isHiggsfieldConfigured())) {
    return NextResponse.json(
      {
        error:
          "Higgsfield no está configurado. Cargá tus claves en el panel /30x, o definí " +
          "HF_API_KEY y HF_API_SECRET.",
      },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Se esperaba multipart/form-data con 'nombre' y los archivos en 'fotos'." },
      { status: 400 }
    );
  }

  const nombre = String(form.get("nombre") ?? "").trim();
  if (!nombre) {
    return NextResponse.json(
      { error: "Falta 'nombre'. Es con lo que vas a elegir la referencia después (ej. \"Elon Musk\")." },
      { status: 400 }
    );
  }

  const archivos = form.getAll("fotos").filter((f): f is File => f instanceof File);
  if (archivos.length < SOUL_MIN_IMAGENES) {
    return NextResponse.json(
      {
        error:
          `Hacen falta al menos ${SOUL_MIN_IMAGENES} fotos de la persona (llegaron ${archivos.length}). ` +
          `Con menos, el parecido no se sostiene entre generaciones. Mejor si son caras distintas: ` +
          `ángulos, luces y expresiones variadas.`,
      },
      { status: 400 }
    );
  }
  if (archivos.length > SOUL_MAX_IMAGENES) {
    return NextResponse.json(
      { error: `Máximo ${SOUL_MAX_IMAGENES} fotos por referencia (llegaron ${archivos.length}).` },
      { status: 400 }
    );
  }

  // Mismo pipeline que las subidas: sRGB, sin EXIF, lado acotado. Una foto rota por
  // su orientación EXIF entrenaría una cara de costado.
  const fotos: Buffer[] = [];
  for (const archivo of archivos) {
    if (archivo.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `"${archivo.name}" pesa más de 10MB.` },
        { status: 400 }
      );
    }
    try {
      fotos.push(
        await sharp(Buffer.from(await archivo.arrayBuffer()))
          .rotate()
          .resize(MAX_LADO, MAX_LADO, { fit: "inside", withoutEnlargement: true })
          .toColorspace("srgb")
          .jpeg({ quality: 92 })
          .toBuffer()
      );
    } catch {
      return NextResponse.json(
        { error: `No se pudo leer "${archivo.name}". ¿Es una imagen válida?` },
        { status: 400 }
      );
    }
  }

  try {
    const ref = await crearSoulId(nombre, fotos);
    return NextResponse.json({
      ...ref,
      // El entrenamiento sigue del otro lado: sin esto parece que ya se puede usar.
      aviso:
        "La referencia se está entrenando en Higgsfield y tarda unos minutos. Cuando su " +
        "estado sea 'completed' ya se puede usar para generar.",
    });
  } catch (err) {
    if (err instanceof HiggsfieldError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[soul-references] error inesperado", err);
    return NextResponse.json({ error: "No se pudo crear la referencia." }, { status: 500 });
  }
}
