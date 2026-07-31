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
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";

// fileURLToPath decodifica el file:// URL correctamente. NO usar
// `new URL(import.meta.url).pathname`: eso deja la ruta codificada en URL, así
// que un usuario de Windows/Mac con espacio o tilde en el nombre (C:\Users\Maria
// Jose, /Users/andré) queda con "Maria%20Jose" → existsSync falla → el sembrado
// de avatares revienta en silencio y el selector "Elegí un avatar" queda vacío.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
 * Clasifica una entrada de paleta por el `rol` que declara el manual de ADN.
 * Devuelve "background" | "text" | "accent" | "complement" | null (sin rol útil).
 *
 * Los roles del manual vienen en prosa ("complementario base 30x (fondo claro)",
 * "principal (acento)", "oscuro / textos"), así que se leen por palabras clave.
 * El orden de los ifs es el que resuelve las frases mixtas: "complementario base
 * 30x (fondo claro)" es FONDO, no complementario, y "principal / textos y fondos
 * oscuros" es TEXTO, no acento.
 */
function clasificarRol(rol) {
  const r = String(rol || "").toLowerCase();
  if (!r) return null;
  if (/fondo claro|base\b|\bbase\/|fondo\/base/.test(r)) return "background";
  if (/texto/.test(r)) return "text";
  if (/acento|principal/.test(r)) return "accent";
  if (/complementario|superficie/.test(r)) return "complement";
  return null;
}

/**
 * Deriva los 5 roles de color de Open Carrusel desde la paleta del ADN.
 *
 * Manda el `rol` que declara el manual: es una decisión de marca, no algo que se
 * pueda adivinar. Sin esto la heurística de luminancia/saturación le erraba al
 * acento de varios avatares (a Alejandra le daba el azul en vez del cian; a
 * Andrés el naranja del degradé en vez de la lima) y dejaba el `secondary`
 * duplicando el acento, así que el complementario del avatar no llegaba nunca al
 * prompt.
 *
 * Cuando una entrada no declara rol (o el ADN no trae paleta con roles) cae a la
 * heurística vieja: background = el más claro; primary(texto) = el más oscuro;
 * secondary = el segundo más oscuro; accent = el más saturado de los intermedios.
 */
function deriveColors(paleta) {
  const entradas = (paleta || []).filter((p) => p?.hex && parseHex(p.hex));
  const hexes = entradas.map((p) => norm(p.hex));
  if (hexes.length === 0) {
    return { primary: "#2A2320", secondary: "#5a4f48", accent: "#E5ACBF", background: "#F6F5F0", surface: "#eceae3" };
  }

  // Primer hex declarado para cada rol del manual (el manual los lista en orden).
  const porRol = {};
  for (const p of entradas) {
    const rol = clasificarRol(p.rol);
    if (rol && !porRol[rol]) porRol[rol] = norm(p.hex);
  }

  const byLum = [...hexes].sort((a, b) => luminance(a) - luminance(b)); // oscuro→claro
  const background = porRol.background || byLum[byLum.length - 1];
  const primary = porRol.text || byLum[0];
  // acento: el más saturado que no sea el fondo ni el texto principal
  const candidatos = hexes.filter((h) => h !== background && h !== primary);
  const accent =
    porRol.accent ||
    (candidatos.length ? candidatos : hexes).slice().sort((a, b) => saturation(b) - saturation(a))[0] ||
    "#E5ACBF";
  const secondary =
    porRol.complement ||
    // sin complementario declarado: el segundo más oscuro, evitando repetir el acento
    byLum.slice(1).find((h) => h !== accent && h !== background) ||
    (byLum.length > 2 ? byLum[1] : mix(primary, 0.25));
  const surface = mix(background, -0.04);
  return { primary, secondary, accent, background, surface };
}

// ── assets por avatar ─────────────────────────────────────────────────────────
const ASSET_KINDS = ["logo", "fotos", "fondos", "referencias"];
const ASSET_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

/**
 * Raíz de los ARCHIVOS de assets. Por defecto comparten carpeta con el ADN
 * (30x/avatars/<slug>/assets/), como en local/compose. En Cloud Run el ADN va
 * horneado en la imagen pero los assets que sube la UI deben persistir entre
 * deploys, así que AVATAR_ASSETS_DIR los apunta al bucket `uploads` montado
 * (/app/public/uploads/avatar-assets). Las URLs servidas no cambian.
 */
