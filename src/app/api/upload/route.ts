import { NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { generateId } from "@/lib/utils";

const UPLOAD_DIR = path.resolve(process.cwd(), "public/uploads");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Magic bytes for allowed image types (all decodable by Sharp)
const MAGIC_BYTES: Record<string, number[][]> = {
  png: [[0x89, 0x50, 0x4e, 0x47]],
  jpg: [
    [0xff, 0xd8, 0xff],
  ],
  webp: [[0x52, 0x49, 0x46, 0x46]], // RIFF header
  gif: [[0x47, 0x49, 0x46, 0x38]], // GIF8
  tiff: [
    [0x49, 0x49, 0x2a, 0x00], // little-endian
    [0x4d, 0x4d, 0x00, 0x2a], // big-endian
  ],
};

// Font file magic bytes
const FONT_MAGIC: Record<string, number[][]> = {
  woff2: [[0x77, 0x4f, 0x46, 0x32]], // wOF2
  woff: [[0x77, 0x4f, 0x46, 0x46]], // wOFF
  ttf: [[0x00, 0x01, 0x00, 0x00]],
  otf: [[0x4f, 0x54, 0x54, 0x4f]], // OTTO
};

function matchesMagic(buffer: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, i) => buffer[i] === byte);
}

// AVIF es ISO-BMFF: "ftyp" en bytes 4-7 y brand "avif"/"avis" en 8-11
function isAvif(buffer: Uint8Array): boolean {
  if (buffer.length < 12) return false;
  const tag = String.fromCharCode(...buffer.subarray(4, 12));
  return tag.startsWith("ftyp") && (tag.endsWith("avif") || tag.endsWith("avis"));
}

function detectType(
  buffer: Uint8Array
): "image" | "font" | null {
  if (isAvif(buffer)) return "image";
  for (const patterns of Object.values(MAGIC_BYTES)) {
    for (const pattern of patterns) {
      if (matchesMagic(buffer, pattern)) return "image";
    }
  }
  for (const patterns of Object.values(FONT_MAGIC)) {
    for (const pattern of patterns) {
      if (matchesMagic(buffer, pattern)) return "font";
    }
  }
  return null;
}

// Extensión con la que guardar una fuente, derivada de sus magic bytes
function fontExtFor(buffer: Uint8Array): string {
  for (const [name, patterns] of Object.entries(FONT_MAGIC)) {
    if (patterns.some((p) => matchesMagic(buffer, p))) return `.${name}`;
  }
  return ".ttf";
}

export async function POST(request: Request) {
  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Request must be multipart/form-data with a 'file' field" },
        { status: 400 }
      );
    }
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File too large (max 10MB)" },
        { status: 400 }
      );
    }

    const ext = path.extname(file.name).toLowerCase();

    // SVGs: sanitize and store directly (strip scripts/event-handlers for XSS safety)
    if (ext === ".svg" || file.type === "image/svg+xml") {
      const text = Buffer.from(await file.arrayBuffer()).toString("utf-8");
      // Strip <script> blocks, on* event attributes, javascript: hrefs, <foreignObject>
      const sanitized = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "")
        .replace(/\bon\w+\s*=\s*[^\s>]+/gi, "")
        .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, "")
        .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
      const svgDir = path.join(UPLOAD_DIR, "icons");
      await mkdir(svgDir, { recursive: true });
      const id = generateId();
      const filename = `${id}.svg`;
      await writeFile(path.join(svgDir, filename), sanitized, "utf-8");
      return NextResponse.json({ id, url: `/uploads/icons/${filename}`, type: "svg" });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    // Validate magic bytes
    const fileType = detectType(buffer);
    if (!fileType) {
      return NextResponse.json(
        { error: "Unsupported file type. Allowed: PNG, JPG, WebP, GIF, AVIF, TIFF, SVG, WOFF2, WOFF, TTF, OTF" },
        { status: 400 }
      );
    }

    const id = generateId();
    await mkdir(UPLOAD_DIR, { recursive: true });

    if (fileType === "font") {
      // Save fonts directly — no Sharp processing
      const fontExt = fontExtFor(buffer);
      const fontDir = path.join(UPLOAD_DIR, "fonts");
      await mkdir(fontDir, { recursive: true });
      const filename = `${id}${fontExt}`;
      await writeFile(path.join(fontDir, filename), Buffer.from(arrayBuffer));
      return NextResponse.json({
        id,
        url: `/uploads/fonts/${filename}`,
        type: "font",
      });
    }

    // Los fondos van a sangre y pueden ser 4:5 (1080x1350) o 9:16 (1080x1920):
    // el recorte a 1080x1080 del flujo normal los dejaría cortos de alto, así que
    // usan su propio pipeline (JPEG, porque son fotos y en PNG pesarían de más).
    if (formData.get("purpose") === "background") {
      const bgDir = path.join(UPLOAD_DIR, "backgrounds");
      await mkdir(bgDir, { recursive: true });
      const processed = await sharp(Buffer.from(arrayBuffer))
        .resize(1080, 1920, { fit: "inside", withoutEnlargement: true })
        .toColorspace("srgb")
        .jpeg({ quality: 86 })
        .toBuffer();
      const { width = 0, height = 0 } = await sharp(processed).metadata();
      const filename = `${id}.jpg`;
      await writeFile(path.join(bgDir, filename), processed);
      return NextResponse.json({
        id,
        url: `/uploads/backgrounds/${filename}`,
        type: "background",
        width,
        height,
      });
    }

    // Process image through Sharp: strip EXIF, enforce sRGB, max 1080px, convert to PNG
    const processed = await sharp(Buffer.from(arrayBuffer))
      .resize(1080, 1080, { fit: "inside", withoutEnlargement: true })
      .toColorspace("srgb")
      .png()
      .toBuffer();

    const filename = `${id}.png`;
    await writeFile(path.join(UPLOAD_DIR, filename), processed);

    return NextResponse.json({
      id,
      url: `/uploads/${filename}`,
      type: "image",
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Failed to process upload" },
      { status: 500 }
    );
  }
}
