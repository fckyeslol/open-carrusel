#!/usr/bin/env node
// Empaca carruseles EDITABLES en un "handoff" versionado en git, para que las
// diseñadoras los reciban con `git pull` (npm run abrir) y los importen a su
// data/ local (ver import-handoff.mjs, corre solo al abrir).
//
// data/ y public/uploads/ están gitignorados, así que los editables no viajan
// por sí solos: este script copia los carruseles seleccionados + las imágenes
// de uploads que referencian (referentes de IG y assets embebidos en el HTML)
// a 30x/handoff/<pack>/, que SÍ se commitea.
//
// Uso:
//   node scripts/export-handoff.mjs <pack> --tag avatar:guillermo
//   node scripts/export-handoff.mjs <pack> <idPrefix> [idPrefix...]

import { readFile, writeFile, mkdir, copyFile, stat } from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const CAROUSELS = path.join(ROOT, "data", "carousels.json");
const UPLOADS = path.join(ROOT, "public", "uploads");
const HANDOFF_ROOT = path.join(ROOT, "30x", "handoff");

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

const [pack, ...rest] = process.argv.slice(2);
if (!pack) fail("Uso: node scripts/export-handoff.mjs <pack> (--tag <tag> | <idPrefix>...)");

let selector;
if (rest[0] === "--tag") {
  const tag = rest[1];
  if (!tag) fail("--tag requiere un valor (ej: avatar:guillermo)");
  selector = (c) => (c.tags || []).includes(tag);
} else if (rest.length > 0) {
  selector = (c) => rest.some((p) => c.id.startsWith(p));
} else {
  fail("Indicá --tag <tag> o al menos un idPrefix");
}

const data = JSON.parse(await readFile(CAROUSELS, "utf-8"));
const picked = (data.carousels || []).filter(selector);
if (picked.length === 0) fail("Ningún carrusel coincide con la selección");

// Archivos de /uploads/ que el pack necesita: los referentes adjuntos + cualquier
// asset embebido en el HTML de las láminas (src, url(), etc.).
const assets = new Set();
for (const c of picked) {
  for (const r of c.referenceImages || []) {
    if (r.url?.startsWith("/uploads/")) assets.add(r.url.slice("/uploads/".length));
  }
  for (const s of c.slides || []) {
    for (const m of (s.html || "").matchAll(/\/uploads\/([^"'\s)?#]+)/g)) assets.add(m[1]);
  }
}

const packDir = path.join(HANDOFF_ROOT, pack);
const packUploads = path.join(packDir, "uploads");
await mkdir(packUploads, { recursive: true });

let copied = 0, missing = [], bytes = 0;
for (const name of assets) {
  const src = path.join(UPLOADS, name);
  const dest = path.join(packUploads, name); // puede incluir subdirs (uploads/generated/…)
  try {
    const st = await stat(src);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
    bytes += st.size;
    copied++;
  } catch {
    missing.push(name);
  }
}

await writeFile(
  path.join(packDir, "carousels.json"),
  JSON.stringify({ carousels: picked }, null, 2),
  "utf-8"
);

console.log(`✅ Pack "${pack}": ${picked.length} carruseles, ${copied} archivos de uploads (${(bytes / 1048576).toFixed(1)}MB)`);
for (const c of picked) console.log(`   • ${c.id.slice(0, 8)}  ${c.name}`);
if (missing.length) {
  console.log(`⚠️  ${missing.length} archivo(s) referenciados no encontrados en public/uploads:`);
  missing.forEach((m) => console.log("   - " + m));
}
console.log(`\nCommiteá 30x/handoff/${pack}/ y las diseñadoras lo reciben con "npm run abrir".`);
