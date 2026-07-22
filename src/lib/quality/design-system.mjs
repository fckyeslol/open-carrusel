/**
 * Puente entre el ADN del avatar y el detector.
 *
 * Sin esto, el detector aplica gusto genérico: marca Instrument Serif como fuente
 * trillada y el #F6F5F0 como "cream slop", cuando ambos son el brand kit de 30x.
 * Con esto, la pregunta cambia de "¿esta fuente es buena?" a "¿esta lámina se
 * desvió de la identidad del avatar?", que es la que realmente importa.
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeDesignSystem } from './engine/design-system.mjs';

const RAIZ = process.cwd();

/**
 * Mezclas permitidas de cada color de marca. Cubre los tintes legítimos que una
 * lámina usa para superficies, divisores y sombras sin abrir tanto la mano que la
 * regla deje de disparar.
 *
 * El 0.86 no es arbitrario: es exactamente el accentLight que
 * chat-system-prompt.ts inyecta en el prompt, así que el agente puede usarlo sin
 * que el detector lo contradiga.
 */
const HACIA_CLARO = [0.08, 0.16, 0.32, 0.5, 0.7, 0.86];
const HACIA_OSCURO = [0.12, 0.25];

function parseHex(hex) {
  const limpio = String(hex || '').trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(limpio)) return null;
  return {
    r: parseInt(limpio.slice(0, 2), 16),
    g: parseInt(limpio.slice(2, 4), 16),
    b: parseInt(limpio.slice(4, 6), 16),
  };
}

