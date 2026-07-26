import { NextResponse } from "next/server";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { generateId } from "@/lib/utils";

const UPLOAD_DIR = path.resolve(process.cwd(), "public/uploads");

/**
 * Efectos que necesitan reescribir los píxeles.
 *
 * Casi toda la biblioteca de efectos del editor es CSS/SVG, porque así el preview
 * y el PNG exportado son el mismo render. El pixelado es la excepción: no existe
 * primitiva de submuestreo en filtros SVG, y los trucos con feImage/feTile no son
 * confiables. Se hornea con sharp — baja la imagen a un puñado de píxeles y la
 * sube con vecino más cercano — y el resultado se guarda como una imagen nueva en
 * /uploads/, así el editor lo trata como cualquier otra fuente (y queda en el
 * historial de versiones de la imagen, para poder volver atrás).
 *
 * Body: { url: "/uploads/…", effect: "pixelate", amount?: 1..100 }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const rawUrl = typeof body?.url === "string" ? body.url : "";
    const effect = typeof body?.effect === "string" ? body.effect : "pixelate";
    const amount = Math.max(1, Math.min(100, Number(body?.amount) || 30));

    if (!rawUrl) {
      return NextResponse.json({ error: "Falta 'url' en el body" }, { status: 400 });
    }
    if (effect !== "pixelate") {
      return NextResponse.json({ error: `Efecto no soportado: ${effect}` }, { status: 400 });
    }

    // Igual que /api/remove-bg: solo archivos locales de /uploads/, nunca se
    // descarga nada externo, y el resolve tiene que caer DENTRO de la carpeta.
    let pathname = rawUrl;
    if (/^https?:\/\//i.test(rawUrl)) {
      try {
        pathname = new URL(rawUrl).pathname;
      } catch {
        return NextResponse.json({ error: "URL inválida" }, { status: 400 });
      }
    }
    pathname = decodeURIComponent(pathname);
    if (!pathname.startsWith("/uploads/")) {
      return NextResponse.json(
        { error: "Solo se pueden procesar imágenes subidas (/uploads/...)" },
        { status: 400 }
      );
    }
    const filePath = path.resolve(UPLOAD_DIR, pathname.slice("/uploads/".length));
    if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
      return NextResponse.json({ error: "Ruta inválida" }, { status: 400 });
    }

    let input: Buffer;
    try {
      input = await readFile(filePath);
    } catch {
      return NextResponse.json({ error: "La imagen no existe en el servidor" }, { status: 404 });
    }

    const meta = await sharp(input).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) {
      return NextResponse.json({ error: "No se pudo leer la imagen" }, { status: 400 });
    }

    // amount 1 = bloques mínimos (casi original); 100 = bloques enormes. El ancho
    // reducido va de ~la mitad de la imagen a 6px.
    const minSide = 6;
    const reducido = Math.max(minSide, Math.round((w / 2) * (1 - amount / 100) + minSide));
    const alto = Math.max(minSide, Math.round((reducido * h) / w));

    // DOS pipelines separados, no dos .resize() encadenados: sharp guarda una sola
    // configuración de resize por pipeline, así que encadenarlos hace que solo valga
    // el último y la imagen sale idéntica (verificado: bloques de 1px).
    const chico = await sharp(input)
      .resize(reducido, alto, { kernel: "cubic", fit: "fill" })
      .png()
      .toBuffer();
    // nearest en la subida es lo que deja los bloques con el borde duro.
    const out = await sharp(chico)
      .resize(w, h, { kernel: "nearest", fit: "fill" })
      .png()
      .toBuffer();

    await mkdir(UPLOAD_DIR, { recursive: true });
    const id = generateId();
    const filename = `${id}.png`;
    const outputPath = path.join(UPLOAD_DIR, filename);
    await writeFile(outputPath, out);

    const written = await stat(outputPath).catch(() => null);
    if (!written || written.size === 0) {
      return NextResponse.json({ error: "No se pudo generar la imagen" }, { status: 500 });
    }

    return NextResponse.json({ id, url: `/uploads/${filename}`, type: "image" });
  } catch (error) {
    console.error("image-fx error:", error);
    return NextResponse.json({ error: "No se pudo aplicar el efecto" }, { status: 500 });
  }
}
