import { NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import path from "path";

/**
 * Sirve los assets de marca de cada avatar (avenger) desde <root>/<slug>/assets/**.
 * Así las láminas pueden referenciar `/avatar-assets/<slug>/fotos/retrato.jpg` sin
 * copiar nada a public/ y sin riesgo de que la copia quede desactualizada.
 *
 * La raíz sale de AVATAR_ASSETS_DIR (en Cloud Run apunta al bucket `uploads`
 * montado, para que los assets persistan entre deploys); sin la env cae en la
 * carpeta versionada 30x/avatars — debe coincidir con la escritura en
 * src/lib/avatar-assets.ts.
 */
const ASSETS_DIR = process.env.AVATAR_ASSETS_DIR
  ? path.resolve(process.env.AVATAR_ASSETS_DIR)
  : path.resolve(process.cwd(), "30x", "avatars");

// Solo nombres seguros: slug del avatar y segmentos de ruta sin traversal.
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
// Separadores, reservados de Windows y caracteres de control quedan fuera; el
// resto (tildes, espacios, ñ) se permite — los assets llevan nombres en español.
// eslint-disable-next-line no-control-regex
const BAD_SEGMENT_CHARS = /[\\/:*?"<>|\x00-\x1f]/;

function isSafeSegment(s: string): boolean {
  if (!s || s === "." || s === "..") return false;
  if (BAD_SEGMENT_CHARS.test(s)) return false;
  // Ocultos (.gitkeep) y rarezas de Windows (punto/espacio final) no se sirven.
  if (s.startsWith(".") || s.endsWith(".") || s.endsWith(" ")) return false;
  return true;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; file: string[] }> }
) {
  const { slug, file } = await params;

  if (!SAFE_SLUG.test(slug) || !Array.isArray(file) || file.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Next.js ya decodificó los params una vez; NO volver a decodificar acá
  // (un archivo con "%" literal en el nombre reventaría con URIError).
  if (!file.every(isSafeSegment)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = path.extname(file[file.length - 1]).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ error: "Unsupported file type" }, { status: 404 });
  }

  const assetsBase = path.join(ASSETS_DIR, slug, "assets");
  const resolved = path.resolve(assetsBase, ...file);
  // Cinturón y tirantes: aunque los segmentos ya están whitelisteados, verificar
  // que la ruta final siga dentro de la carpeta de assets del avatar.
  if (!resolved.startsWith(assetsBase + path.sep)) {
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
        "Cache-Control": "public, max-age=60",
        // SVG puede llevar <script>; bloquearlo si alguien abre el archivo directo.
        ...(ext === ".svg"
          ? { "Content-Security-Policy": "script-src 'none'", "X-Content-Type-Options": "nosniff" }
          : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
