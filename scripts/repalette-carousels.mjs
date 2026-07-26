/**
 * Re-pinta los carruseles ya creados con la paleta canónica de su avatar.
 *
 * Cuando el equipo de marca corrige un hex del ADN, los carruseles que ya están
 * guardados siguen con el hex viejo horneado en el HTML de cada lámina. Este
 * script cierra ese hueco: lee el mapa `visual_identity._paleta_hex_previos` del
 * adn.json (viejo → canónico) y reemplaza esos hex en las láminas del avatar.
 *
 * NO regenera el diseño: no toca layout, copy ni estructura. Cambia solo los hex
 * de identidad, que es exactamente lo que la corrección de paleta invalidó. El
 * update pasa por la API, así que cada lámina queda con su versión previa en el
 * historial y se puede deshacer desde la UI.
 *
 * Uso (requiere el dev server levantado, igual que slide-check.mjs):
 *   node scripts/repalette-carousels.mjs                    # dry-run: solo reporta
 *   node scripts/repalette-carousels.mjs --apply            # escribe
 *   node scripts/repalette-carousels.mjs --apply --avatar liz
 *
 * Los neutros puros (#000000, #ffffff) se reportan pero NO se reemplazan salvo
 * con --incluir-neutros: en una lámina el negro suele ser un scrim sobre foto o
 * una sombra, no el color oscuro de la marca, así que cambiarlo a ciegas rompe
 * más de lo que arregla. Revisalos a mano.
 */
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AVATARS_DIR = path.join(ROOT, "30x", "avatars");
const BASE = process.env.OC_BASE_URL || "http://localhost:3000";

const aplicar = process.argv.includes("--apply");
const incluirNeutros = process.argv.includes("--incluir-neutros");
const soloAvatar = (() => {
  const i = process.argv.indexOf("--avatar");
  return i >= 0 ? process.argv[i + 1] : null;
})();

/** Modo hosteado: el server exige X-Internal-Token en cada request. */
const CABECERAS = process.env.INTERNAL_API_TOKEN
  ? { "X-Internal-Token": process.env.INTERNAL_API_TOKEN }
  : {};

const NEUTROS = new Set(["#000000", "#ffffff"]);

