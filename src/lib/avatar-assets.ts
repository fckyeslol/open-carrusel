import { readdir, readFile, writeFile, unlink, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

/**
 * Assets de marca por avatar (avenger). Esta lib es la única puerta de escritura
 * desde la app. Tras cada cambio se re-corre import-avatars.mjs para que el
 * preset (logoPath + designRules) refleje los assets sin esperar al próximo
 * arranque.
 *
 * Dos raíces distintas a propósito:
 *  - AVATARS_DIR (30x/avatars): el ADN de cada avatar, versionado en git y
 *    horneado en la imagen. Es la fuente para listar avatares y validar slugs.
 *  - ASSETS_DIR: los ARCHIVOS de assets. Por defecto comparten carpeta con el
 *    ADN (local/compose). En Cloud Run el FS de la imagen es efímero (se pierde
 *    en cada deploy), así que AVATAR_ASSETS_DIR los manda al bucket `uploads`
 *    montado (/app/public/uploads/avatar-assets) para que persistan. La URL
 *    servida (/avatar-assets/<slug>/<kind>/<file>) no cambia en ningún caso.
 */
const AVATARS_DIR = path.resolve(process.cwd(), "30x", "avatars");
const ASSETS_DIR = process.env.AVATAR_ASSETS_DIR
  ? path.resolve(process.env.AVATAR_ASSETS_DIR)
  : AVATARS_DIR;
const IMPORT_SCRIPT = path.resolve(process.cwd(), "scripts", "import-avatars.mjs");

export const ASSET_KINDS = ["logo", "fotos", "fondos", "referencias"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10MB — mismo tope que /api/upload

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

export interface AvatarAssets {
  slug: string;
  name: string;
  assets: Record<AssetKind, Array<{ file: string; url: string }>>;
}

export function isAssetKind(v: string): v is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(v);
}

export function isValidSlug(slug: string): boolean {
  return SAFE_SLUG.test(slug) && existsSync(path.join(AVATARS_DIR, slug, "adn.json"));
}

function assetUrl(slug: string, kind: AssetKind, file: string): string {
  return `/avatar-assets/${slug}/${kind}/${encodeURIComponent(file)}`;
}

/**
 * Limpia un nombre de archivo subido: sin rutas, sin caracteres reservados de
 * Windows ni de URL-routing, sin ocultos. Conserva tildes/ñ/espacios — los
 * nombres los leen humanos y viajan por git sin problema.
 */
export function sanitizeAssetFilename(name: string): string | null {
  const base = path.basename(String(name)).normalize("NFC");
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (!cleaned || !IMAGE_EXTS.has(path.extname(cleaned).toLowerCase())) return null;
  // Nombres de dispositivo reservados de Windows: "nul.png" revienta el writeFile.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) return null;
  return cleaned;
}

/**
 * Detecta el formato real por magic bytes (mismo criterio que /api/upload + GIF).
 * WebP exige el FourCC "WEBP" en el offset 8 — "RIFF" solo también lo son WAV/AVI.
 */
function detectImageExt(buffer: Uint8Array): string | null {
  const at = (offset: number, bytes: number[]) => bytes.every((b, i) => buffer[offset + i] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return ".png";
  if (at(0, [0xff, 0xd8, 0xff])) return ".jpg";
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return ".gif";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return ".webp";
  return null;
}

async function listKind(slug: string, kind: AssetKind): Promise<Array<{ file: string; url: string }>> {
  const dir = path.join(ASSETS_DIR, slug, "assets", kind);
  if (!existsSync(dir)) return [];
  try {
    const files = (await readdir(dir))
      .filter((f) => !f.startsWith(".") && IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
    return files.map((file) => ({ file, url: assetUrl(slug, kind, file) }));
  } catch {
    return [];
  }
}

/** Lista todos los avatares (con adn.json, salvo _TEMPLATE/default) y sus assets. */
export async function listAvatarAssets(): Promise<AvatarAssets[]> {
  const entries = await readdir(AVATARS_DIR, { withFileTypes: true });
  const slugs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && e.name !== "default")
    .map((e) => e.name)
    .filter((slug) => existsSync(path.join(AVATARS_DIR, slug, "adn.json")))
    .sort();

  const out: AvatarAssets[] = [];
  for (const slug of slugs) {
    let name = slug;
    try {
      const adn = JSON.parse(await readFile(path.join(AVATARS_DIR, slug, "adn.json"), "utf-8"));
      name = adn?.avatar?.name || slug;
    } catch {
      // adn ilegible → mostrar el slug igual
    }
    const assets = {} as AvatarAssets["assets"];
    for (const kind of ASSET_KINDS) assets[kind] = await listKind(slug, kind);
    out.push({ slug, name, assets });
  }
  return out;
}

/**
 * Guarda un asset validado. Devuelve el nombre final (con sufijo -2, -3… si ya
 * existía uno igual) o lanza Error con mensaje apto para mostrar al usuario.
 */
export async function saveAvatarAsset(
  slug: string,
  kind: AssetKind,
  originalName: string,
  buffer: Buffer
): Promise<{ file: string; url: string }> {
  if (!isValidSlug(slug)) throw new Error("Avatar desconocido");
  if (buffer.length === 0) throw new Error("El archivo está vacío");
  if (buffer.length > MAX_ASSET_SIZE) throw new Error("Máximo 10MB por archivo");

  const detectedExt = detectImageExt(buffer);
  if (!detectedExt) throw new Error("Solo imágenes PNG, JPG, WebP o GIF");

  let file = sanitizeAssetFilename(originalName) || `asset${detectedExt}`;
  // La extensión final siempre sale del contenido real, no del nombre.
  const claimedExt = path.extname(file).toLowerCase();
  const extOk =
    claimedExt === detectedExt || (detectedExt === ".jpg" && claimedExt === ".jpeg");
  if (!extOk) file = file.slice(0, file.length - claimedExt.length) + detectedExt;

  const dir = path.join(ASSETS_DIR, slug, "assets", kind);
  await mkdir(dir, { recursive: true });

  // Evitar pisar un asset existente: sufijo incremental.
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  let final = file;
  for (let i = 2; existsSync(path.join(dir, final)); i++) {
    final = `${stem}-${i}${ext}`;
  }

  await writeFile(path.join(dir, final), buffer);
  await refreshAvatarPresets();
  return { file: final, url: assetUrl(slug, kind, final) };
}

/** Borra un asset existente. Devuelve false si no existía. */
export async function deleteAvatarAsset(
  slug: string,
  kind: AssetKind,
  file: string
): Promise<boolean> {
  if (!isValidSlug(slug)) return false;
  const safe = sanitizeAssetFilename(file);
  if (!safe || safe !== file) return false;
  const target = path.join(ASSETS_DIR, slug, "assets", kind, safe);
  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    await unlink(target);
  } catch {
    return false;
  }
  await refreshAvatarPresets();
  return true;
}

/**
 * Re-genera data/style-presets.json para que logoPath y el inventario de assets
 * del designRules queden al día. Falla suave: si no corre, el próximo arranque
 * de la app lo regenera igual.
 */
async function refreshAvatarPresets(): Promise<void> {
  try {
    await execFileAsync(process.execPath, [IMPORT_SCRIPT], {
      cwd: process.cwd(),
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (err) {
    console.error("[avatar-assets] no se pudo refrescar style-presets:", err);
  }
}
