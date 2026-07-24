import { NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import path from "path";

/**
 * Sirve las imágenes de `public/uploads/**` (referentes bajados de Instagram,
 * subidas de la diseñadora, recortes, etc.).
 *
 * ¿Por qué una ruta y no el static de Next? En Cloud Run `public/uploads` es un
 * volumen GCS montado en runtime; los archivos que se escriben ahí DESPUÉS del
 * build no los sirve el manejador de estáticos → daban 404 (miniaturas rotas en
 * Assets, imágenes rotas dentro de las láminas, export fallido). Leyendo el
 * archivo directo del volumen —igual que la ruta de avatar-assets— se sirven bien
 * en producción. En local también funciona (lee de public/uploads en disco).
 */
const UPLOADS_DIR = path.resolve(process.cwd(), "public", "uploads");

// Separadores, reservados de Windows y caracteres de control quedan fuera.
// eslint-disable-next-line no-control-regex
const BAD_SEGMENT_CHARS = /[\\/:*?"<>|\x00-\x1f]/;

function isSafeSegment(s: string): boolean {
  if (!s || s === "." || s === "..") return false;
  if (BAD_SEGMENT_CHARS.test(s)) return false;
  if (s.startsWith(".") || s.endsWith(".") || s.endsWith(" ")) return false;
  return true;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string[] }> }
) {
  const { file } = await params;

  if (!Array.isArray(file) || file.length === 0 || !file.every(isSafeSegment)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = path.extname(file[file.length - 1]).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ error: "Unsupported file type" }, { status: 404 });
  }

  const resolved = path.resolve(UPLOADS_DIR, ...file);
  // Cinturón y tirantes: la ruta final debe seguir dentro de public/uploads.
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const data = await readFile(resolved);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
