/**
 * import-avatars.mjs — Convierte los ADN packs de 30x (avatars/<slug>/adn.json del
 * repo 30x-carousel-pipeline) en StylePresets de Open Carrusel.
 *
 * Cada avatar (avenger) pasa a ser un preset: sus colores, su tipografía, su voz y
 * sus reglas de diseño. Reemplaza el viejo "lienzo de bloques vacíos" de Canva.
 *
 * Uso:
 *   node scripts/import-avatars.mjs                 # lee la ruta por defecto
 *   node scripts/import-avatars.mjs <dir-avatars>   # ruta a avatars/ del pipeline
 *
 * Idempotente: upsert por id determinista `avatar-<slug>`. Re-correrlo actualiza.
 */
import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { pathToFileURL } from "url";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const DATA_DIR = path.join(ROOT, "data");
const SLIDES_DIR = path.join(ROOT, "public", "30x-slides");

// Fuente por defecto: los ADN de los avatares viven versionados en el repo
// (30x/avatars/<slug>/adn.json). Así cualquier diseñadora que clona el repo
// tiene los avatares sin depender del pipeline privado de Mateo. Se puede
// sobrescribir pasando otra ruta como primer argumento del CLI.
const DEFAULT_AVATARS_DIR = path.join(ROOT, "30x", "avatars");

const ASPECT = "4:5";

// ── helpers de color ──────────────────────────────────────────────────────────
function parseHex(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function luminance(hex) {
  const c = parseHex(hex);
  if (!c) return 0.5;
  // luma perceptual
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}
function saturation(hex) {
  const c = parseHex(hex);
  if (!c) return 0;
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}
function norm(hex) {
  const c = parseHex(hex);
  if (!c) return hex;
  const to = (n) => n.toString(16).padStart(2, "0");
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}
function mix(hex, amt) {
  // amt>0 aclara hacia blanco, amt<0 oscurece hacia negro
  const c = parseHex(hex);
  if (!c) return hex;
  const t = amt >= 0 ? 255 : 0;
  const a = Math.abs(amt);
  const f = (n) => Math.round(n + (t - n) * a);
  const to = (n) => n.toString(16).padStart(2, "0");
  return `#${to(f(c.r))}${to(f(c.g))}${to(f(c.b))}`;
}

/**
 * Deriva los 5 roles de color de Open Carrusel desde la paleta del ADN.
 * background = el más claro; primary(texto) = el más oscuro; accent = el más
 * saturado de los intermedios; secondary = el segundo más oscuro; surface = un
 * matiz del fondo.
 */
function deriveColors(paleta) {
  const hexes = (paleta || []).map((p) => p.hex).filter(Boolean).map(norm);
  if (hexes.length === 0) {
    return { primary: "#2A2320", secondary: "#5a4f48", accent: "#E5ACBF", background: "#F6F5F0", surface: "#eceae3" };
  }
  const byLum = [...hexes].sort((a, b) => luminance(a) - luminance(b)); // oscuro→claro
  const background = byLum[byLum.length - 1];
  const primary = byLum[0];
  const secondary = byLum.length > 2 ? byLum[1] : mix(primary, 0.25);
  // acento: el más saturado que no sea el fondo ni el texto principal
  const candidates = hexes.filter((h) => h !== background && h !== primary);
  const accent =
    (candidates.length ? candidates : hexes).slice().sort((a, b) => saturation(b) - saturation(a))[0] ||
    "#E5ACBF";
  const surface = mix(background, -0.04);
  return { primary, secondary, accent, background, surface };
}

function buildDesignRules(adn) {
  const vi = adn.visual_identity || {};
  const voice = adn.voice_dna || {};
  const brand = adn.brand || {};
  const lines = [];
  lines.push(`Avatar: ${adn.avatar?.name || ""} (30X Executive Education).`);
  if (vi.titulo_rol) lines.push(`Posicionamiento / kicker: ${vi.titulo_rol}.`);
  if (vi.firma) lines.push(`Firma de cierre (última lámina): "${vi.firma}".`);
  if (brand.cta_default) lines.push(`CTA por defecto: "${brand.cta_default}".`);
  if (vi.tipografia?.familia) lines.push(`Tipografía de marca: ${vi.tipografia.familia} (usar para titulares).`);
  if (Array.isArray(vi.fondos) && vi.fondos.length) lines.push(`Tratamientos de fondo disponibles: ${vi.fondos.join(", ")}.`);
  // ── Voz (fuente: sección Avatares de Prewave, volcada al adn.json) ───────────
  if (voice.acento && voice.acento !== "neutro")
    lines.push(`Acento / dialecto: ${voice.acento} (regla dura: mantenerlo en toda la copy).`);
  if (Array.isArray(voice.tono) && voice.tono.length) lines.push(`Rasgos de tono: ${voice.tono.join(", ")}.`);
  if (voice.tono_descripcion) lines.push(`Tono de voz: ${voice.tono_descripcion}`);
  if (voice.estilo_comunicacion) lines.push(`Estilo de comunicación: ${voice.estilo_comunicacion}`);
  if (Array.isArray(voice.temas_centrales) && voice.temas_centrales.length)
    lines.push(`Temas centrales del avatar: ${voice.temas_centrales.join(", ")}.`);
  if (Array.isArray(voice.frases_muestra) && voice.frases_muestra.length)
    lines.push(
      `Frases de muestra (para CALIBRAR la voz, no para copiar literal salvo que encajen con el referente): ${voice.frases_muestra.join(" | ")}`
    );
  if (voice.firma_cierre_prewave)
    lines.push(`Firma hablada de Prewave (referencia de voz, adaptar al carrusel): "${voice.firma_cierre_prewave}".`);
  if (Array.isArray(voice.do) && voice.do.length) lines.push(`HACER: ${voice.do.join(" | ")}.`);
  if (Array.isArray(voice.dont) && voice.dont.length) lines.push(`NO HACER: ${voice.dont.join(" | ")}.`);
  lines.push(
    "FIDELIDAD ESTRICTA: cada cifra, dato y fuente del referente sobrevive EXACTO. No inventar nada. Si el referente no lo dice, no existe."
  );
  lines.push("La ESTRUCTURA (cantidad de láminas, jerarquía, roles) sale del referente. La IDENTIDAD (fuente, paleta, voz) sale de este avatar. Nunca al revés.");
  lines.push("Nunca mezclar con la marca/voz/paleta de otro avatar.");
  return lines.join("\n");
}

async function readExampleHtml(slug) {
  const dir = path.join(SLIDES_DIR, slug);
  if (!existsSync(dir)) return "";
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".html")).sort();
    if (!files.length) return "";
    return await readFile(path.join(dir, files[0]), "utf-8");
  } catch {
    return "";
  }
}

