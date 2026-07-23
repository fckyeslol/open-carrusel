#!/usr/bin/env node
// Importa los packs de handoff (30x/handoff/*) al data/ local: carruseles
// editables que Mateo empacó con export-handoff.mjs y llegaron por git pull.
//
// Corre solo en cada `npm run abrir` (ver launch.mjs), igual que los avatares.
// Es IDEMPOTENTE y NUNCA pisa trabajo local: un carrusel cuyo id ya existe en
// data/carousels.json se salta (aunque el pack traiga otra versión) — si la
// diseñadora ya lo editó, su versión manda. Los archivos de uploads solo se
// copian si no existen.
//
// Uso: node scripts/import-handoff.mjs

import { readFile, writeFile, mkdir, copyFile, readdir, rename, access } from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const HANDOFF_ROOT = path.join(ROOT, "30x", "handoff");
const DATA_DIR = path.join(ROOT, "data");
const CAROUSELS = path.join(DATA_DIR, "carousels.json");
const UPLOADS = path.join(ROOT, "public", "uploads");

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let packs = [];
try {
  packs = (await readdir(HANDOFF_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
} catch {
  process.exit(0); // sin carpeta de handoff: no hay nada que importar
}
if (packs.length === 0) process.exit(0);

// Estado local (fallback vacío SOLO si el archivo no existe; si está corrupto,
// abortamos sin escribir para no pisar datos vivos).
let local = { carousels: [] };
if (await exists(CAROUSELS)) {
  try {
    local = JSON.parse(await readFile(CAROUSELS, "utf-8"));
  } catch (e) {
    console.error("⚠️  data/carousels.json ilegible — no importo handoffs:", e.message);
    process.exit(1);
  }
}
const known = new Set((local.carousels || []).map((c) => c.id));

let added = 0, skipped = 0, files = 0;
await mkdir(UPLOADS, { recursive: true });

for (const pack of packs) {
  const packDir = path.join(HANDOFF_ROOT, pack);
  let packData;
  try {
    packData = JSON.parse(await readFile(path.join(packDir, "carousels.json"), "utf-8"));
  } catch {
    continue; // pack sin carousels.json (o roto): ignorar
  }

  // Uploads del pack → public/uploads (solo los que faltan; respeta subdirs
  // como uploads/generated/…).
  const packUploads = path.join(packDir, "uploads");
  if (await exists(packUploads)) {
    for (const e of await readdir(packUploads, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const rel = path.relative(packUploads, path.join(e.parentPath ?? e.path, e.name));
      const dest = path.join(UPLOADS, rel);
      if (!(await exists(dest))) {
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(path.join(packUploads, rel), dest);
        files++;
      }
    }
  }

  for (const c of packData.carousels || []) {
    if (known.has(c.id)) {
      skipped++;
      continue; // ya existe (posiblemente editado localmente): NO pisar
    }
    // absPath de los referentes apunta a la máquina de origen: reescribir al local.
    const refs = (c.referenceImages || []).map((r) => ({
      ...r,
      absPath: r.url?.startsWith("/uploads/")
        ? path.join(UPLOADS, r.url.slice("/uploads/".length))
        : r.absPath,
    }));
    local.carousels.push({ ...c, referenceImages: refs });
    known.add(c.id);
    added++;
  }
}

if (added > 0) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = CAROUSELS + ".handoff.tmp";
  await writeFile(tmp, JSON.stringify(local, null, 2), "utf-8");
  await rename(tmp, CAROUSELS);
}

if (added || files) {
  console.log(`📦 Handoff: ${added} carrusel(es) importados, ${files} archivo(s) de uploads copiados${skipped ? `, ${skipped} ya existentes (intactos)` : ""}.`);
}
