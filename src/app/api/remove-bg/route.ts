import { NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { generateId } from "@/lib/utils";

const UPLOAD_DIR = path.resolve(process.cwd(), "public/uploads");

/** El detector de @imgly exige el MIME real del Blob: lo sacamos de los magic bytes. */
function sniffMime(buf: Buffer): string | null {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46)
    return "image/webp"; // RIFF
  return null;
}

/**
 * Quita el fondo de una imagen ya subida y devuelve un PNG nuevo con
 * transparencia en /uploads/. Corre 100% local (@imgly/background-removal-node,
 * modelo ONNX incluido en el paquete — sin API keys ni red).
 *
 * Body: { url: string }  — ruta /uploads/... (o URL absoluta con ese pathname).
 * La imagen original NO se toca: se escribe un archivo nuevo.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const rawUrl = typeof body?.url === "string" ? body.url : "";
    if (!rawUrl) {
      return NextResponse.json({ error: "Falta 'url' en el body" }, { status: 400 });
    }

    // Aceptamos URL absoluta o relativa, pero SOLO procesamos archivos locales
    // de /uploads/ (nunca se descarga nada externo).
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
        { error: "Solo se puede quitar el fondo de imágenes subidas (/uploads/...)" },
        { status: 400 }
      );
    }

    // Anti path-traversal: el resolve tiene que quedar DENTRO de public/uploads
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

    const mime = sniffMime(input);
    if (!mime) {
      return NextResponse.json(
        { error: "Formato no soportado (solo PNG, JPG o WebP)" },
        { status: 400 }
      );
    }

    // Import dinámico: el paquete (~80MB con el modelo) solo se carga la primera
    // vez que alguien quita un fondo, no en cada arranque del server.
    const { removeBackground } = await import("@imgly/background-removal-node");
    const result = await removeBackground(
      new Blob([new Uint8Array(input)], { type: mime }),
      { output: { format: "image/png", quality: 1 } }
    );
    const output = Buffer.from(await result.arrayBuffer());

    await mkdir(UPLOAD_DIR, { recursive: true });
    const id = generateId();
    const filename = `${id}.png`;
    await writeFile(path.join(UPLOAD_DIR, filename), output);

    return NextResponse.json({ id, url: `/uploads/${filename}`, type: "image" });
  } catch (error) {
    console.error("Remove-bg error:", error);
    return NextResponse.json(
      { error: "No se pudo quitar el fondo. Probá de nuevo." },
      { status: 500 }
    );
  }
}