function buildKeywords(adn) {
  const kw = new Set();
  for (const t of adn.voice_dna?.tono || []) kw.add(String(t));
  if (adn.brand?.voice) kw.add(String(adn.brand.voice));
  kw.add("30x");
  kw.add("editorial");
  return [...kw].filter(Boolean);
}

/**
 * Genera/actualiza los presets de avatar en data/style-presets.json a partir de
 * los ADN de `avatarsDir`. Idempotente (upsert por `avatar-<slug>`). Devuelve un
 * resumen `{ imported, kept, skipped }`. `quiet` silencia el log por avatar para
 * cuando la llaman setup.mjs / launch.mjs.
 */
export async function importAvatars({ avatarsDir = DEFAULT_AVATARS_DIR, quiet = false } = {}) {
  const say = (msg) => {
    if (!quiet) console.log(msg);
  };
  if (!existsSync(avatarsDir)) {
    throw new Error(
      `no existe el directorio de avatares: ${avatarsDir}\n` +
        "Pasá la ruta como argumento: node scripts/import-avatars.mjs <dir>"
    );
  }
  await mkdir(DATA_DIR, { recursive: true });

  const entries = await readdir(avatarsDir, { withFileTypes: true });
  const slugs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && e.name !== "default")
    .map((e) => e.name);

  const nowIso = new Date().toISOString();
  const presets = [];
  const skipped = [];

  for (const slug of slugs) {
    const adnPath = path.join(avatarsDir, slug, "adn.json");
    if (!existsSync(adnPath)) continue;
    let adn;
    try {
      adn = JSON.parse(await readFile(adnPath, "utf-8"));
    } catch (e) {
      skipped.push(`${slug} (adn.json inválido: ${e.message})`);
      continue;
    }
    const vi = adn.visual_identity || {};
    const family = vi.tipografia?.familia;
    const paleta = vi.paleta || [];
    if (!family || paleta.length === 0) {
      skipped.push(`${slug} (ADN incompleto: falta tipografía o paleta — status=${adn.status})`);
      continue;
    }

    const colors = deriveColors(paleta);
    const name = adn.avatar?.name || slug;
    const exampleSlideHtml = await readExampleHtml(slug);
    const programMatch = adn.avatar?.prewave_program_match || [];

    presets.push({
      id: `avatar-${slug}`,
      name: `30X — ${name}`,
      description: vi.titulo_rol || `Marca personal de ${name}`,
      brand: {
        name: `30X — ${name}`,
        colors,
        fonts: { heading: family, body: family },
        customFonts: [],
        logoPath: null,
        styleKeywords: buildKeywords(adn),
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      designRules: buildDesignRules(adn),
      exampleSlideHtml,
      aspectRatio: ASPECT,
      tags: ["30x", `avatar:${slug}`, ...programMatch.map((p) => `match:${p}`)],
      createdAt: nowIso,
      // metadata 30x para el ingest (no rompe el tipo StylePreset; campo extra)
      avatarSlug: slug,
      avatarStatus: adn.status || "draft",
    });
    say(
      `  ✓ ${slug.padEnd(16)} ${family.padEnd(20)} bg ${colors.background} · text ${colors.primary} · accent ${colors.accent}` +
        (exampleSlideHtml ? "  [+formato]" : "  [sin formato aún]")
    );
  }

  // upsert: conservar presets no-avatar existentes, reemplazar los avatar-*
  const outFile = path.join(DATA_DIR, "style-presets.json");
  let existing = { presets: [] };
  if (existsSync(outFile)) {
    try {
      existing = JSON.parse(await readFile(outFile, "utf-8"));
    } catch {
      existing = { presets: [] };
    }
  }
  const kept = (existing.presets || []).filter((p) => !String(p.id || "").startsWith("avatar-"));
  const merged = { presets: [...kept, ...presets] };
  const tmp = outFile + ".tmp";
  await writeFile(tmp, JSON.stringify(merged, null, 2), "utf-8");
  const { rename } = await import("fs/promises");
  await rename(tmp, outFile);

  say(
    `\nOK → ${path.relative(ROOT, outFile)}: ${presets.length} avatares importados, ${kept.length} presets no-avatar conservados.`
  );
  if (skipped.length) {
    say(`\nSaltados (${skipped.length}):`);
    for (const s of skipped) say(`  - ${s}`);
  }

  return { imported: presets.length, kept: kept.length, skipped };
}

// CLI: `node scripts/import-avatars.mjs [dir-avatares]`. Al importarse como
// módulo (setup.mjs / launch.mjs) este bloque no corre.
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (invokedDirectly) {
  importAvatars({ avatarsDir: process.argv[2] || DEFAULT_AVATARS_DIR }).catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
