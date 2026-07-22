#!/usr/bin/env node
/**
 * Importa fondos desde una carpeta local a la biblioteca de la app.
 *
 * Cada SUBCARPETA se convierte en una categoría, así que si la carpeta viene
 * organizada por avenger (Cinthya/, Guillermo/, …) cada avenger queda como su
 * propia categoría y el slug coincide con el `avatarSlug` de los style-presets.
 *
 *   node scripts/import-backgrounds.mjs <carpeta> [--category <nombre>] [--dry]
 *
 * Las imágenes sueltas en la raíz de <carpeta> caen en la categoría "general"
 * (o en la que se pase con --category).
 */
import { readdir, readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public/uploads/backgrounds");
const DATA_FILE = path.join(ROOT, "data/backgrounds.json");
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_W = 1080;
const MAX_H = 1920;

function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
}

function parseArgs(argv) {
  const positional = [];
  let category = null;
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--category") category = argv[++i];
    else if (argv[i] === "--dry") dry = true;
    else positional.push(argv[i]);
  }
  return { source: positional[0], category, dry };
}

/** Devuelve [{ file, category }] recorriendo un nivel de subcarpetas. */
async function collect(source, rootCategory) {
  const entries = await readdir(source, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = path.join(source, entry.name);
    if (entry.isDirectory()) {
      const category = slugify(entry.name);
      const inner = await readdir(full, { withFileTypes: true });
      for (const f of inner) {
        if (f.isFile() && IMAGE_EXT.has(path.extname(f.name).toLowerCase())) {
          found.push({ file: path.join(full, f.name), category });
        }
      }
    } else if (entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
      found.push({ file: full, category: rootCategory });
    }
  }
  return found;
}

async function readLibrary() {
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.backgrounds) ? parsed.backgrounds : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw new Error(`No pude leer ${DATA_FILE}: ${err.message}`);
  }
}

async function main() {
  const { source, category, dry } = parseArgs(process.argv.slice(2));
  if (!source) {
    console.error("Uso: node scripts/import-backgrounds.mjs <carpeta> [--category <nombre>] [--dry]");
    process.exit(1);
  }

  const abs = path.resolve(source);
  try {
    if (!(await stat(abs)).isDirectory()) throw new Error("no es una carpeta");
  } catch (err) {
    console.error(`Carpeta inválida: ${abs} (${err.message})`);
    process.exit(1);
  }

  const rootCategory = category ? slugify(category) : "general";
  const files = await collect(abs, rootCategory);
  if (files.length === 0) {
    console.error(`No encontré imágenes (${[...IMAGE_EXT].join(", ")}) en ${abs}`);
    process.exit(1);
  }

  const existing = await readLibrary();
  const seen = new Set(existing.map((b) => `${b.category}/${b.name}`));

  const added = [];
  const skipped = [];
  for (const { file, category: cat } of files) {
    const name = path.basename(file, path.extname(file));
    if (seen.has(`${cat}/${name}`)) {
      skipped.push(`${cat}/${name}`);
      continue;
    }
    if (dry) {
      added.push({ category: cat, name });
      continue;
    }

    const processed = await sharp(file)
      .resize(MAX_W, MAX_H, { fit: "inside", withoutEnlargement: true })
      .toColorspace("srgb")
      .jpeg({ quality: 86 })
      .toBuffer();
    const { width, height } = await sharp(processed).metadata();

    const id = randomUUID();
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, `${id}.jpg`), processed);

    added.push({
      id,
      name,
      url: `/uploads/backgrounds/${id}.jpg`,
      category: cat,
      width,
      height,
      createdAt: new Date().toISOString(),
    });
    seen.add(`${cat}/${name}`);
  }

  if (dry) {
    console.log(`[dry] ${added.length} a importar, ${skipped.length} ya existían`);
    for (const a of added) console.log(`  + ${a.category}/${a.name}`);
    return;
  }

  // Releemos justo antes de escribir. El snapshot inicial puede tener varios
  // minutos (procesar cada imagen con sharp tarda) y este script corre en otro
  // proceso que el dev server, así que no comparte su mutex: si mientras tanto
  // alguien agregó o borró un fondo desde la app, escribir el snapshot viejo lo
  // perdería en silencio.
  const fresh = await readLibrary();
  const freshKeys = new Set(fresh.map((b) => `${b.category}/${b.name}`));
  const merged = added.filter((a) => !freshKeys.has(`${a.category}/${a.name}`));

  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ backgrounds: [...fresh, ...merged] }, null, 2), "utf-8");
  await rename(tmp, DATA_FILE);

  const byCategory = merged.reduce((acc, a) => {
    acc[a.category] = (acc[a.category] || 0) + 1;
    return acc;
  }, {});
  const alreadyThere = skipped.length + (added.length - merged.length);
  console.log(`Importados ${merged.length} fondos (${alreadyThere} ya existían):`);
  for (const [cat, count] of Object.entries(byCategory)) console.log(`  ${cat}: ${count}`);
  console.log(`Biblioteca: ${fresh.length + merged.length} fondos en total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