async function pedirJson(url, opciones = {}) {
  const res = await fetch(url, {
    ...opciones,
    headers: { ...CABECERAS, ...(opciones.headers || {}) },
  });
  const texto = await res.text();
  let cuerpo;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    throw new Error(`Respuesta no-JSON de ${url} (${res.status}): ${texto.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(cuerpo.error || `HTTP ${res.status}`);
  return cuerpo;
}

/** Lee los mapas viejo→canónico de cada avatar que tuvo una corrección de paleta. */
async function leerMigraciones() {
  const migraciones = new Map();
  const entradas = await readdir(AVATARS_DIR, { withFileTypes: true });
  for (const e of entradas) {
    if (!e.isDirectory() || e.name.startsWith("_")) continue;
    const adnPath = path.join(AVATARS_DIR, e.name, "adn.json");
    if (!existsSync(adnPath)) continue;
    let adn;
    try {
      adn = JSON.parse(await readFile(adnPath, "utf-8"));
    } catch {
      continue;
    }
    const previos = adn.visual_identity?._paleta_hex_previos;
    if (previos && Object.keys(previos).length) migraciones.set(e.name, previos);
  }
  return migraciones;
}

/**
 * Expande cada par viejo→canónico a las formas en que un hex aparece en el HTML:
 * `#RRGGBB` (en ambas cajas) y `rgb(r,g,b` / `rgba(r,g,b` con y sin espacios.
 * El `rgba(` se corta antes del alpha a propósito, para no depender de él.
 */
function expandir(mapa) {
  const pares = [];
  for (const [viejo, nuevo] of Object.entries(mapa)) {
    const rgb = (hex) => {
      const h = hex.replace("#", "");
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    };
    const [ra, ga, ba] = rgb(viejo);
    const [rb, gb, bb] = rgb(nuevo);
    pares.push(
      { de: viejo.toUpperCase(), a: nuevo.toUpperCase(), neutro: NEUTROS.has(viejo.toLowerCase()) },
      { de: viejo.toLowerCase(), a: nuevo.toLowerCase(), neutro: NEUTROS.has(viejo.toLowerCase()) },
      { de: `${ra},${ga},${ba}`, a: `${rb},${gb},${bb}`, neutro: NEUTROS.has(viejo.toLowerCase()) },
      { de: `${ra}, ${ga}, ${ba}`, a: `${rb}, ${gb}, ${bb}`, neutro: NEUTROS.has(viejo.toLowerCase()) },
    );
  }
  return pares;
}

function repintar(html, pares) {
  let salida = html;
  const cambios = [];
  const omitidos = [];
  for (const { de, a, neutro } of pares) {
    const veces = salida.split(de).length - 1;
    if (!veces) continue;
    if (neutro && !incluirNeutros) {
      omitidos.push(`${de} ×${veces}`);
      continue;
    }
    salida = salida.split(de).join(a);
    cambios.push(`${de} → ${a} ×${veces}`);
  }
  // Las variantes de caja de un mismo hex se reportan una vez: "#000000 ×1" dos
  // veces no dice nada más que "#000000 ×1".
  return { html: salida, cambios, omitidos: [...new Set(omitidos)] };
}

const migraciones = await leerMigraciones();
if (!migraciones.size) {
  console.log("Ningún avatar declara _paleta_hex_previos: no hay nada que re-pintar.");
  process.exit(0);
}
console.log(
  `Avatares con corrección de paleta: ${[...migraciones.keys()].join(", ")}` +
    (soloAvatar ? ` (filtrando por "${soloAvatar}")` : "")
);

const carruseles = await pedirJson(`${BASE}/api/carousels`);
const lista = Array.isArray(carruseles) ? carruseles : carruseles.carousels || [];
console.log(`${lista.length} carrusel(es) guardados.\n`);

let tocados = 0;
let laminasCambiadas = 0;
const neutrosPendientes = [];

for (const carrusel of lista) {
  const slug =
    carrusel.avatarSlug || String(carrusel.stylePresetId || "").replace(/^avatar-/, "");
  const mapa = migraciones.get(slug);
  if (!mapa) continue;
  if (soloAvatar && slug !== soloAvatar) continue;
  const pares = expandir(mapa);

  const detalle = [];
  for (const lamina of carrusel.slides || []) {
    const { html, cambios, omitidos } = repintar(lamina.html || "", pares);
    if (omitidos.length)
      neutrosPendientes.push(`  ${slug} · ${carrusel.name} · lámina ${lamina.order + 1}: ${omitidos.join(", ")}`);
    if (!cambios.length) continue;
    detalle.push(`  lámina ${lamina.order + 1} (${lamina.id}): ${cambios.join(", ")}`);
    laminasCambiadas++;
    if (aplicar) {
      await pedirJson(`${BASE}/api/carousels/${carrusel.id}/slides/${lamina.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html }),
      });
    }
  }
  if (detalle.length) {
    tocados++;
    console.log(`${slug} · "${carrusel.name}" (${carrusel.id})`);
    console.log(detalle.join("\n"));
  }
}

if (neutrosPendientes.length) {
  console.log(`\nNeutros NO reemplazados (revisar a mano, o correr con --incluir-neutros):`);
  console.log(neutrosPendientes.join("\n"));
}

console.log(
  `\n${aplicar ? "Aplicado" : "Dry-run"}: ${laminasCambiadas} lámina(s) en ${tocados} carrusel(es).` +
    (aplicar
      ? " Cada lámina guardó su versión previa (deshacer desde la UI)."
      : " Volvé a correr con --apply para escribir.")
);