function aHex({ r, g, b }) {
  const dos = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${dos(r)}${dos(g)}${dos(b)}`;
}

function mezclar(color, hacia, cantidad) {
  return aHex({
    r: color.r + (hacia.r - color.r) * cantidad,
    g: color.g + (hacia.g - color.g) * cantidad,
    b: color.b + (hacia.b - color.b) * cantidad,
  });
}

/** Rampa tonal de un color: sus tintes hacia blanco y sus sombras hacia negro. */
function construirRampa(hex) {
  const base = parseHex(hex);
  if (!base) return [];
  const blanco = { r: 255, g: 255, b: 255 };
  const negro = { r: 0, g: 0, b: 0 };
  return [
    ...HACIA_CLARO.map((c) => mezclar(base, blanco, c)),
    ...HACIA_OSCURO.map((c) => mezclar(base, negro, c)),
  ];
}

/**
 * Extrae fuentes y colores de la lámina de referencia del avatar.
 *
 * El exampleSlideHtml del preset no es un ejemplo cualquiera: import-avatars.mjs
 * lo elige de public/30x-slides/<slug>/ y chat-system-prompt.ts lo inyecta como
 * "ADN del avatar". Es la implementación de referencia de la identidad.
 *
 * Sin esto el detector marca la plantilla validada de Cinthya por usar Inter en
 * la línea de rol, cuando su adn.json solo declara Instrument Serif. La plantilla
 * no está mal: el adn.json está incompleto. Absorbiéndola, "deriva" pasa a
 * significar que la lámina se apartó tanto de lo declarado como de la referencia,
 * que es una señal mucho más confiable.
 */
function leerReferencia(exampleSlideHtml) {
  const html = String(exampleSlideHtml || '');
  const fuentes = new Set();
  const colores = new Set();

  // Mismo patrón que extractFontFamilies() de slide-html.ts. Debe coincidir: si
  // acá se extrae menos, el design system queda incompleto y el detector marca
  // como deriva una fuente que la referencia sí declara.
  const genericas = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
  for (const m of html.matchAll(/font-family:\s*((?:"[^"]*"|'[^']*'|[^;}"'\n])+)/g)) {
    for (const parte of m[1].split(',')) {
      const nombre = parte.trim().replace(/['"]/g, '');
      if (nombre && !genericas.has(nombre.toLowerCase())) fuentes.add(nombre);
    }
  }
  for (const m of html.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    colores.add(m[0].toLowerCase());
  }

  return { fuentes: [...fuentes], colores: [...colores] };
}

/** Lee el adn.json del avatar, que tiene la paleta canónica con nombres y roles. */
function leerAdn(avatarSlug) {
  if (!avatarSlug) return null;
  const ruta = path.join(RAIZ, '30x', 'avatars', avatarSlug, 'adn.json');
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Lee un preset de data/style-presets.json por id.
 *
 * El archivo guarda { presets: [...] }; se tolera también un array plano por si
 * el formato cambia.
 */
export function leerPreset(presetId) {
  if (!presetId) return null;
  try {
    const crudo = JSON.parse(
      fs.readFileSync(path.join(RAIZ, 'data', 'style-presets.json'), 'utf-8'),
    );
    const presets = Array.isArray(crudo) ? crudo : crudo?.presets || [];
    return presets.find((p) => p.id === presetId) || null;
  } catch {
    return null;
  }
}

/**
 * Construye el design system que consume el detector, desde el preset del avatar
 * (+ su adn.json cuando existe, que tiene la paleta con nombres reales).
 *
 * Devuelve `null` si no hay preset: sin ADN el perfil deja encendidas las reglas
 * de gusto genérico, que son la única red que queda.
 *
 * @param {object|null} preset  StylePreset de data/style-presets.json
 * @returns {{ designSystem: object, resumen: object }|null}
 */
export function construirDesignSystem(preset) {
  if (!preset?.brand) return null;

  const { colors = {}, fonts = {}, customFonts = [] } = preset.brand;
  const adn = leerAdn(preset.avatarSlug);
  const referencia = leerReferencia(preset.exampleSlideHtml);

  // La paleta del ADN manda: trae los hex canónicos con nombre y rol. El preset
  // solo guarda los 5 roles que import-avatars.mjs derivó por luminancia.
  const paletaAdn = adn?.visual_identity?.paleta || [];
  const coloresMarca = {};
  for (const [rol, hex] of Object.entries(colors)) {
    if (typeof hex === 'string') coloresMarca[rol] = hex;
  }
  for (const entrada of paletaAdn) {
    if (entrada?.hex) {
      const nombre = String(entrada.nombre || entrada.rol || 'adn')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      coloresMarca[`adn-${nombre}`] = entrada.hex;
    }
  }

  // Lo que la lámina de referencia establece cuenta como sistema declarado.
  referencia.colores.forEach((hex, i) => {
    coloresMarca[`ref-${i}`] = hex;
  });

  // Blanco y negro puros son universalmente legítimos en una lámina: texto sobre
  // foto, fondos a sangre. Marcarlos como deriva sería ruido garantizado.
  coloresMarca.blanco = '#ffffff';
  coloresMarca.negro = '#000000';

  const colorMeta = {};
  for (const [rol, hex] of Object.entries(coloresMarca)) {
    const rampa = construirRampa(hex);
    if (rampa.length) colorMeta[rol] = { canonical: hex, tonalRamp: rampa };
  }

  // Tipografía: las del preset más la familia declarada en el ADN y las custom.
  const familias = new Set(
    [
      fonts.heading,
      fonts.body,
      adn?.visual_identity?.tipografia?.familia,
      ...referencia.fuentes,
      ...customFonts.map((f) => f?.family || f?.name),
    ].filter((f) => typeof f === 'string' && f.trim()),
  );

  const typography = {};
  let i = 0;
  for (const familia of familias) {
    typography[`rol-${i++}`] = { fontFamily: familia };
  }

  const designSystem = normalizeDesignSystem({
    frontmatter: { colors: coloresMarca, typography },
    sidecar: { extensions: { colorMeta } },
    sourcePath: `preset:${preset.id}`,
  });

  return {
    designSystem,
    resumen: {
      preset: preset.id,
      avatar: preset.avatarSlug || null,
      // De dónde salió cada permiso, para poder auditar un hallazgo discutible.
      origenes: {
        adn: adn ? `30x/avatars/${preset.avatarSlug}/adn.json` : null,
        referencia: referencia.fuentes.length || referencia.colores.length
          ? `exampleSlideHtml del preset (${referencia.fuentes.length} fuente(s), ` +
            `${referencia.colores.length} color(es))`
          : null,
      },
      fuentes: [...familias],
      colores: Object.entries(coloresMarca).map(([rol, hex]) => `${rol}:${hex}`),
      coloresPermitidos: designSystem.allowedColorKeys.size,
    },
  };
}
