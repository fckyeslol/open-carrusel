/**
 * Orquestador del chequeo de calidad de una lámina.
 *
 * Recibe el fragmento tal como se guarda y el documento ya envuelto por
 * wrapSlideHtml(). Corre el detector de impeccable (filtrado por el perfil de
 * lámina, con el ADN del avatar como design system) más las reglas propias de 30x,
 * y devuelve un veredicto.
 *
 * Se evalúa sobre el HTML **envuelto** a propósito: es el documento que se
 * rasteriza al exportar. Chequear el fragmento crudo dejaría las reglas de página
 * apagadas, porque isFullPage() pide doctype/html/head.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHtml } from './engine/engines/static-html/detect-html.mjs';
import { getAntipattern } from './engine/registry/antipatterns.mjs';
import { buildSlideProfile, applySlideProfile } from './slide-profile.mjs';
import { construirDesignSystem } from './design-system.mjs';
import { correrReglas30x } from './slide-rules.mjs';

/** Enriquece un hallazgo del engine con el nombre y la descripción del catálogo. */
function enriquecer(hallazgo) {
  if (hallazgo.origen === '30x') return hallazgo;
  const meta = getAntipattern(hallazgo.antipattern);
  return {
    ...hallazgo,
    name: hallazgo.name || meta?.name || hallazgo.antipattern,
    description: hallazgo.description || meta?.description || '',
    origen: 'impeccable',
  };
}

/**
 * Colapsa repeticiones de la misma regla. El detector reporta por elemento, así
 * que una sola decisión de diseño puede aparecer 5 veces; para el agente eso es
 * ruido que compite con el hallazgo siguiente.
 */
function agrupar(hallazgos) {
  const porRegla = new Map();
  for (const h of hallazgos) {
    const previo = porRegla.get(h.antipattern);
    if (!previo) {
      porRegla.set(h.antipattern, { ...h, ocurrencias: 1, ejemplos: [h.snippet].filter(Boolean) });
      continue;
    }
    previo.ocurrencias += 1;
    if (previo.ejemplos.length < 3 && h.snippet && !previo.ejemplos.includes(h.snippet)) {
      previo.ejemplos.push(h.snippet);
    }
    // La severidad más alta gana: si una ocurrencia bloquea, la regla bloquea.
    if (h.severity === 'error') previo.severity = 'error';
  }
  // El engine solo emite 'warning' y 'advisory' (esta última para deriva de
  // design-system, que él mismo describe como posiblemente legítima). 'error' lo
  // asignan el perfil de lámina y las reglas 30x.
  const orden = { error: 0, warning: 1, advisory: 2, info: 3 };
  return [...porRegla.values()].sort(
    (a, b) => (orden[a.severity] ?? 4) - (orden[b.severity] ?? 4),
  );
}

/**
 * @param {object} args
 * @param {string} args.html           Fragmento a nivel body, como se guarda
 * @param {string} args.htmlEnvuelto   Documento completo de wrapSlideHtml()
 * @param {string} args.aspectRatio
 * @param {{width:number,height:number}} args.dimensiones  DIMENSIONS canónico
 * @param {string[]} args.familiasDeclaradas  Salida de extractFontFamilies()
 * @param {object|null} args.preset    StylePreset del avatar
 */
export async function chequearLamina({
  html,
  htmlEnvuelto,
  aspectRatio,
  dimensiones,
  familiasDeclaradas = [],
  preset = null,
}) {
  const adn = construirDesignSystem(preset);
  const perfil = buildSlideProfile({ hasDesignSystem: Boolean(adn) });

  // Los comentarios HTML no renderizan, pero el detector los lee como texto y
  // parsea un `<!-- ... font-family ... -->` o un `<script>` comentado como si
  // fueran reales. Se los saca antes de analizar: lo que no llega al PNG no es un
  // defecto de la lámina.
  const sinComentarios = (s) => String(s).replace(/<!--[\s\S]*?-->/g, '');
  const envueltoLimpio = sinComentarios(htmlEnvuelto);
  const htmlLimpio = sinComentarios(html);

  // detectHtml() lee de disco y resuelve <link> relativos contra el directorio del
  // archivo, así que el temporal va dentro de public/ para que las rutas de la
  // lámina resuelvan igual que en el render real.
  const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-check-'));
  const archivo = path.join(dirTemp, 'lamina.html');

  let crudos = [];
  try {
    fs.writeFileSync(archivo, envueltoLimpio, 'utf-8');
    crudos = await detectHtml(archivo, {
      designSystem: adn?.designSystem,
      // El detector solo debe traer sus propias reglas: los ignores del repo
      // clonado de impeccable no aplican acá.
      inlineIgnores: true,
    });
  } finally {
    fs.rmSync(dirTemp, { recursive: true, force: true });
  }

  const deImpeccable = applySlideProfile(crudos.map(enriquecer), perfil);

  const familiasConocidas = new Set(adn?.resumen.fuentes || []);
  const de30x = correrReglas30x(htmlLimpio, {
    aspectRatio,
    dimensiones,
    familiasDeclaradas,
    familiasConocidas,
  });

  const hallazgos = agrupar([...de30x, ...deImpeccable]);
  const bloqueantes = hallazgos.filter((h) => h.severity === 'error');

  return {
    aprobado: bloqueantes.length === 0,
    hallazgos,
    bloqueantes: bloqueantes.length,
    advertencias: hallazgos.filter((h) => h.severity === 'warning').length,
    // Deriva respecto del ADN: no bloquea, pero es la señal más específica de 30x
    // — que la lámina se apartó de la identidad del avatar.
    derivas: hallazgos.filter((h) => h.severity === 'advisory').length,
    adn: adn?.resumen || null,
    reglasApagadas: [...perfil.ignoredRules.keys()],
  };
}