function assetsRootFor(avatarsDir) {
  return process.env.AVATAR_ASSETS_DIR
    ? path.resolve(process.env.AVATAR_ASSETS_DIR)
    : avatarsDir;
}

/**
 * Lee la carpeta de assets del avatar (<root>/<slug>/assets/<tipo>/) y
 * devuelve las URLs con que la app los sirve (/avatar-assets/<slug>/...).
 * La carpeta es la fuente de verdad: soltar un archivo ahí basta para que el
 * próximo arranque lo detecte — cero configuración.
 */
async function scanAssets(avatarsDir, slug) {
  const root = assetsRootFor(avatarsDir);
  const assets = { logo: [], fotos: [], fondos: [], referencias: [] };
  for (const kind of ASSET_KINDS) {
    const dir = path.join(root, slug, "assets", kind);
    if (!existsSync(dir)) continue;
    try {
      const files = (await readdir(dir))
        .filter((f) => ASSET_EXTS.has(path.extname(f).toLowerCase()))
        .sort();
      assets[kind] = files.map((f) => `/avatar-assets/${slug}/${kind}/${encodeURIComponent(f)}`);
    } catch {
      // carpeta ilegible → se trata como vacía
    }
  }
  return assets;
}

function buildAssetRules(assets) {
  const lines = [];
  const total = ASSET_KINDS.reduce((n, k) => n + assets[k].length, 0);
  if (total === 0) return "";
  lines.push("ASSETS DE MARCA del avatar (usar SOLO estos archivos, referenciarlos por su URL exacta; no inventar rutas):");
  if (assets.logo.length) lines.push(`- Logo/firma: ${assets.logo.join(", ")}`);
  if (assets.fotos.length)
    lines.push(`- Fotos del mentor (para FONDO 3 - FOTO MENTOR): ${assets.fotos.join(", ")}`);
  if (assets.fondos.length)
    lines.push(`- Fondos de marca (FONDO 1/2/4): ${assets.fondos.join(", ")}`);
  if (assets.referencias.length)
    lines.push(
      `- Referencias de carruseles ya publicados (calibrar estilo, NO incrustar en láminas): ${assets.referencias.join(", ")}`
    );
  return lines.join("\n");
}

/**
 * Familia de CUERPO del avatar.
 *
 * Casi todos los avengers mandan una sola familia por ADN y la usan en titular y
 * cuerpo (decisión de marca, no descuido — ver slide-profile.mjs → 'single-font').
 * Cora Bilbao es la excepción: Playfair Display en titulares y Poppins en cuerpo,
 * así que el ADN puede declarar `tipografia.familia_cuerpo` y esto la respeta.
 */
function bodyFamily(tipografia) {
  const cuerpo = tipografia?.familia_cuerpo;
  return (typeof cuerpo === "string" && cuerpo.trim()) || tipografia?.familia || null;
}

/** Línea de tipografía del prompt: una familia, o el par titular/cuerpo si hay dos. */
function buildTypographyRule(tipografia) {
  const titular = tipografia?.familia;
  if (!titular) return "";
  const cuerpo = bodyFamily(tipografia);
  const base =
    cuerpo && cuerpo !== titular
      ? `Tipografía de marca: DOS familias, y no se cruzan — "${titular}" SOLO para titulares y remates, ` +
        `"${cuerpo}" para cuerpo, kickers, datos, fuentes y pies. Nunca al revés.`
      : `Tipografía de marca: ${titular} (única familia del avatar: titulares y cuerpo).`;
  return tipografia?.nota ? `${base} ${tipografia.nota}` : base;
}

/**
 * Paleta canónica en el prompt, con hex, nombre y rol tal como los declara el
 * manual — incluidos los colores de degradé, que no entran en los 5 roles que
 * deriveColors() le pasa a brand.colors y que sin esto el agente no vería nunca.
 *
 * Cierra con el reparto 40/60: el hueso es el denominador común de las 8 marcas.
 */
