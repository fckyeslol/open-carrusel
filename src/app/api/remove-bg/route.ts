import { NextResponse } from "next/server";
import { readFile, mkdir, stat } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { generateId } from "@/lib/utils";

const execFileAsync = promisify(execFile);

const UPLOAD_DIR = path.resolve(process.cwd(), "public/uploads");
const WORKER_PATH = path.resolve(process.cwd(), "scripts/remove-bg-worker.mjs");
/** El modelo ONNX en CPU puede tardar; más que esto es que algo se colgó. */
const WORKER_TIMEOUT_MS = 180_000;

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

    // El quitado de fondo corre en un PROCESO HIJO aislado (ver el porqué en
    // scripts/remove-bg-worker.mjs): el sharp nativo de @imgly choca con el
    // sharp de Next.js si se cargan en el mismo proceso y el server muere con
    // segfault. Aislado, un crash del modelo solo tumba al worker.
    await mkdir(UPLOAD_DIR, { recursive: true });
    const id = generateId();
    const filename = `${id}.png`;
    const outputPath = path.join(UPLOAD_DIR, filename);

    try {
      await execFileAsync(
        process.execPath,
        [WORKER_PATH, filePath, outputPath, mime],
        { timeout: WORKER_TIMEOUT_MS, windowsHide: true }
      );
    } catch (workerError) {
      const stderr =
        workerError && typeof workerError === "object" && "stderr" in workerError
          ? String(workerError.stderr)
          : "";
      console.error("Remove-bg worker falló:", stderr || workerError);
      return NextResponse.json(
        { error: "No se pudo quitar el fondo. Probá de nuevo." },
        { status: 500 }
      );
    }

    // El worker devuelve 0 solo si escribió el PNG; igual verificamos.
    const written = await stat(outputPath).catch(() => null);
    if (!written || written.size === 0) {
      return NextResponse.json(
        { error: "No se pudo quitar el fondo. Probá de nuevo." },
        { status: 500 }
      );
    }

    return NextResponse.json({ id, url: `/uploads/${filename}`, type: "image" });
  } catch (error) {
    console.error("Remove-bg error:", error);
    return NextResponse.json(
      { error: "No se pudo quitar el fondo. Probá de nuevo." },
      { status: 500 }
    );
  }
}