function buildPaletteRule(vi) {
  const paleta = (vi?.paleta || []).filter((p) => p?.hex);
  if (!paleta.length) return "";
  const items = paleta.map((p) => {
    const etiqueta = [p.nombre, p.rol].filter(Boolean).join(" — ");
    return etiqueta ? `${p.hex} (${etiqueta})` : p.hex;
  });
  const lineas = [
    `Paleta canónica del avatar: ${items.join(" · ")}. ` +
      "Los tintes y sombras de estos hex son válidos; un color que no salga de esta paleta, no.",
  ];
  if (vi._paleta_reparto) lineas.push(vi._paleta_reparto);
  if (vi._paleta_nota) lineas.push(`Nota de paleta: ${vi._paleta_nota}`);
  return lineas.join("\n");
}

function buildDesignRules(adn, assets) {
  const vi = adn.visual_identity || {};
  const voice = adn.voice_dna || {};
  const brand = adn.brand || {};
  const lines = [];
  lines.push(`Avatar: ${adn.avatar?.name || ""} (30X Executive Education).`);
  if (vi.titulo_rol) lines.push(`Posicionamiento / kicker: ${vi.titulo_rol}.`);
  if (vi.firma) lines.push(`Firma de cierre (última lámina): "${vi.firma}".`);
  if (brand.cta_default) lines.push(`CTA por defecto: "${brand.cta_default}".`);
  const tipografia = buildTypographyRule(vi.tipografia);
  if (tipografia) lines.push(tipografia);
  const paleta = buildPaletteRule(vi);
  if (paleta) lines.push(paleta);
  if (Array.isArray(vi.fondos) && vi.fondos.length) lines.push(`Tratamientos de fondo disponibles: ${vi.fondos.join(", ")}.`);
  // ── Voz (fuente: sección Avatares de Prewave, volcada al adn.json) ───────────
  // El acento se declara SIEMPRE, también cuando es neutro. Callarlo NO produce
  // una voz neutra: sin instrucción el modelo copia el dialecto de lo que tiene
  // alrededor, y como los avatares de acento marcado del sistema son caleños,
  // todos los demás terminaban saliendo caleños. El neutro tiene que ser una
  // orden explícita, no la ausencia de una.
  const acento = String(voice.acento || "").trim();
  lines.push(
    acento && acento !== "neutro"
      ? `Acento / dialecto: ${acento} (regla dura: mantenerlo en toda la copy).`
      : "Acento / dialecto: español latinoamericano neutro (regla dura). Nada de " +
        "regionalismos ni marcas dialectales — ni caleñas, ni paisas, ni bogotanas, " +
        "ni rioplatenses. Que otro avatar del sistema tenga acento marcado no lo " +
        "contagia a este."
  );
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
  const assetRules = assets ? buildAssetRules(assets) : "";
  if (assetRules) lines.push(assetRules);
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

    const bodyFont = bodyFamily(vi.tipografia) || family;
    const colors = deriveColors(paleta);
    const name = adn.avatar?.name || slug;
    const exampleSlideHtml = await readExampleHtml(slug);
    const programMatch = adn.avatar?.prewave_program_match || [];
    const assets = await scanAssets(avatarsDir, slug);
    const assetCount = ASSET_KINDS.reduce((n, k) => n + assets[k].length, 0);

    presets.push({
      id: `avatar-${slug}`,
      name: `30X — ${name}`,
      description: vi.titulo_rol || `Marca personal de ${name}`,
      brand: {
        name: `30X — ${name}`,
        colors,
        fonts: { heading: family, body: bodyFont },
        customFonts: [],
        logoPath: assets.logo[0] || null,
        styleKeywords: buildKeywords(adn),
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      designRules: buildDesignRules(adn, assets),
      exampleSlideHtml,
      aspectRatio: ASPECT,
      tags: ["30x", `avatar:${slug}`, ...programMatch.map((p) => `match:${p}`)],
      createdAt: nowIso,
      // metadata 30x para el ingest (no rompe el tipo StylePreset; campo extra)
      avatarSlug: slug,
      avatarStatus: adn.status || "draft",
    });
    const fuentes = bodyFont === family ? family : `${family} + ${bodyFont}`;
    say(
      `  ✓ ${slug.padEnd(16)} ${fuentes.padEnd(32)} bg ${colors.background} · text ${colors.primary} · accent ${colors.accent} · 2º ${colors.secondary}` +
        (exampleSlideHtml ? "  [+formato]" : "  [sin formato aún]") +
        (assetCount ? `  [${assetCount} assets]` : "  [sin assets]")
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
