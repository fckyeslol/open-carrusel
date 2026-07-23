/**
 * Reglas propias de 30x — lo que el detector de impeccable no puede saber.
 *
 * impeccable juzga interfaces web genéricas. Estas reglas conocen el contrato
 * específico de una lámina: se guarda como fragmento, se envuelve con
 * wrapSlideHtml(), se renderiza en un iframe con sandbox="" y se exporta con
 * Puppeteer a PNG. Cada paso de esa cadena tiene un modo de fallo silencioso.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DIMENSIONES } from './dimensiones.mjs';

const RAIZ = process.cwd();
// Debe coincidir con SAFE_PADDING_PX del SafeZoneOverlay y con el system prompt:
// la zona segura es un padding firme de 108px por lado (10% del ancho de 1080px).
const MARGEN_SEGURO_PX = 108;

function hallazgo(id, nombre, severidad, mensaje, snippet) {
  return { antipattern: id, name: nombre, severity: severidad, description: mensaje, snippet, origen: '30x' };
}

/**
 * El HTML de lámina se guarda a nivel body. wrapSlideHtml() agrega el documento.
 * Si el agente guarda un documento completo, termina anidado dentro de otro.
 */
function contratoDeFragmento(html) {
  const prohibidos = [
    [/<!DOCTYPE/i, '<!DOCTYPE>'],
    [/<html[\s>]/i, '<html>'],
    [/<head[\s>]/i, '<head>'],
    [/<body[\s>]/i, '<body>'],
  ];
  return prohibidos
    .filter(([re]) => re.test(html))
    .map(([, etiqueta]) =>
      hallazgo(
        'slide-forbidden-wrapper',
        'Documento completo en una lámina',
        'error',
        `La lámina contiene ${etiqueta}. Se guarda solo HTML a nivel body: wrapSlideHtml() ` +
          `arma el documento. Renderiza igual porque el navegador descarta las etiquetas ` +
          `anidadas, pero las restricciones de tamaño (width/height/overflow:hidden) se ` +
          `aplican al documento externo y no alcanzan a este contenido — de ahí salen los ` +
          `recortes que no se explican mirando el CSS de la lámina.`,
        etiqueta,
      ),
    );
}

/**
 * El iframe usa sandbox="" — sin allow-scripts. El JS no corre y no avisa: la
 * lámina renderiza con el DOM inicial y lo que el script iba a generar no aparece.
 */
function sinJavaScript(html) {
  const hallazgos = [];
  if (/<script[\s>]/i.test(html)) {
    hallazgos.push(
      hallazgo(
        'slide-script-tag',
        'Etiqueta <script> en una lámina',
        'error',
        'El iframe usa sandbox="" y el export rasteriza sin ejecutar JS. El script no ' +
          'corre y no da error: lo que iba a generar simplemente falta en el PNG.',
        '<script>',
      ),
    );
  }
  const manejadores = html.match(/\son(click|load|error|mouse\w+)\s*=/gi) || [];
  for (const m of new Set(manejadores.map((x) => x.trim()))) {
    hallazgos.push(
      hallazgo(
        'slide-script-tag',
        'Manejador de evento inline',
        'warning',
        `${m} nunca se dispara: no hay interacción sobre un PNG.`,
        m,
      ),
    );
  }
  return hallazgos;
}

/**
 * Las imágenes se referencian como /uploads/{archivo}. El export las convierte a
 * data URI leyéndolas de public/. Si el archivo no está, sale un hueco en blanco.
 *
 * El regex contempla entidades escapadas porque el editor visual serializa así
 * (misma razón que en export-slides.ts).
 */
function referenciasDeImagen(html) {
  const rutas = new Set();
  const re = /(?:\/uploads\/[^"'\s)>&]+)/g;
  for (const m of html.matchAll(re)) rutas.add(m[0]);

  const hallazgos = [];
  for (const ruta of rutas) {
    const decodificada = decodeURIComponent(ruta);
    const enDisco = path.join(RAIZ, 'public', decodificada.replace(/^\//, ''));
    if (!fs.existsSync(enDisco)) {
      hallazgos.push(
        hallazgo(
          'slide-broken-upload',
          'Imagen inexistente',
          'error',
          `${decodificada} no existe en public/. El export la reemplaza por un hueco en blanco.`,
          decodificada,
        ),
      );
    }
  }
  return hallazgos;
}

/**
 * Una lámina que declara dimensiones distintas a las del carrusel se recorta o
 * deja franja: el screenshot usa clip exacto a DIMENSIONES[aspectRatio].
 */
function dimensionesDelLienzo(html, aspectRatio, dimensiones) {
  // Las dimensiones llegan inyectadas desde el lado TS, que importa el DIMENSIONS
  // canónico de types/carousel.ts. El espejo .mjs es solo el fallback para uso
  // standalone; así el chequeo nunca juzga contra una copia que se desactualizó.
  const esperado = dimensiones || DIMENSIONES[aspectRatio];
  if (!esperado) return [];

  const hallazgos = [];
  const re = /(width|height)\s*:\s*(\d{3,4})px/gi;
  for (const m of html.matchAll(re)) {
    const eje = m[1].toLowerCase();
    const valor = Number(m[2]);
    const objetivo = eje === 'width' ? esperado.width : esperado.height;
    // Solo juzga valores en el rango del lienzo completo. Un bloque de 400px es
    // contenido, no un intento de declarar el lienzo.
    if (valor >= 900 && valor !== objetivo) {
      hallazgos.push(
        hallazgo(
          'slide-canvas-mismatch',
          'Dimensión fuera del lienzo',
          'error',
          `${eje}: ${valor}px pero el carrusel ${aspectRatio} mide ` +
            `${esperado.width}×${esperado.height}. El screenshot recorta a la medida ` +
            `del carrusel, así que esto se pierde o deja franja.`,
          m[0],
        ),
      );
    }
  }
  return hallazgos;
}

/**
 * Instagram superpone UI sobre los bordes de la lámina. El system prompt exige
 * (regla dura) que TODO el texto viva dentro del recuadro del grid: 108px desde
 * los bordes laterales y superior. Violarla en esos tres lados es ERROR y
 * bloquea la lámina; el borde inferior queda en warning (firmas/CTA bajos).
 *
 * Alcance honesto: esto lee posicionamiento absoluto declarado, no layout
 * calculado. Detecta el caso frecuente (position:absolute con un offset chico);
 * no ve texto empujado al borde por flex o por un margin negativo heredado.
 * Para eso está la lectura del PNG.
 */
function margenSeguro(html) {
  const hallazgos = [];

  // Solo se juzgan elementos posicionados que CONTIENEN TEXTO. El system prompt
  // autoriza explícitamente que los decorativos sangren hasta el borde, así que
  // marcar una pincelada SVG o un bloque de color pegado al margen es ruido — y
  // el ruido constante entrena a ignorar la regla.
  const re = /<([a-z]+)\b([^>]*\bstyle\s*=\s*"([^"]*position\s*:\s*absolute[^"]*)"[^>]*)>([\s\S]*?)<\/\1>/gi;

  for (const m of html.matchAll(re)) {
    const [, tag, , estilo, contenido] = m;
    if (tag.toLowerCase() === 'svg') continue;

    // Texto real, ya sin etiquetas anidadas ni espacios.
    const texto = contenido.replace(/<[^>]*>/g, '').replace(/&\w+;/g, ' ').trim();
    if (!texto) continue;

    for (const offset of estilo.matchAll(/\b(top|bottom|left|right)\s*:\s*(-?\d+(?:\.\d+)?)px/gi)) {
      const valor = Number(offset[2]);
      if (valor >= MARGEN_SEGURO_PX) continue;
      const lado = offset[1].toLowerCase();
      // Regla dura en laterales y superior; abajo queda en warning porque las
      // firmas/CTA a veces viven cerca del borde inferior por decisión.
      const severidad = lado === 'bottom' ? 'warning' : 'error';
      hallazgos.push(
        hallazgo(
          'slide-safe-margin',
          'Texto fuera del recuadro del grid',
          severidad,
          `${lado}: ${valor}px deja el texto "${texto.slice(0, 40)}" fuera del ` +
            `recuadro del grid (padding firme de ${MARGEN_SEGURO_PX}px), donde ` +
            `Instagram superpone su UI. El texto SIEMPRE se genera dentro del ` +
            `recuadro; solo los decorativos pueden sangrar hasta el borde.`,
          offset[0],
        ),
      );
    }
  }
  return hallazgos;
}

/**
 * El fallo silencioso más caro del pipeline.
 *
 * El preview enlaza Google Fonts por CDN, así que el iframe resuelve casi
 * cualquier familia. El export usa getInlinedFontCSS(), que ante una familia que
 * no puede traer hace `catch {}` y sigue —comentario literal en fonts.ts:
 * "Font not available — skip silently". Resultado: la lámina se ve bien en el
 * editor y se exporta con una fuente de sistema completamente distinta.
 *
 * Mirando el preview eso no se detecta nunca.
 *
 * Las familias llegan ya extraídas por extractFontFamilies() de slide-html.ts —
 * la misma función que usa el render real. Extraerlas por separado acá haría que
 * el chequeo juzgue un conjunto de fuentes distinto al que se va a cargar.
 */
function fuentesResolubles({ familiasDeclaradas, familiasConocidas }) {
  const hallazgos = [];
  for (const familia of familiasDeclaradas) {
    const cacheada = fs.existsSync(
      path.join(RAIZ, 'data', '.font-cache', `${familia.replace(/\s/g, '-')}.css`),
    );
    if (cacheada) continue;
    if (familiasConocidas.has(familia)) continue;

    hallazgos.push(
      hallazgo(
        'slide-unresolved-font',
        'Fuente sin verificar para el export',
        'warning',
        `"${familia}" no está en el ADN del avatar ni en data/.font-cache/. El preview ` +
          `la resuelve por CDN, pero si el export no puede traerla cae a fuente de ` +
          `sistema en silencio y el PNG sale con otra tipografía. Exportá una lámina ` +
          `de prueba antes de confiar en ella.`,
        familia,
      ),
    );
  }
  return hallazgos;
}

/**
 * Un bloque de display quebrado a mano con líneas de largo muy dispar pierde la
 * masa rectangular que define al póster tipográfico.
 *
 * Cuando el referente arma un rectángulo compacto y el calco termina en dos líneas
 * cortas, la silueta cambia aunque el texto sea correcto. Es un defecto de quiebre,
 * no de contenido, y se ve en el conteo de caracteres por línea.
 *
 * Solo se juzgan bloques con <br> explícitos: si el navegador quiebra solo, el
 * reparto no fue una decisión y el ancho del contenedor manda.
 */
function bloqueDesflecado(html) {
  const hallazgos = [];
  const UMBRAL = 0.55; // la línea más corta bajo el 55% de la más larga
  const MINIMO_LINEAS = 3;

  for (const m of html.matchAll(/<([a-z]+)\b[^>]*>((?:[^<]|<br\s*\/?>)*<br\s*\/?>(?:[^<]|<br\s*\/?>)*)<\/\1>/gi)) {
    const lineas = m[2]
      .split(/<br\s*\/?>/i)
      .map((l) => l.replace(/&\w+;/g, ' ').trim())
      .filter(Boolean);

    if (lineas.length < MINIMO_LINEAS) continue;

    const largos = lineas.map((l) => l.length);
    const max = Math.max(...largos);
    const min = Math.min(...largos);
    if (max === 0 || min / max >= UMBRAL) continue;

    const cortas = lineas.filter((l) => l.length / max < UMBRAL);
    hallazgos.push(
      hallazgo(
        'slide-ragged-block',
        'Bloque de texto desflecado',
        'warning',
        `El bloque quiebra en ${lineas.length} líneas de largo muy dispar ` +
          `(${min}-${max} caracteres): ${cortas.map((l) => `"${l}"`).join(', ')} ` +
          `quedan cortas y el bloque pierde su masa rectangular. Si el referente arma ` +
          `un bloque parejo, redistribuí los quiebres para igualar los anchos.`,
        lineas.join(' / ').slice(0, 70),
      ),
    );
  }
  return hallazgos;
}

/**
 * La marca "30x" nunca va tipeada: siempre es el logo SVG oficial
 * (/30x/logo-light.svg, /30x/logo-dark.svg o /30x/logo-accent.svg).
 *
 * Se juzga solo el TEXTO visible: al quitar etiquetas desaparecen los atributos,
 * así que ni src="/30x/logo-*.svg" ni alt="30x" cuentan como hallazgo.
 */
function marcaTipeada(html) {
  const textoVisible = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ');

  const hallazgos = [];
  for (const m of textoVisible.matchAll(/\b30\s?[xX]\b/g)) {
    const contexto = textoVisible
      .slice(Math.max(0, m.index - 25), m.index + m[0].length + 25)
      .replace(/\s+/g, ' ')
      .trim();
    hallazgos.push(
      hallazgo(
        'slide-brand-as-text',
        'Marca 30x tipeada como texto',
        'warning',
        `"${m[0]}" aparece como texto plano ("…${contexto}…"). La marca va SIEMPRE con el ` +
          `logo SVG, nunca tipeada: <img src="/30x/logo-light.svg"> sobre fondo oscuro, ` +
          `logo-dark.svg sobre fondo claro, logo-accent.svg (X lima) cuando el acento suma. ` +
          `Inline en una frase: height:0.72em + vertical-align:baseline.`,
        contexto,
      ),
    );
  }
  return hallazgos;
}

/**
 * Corre todas las reglas 30x sobre el fragmento crudo de la lámina.
 *
 * @param {string} html          HTML a nivel body, tal como se guarda
 * @param {{ aspectRatio: string, dimensiones?: {width:number,height:number},
 *           familiasDeclaradas?: string[], familiasConocidas?: Set<string> }} contexto
 */
export function correrReglas30x(
  html,
  {
    aspectRatio,
    dimensiones = null,
    familiasDeclaradas = [],
    familiasConocidas = new Set(),
  } = {},
) {
  return [
    ...contratoDeFragmento(html),
    ...sinJavaScript(html),
    ...referenciasDeImagen(html),
    ...dimensionesDelLienzo(html, aspectRatio, dimensiones),
    ...margenSeguro(html),
    ...marcaTipeada(html),
    ...bloqueDesflecado(html),
    ...fuentesResolubles({ familiasDeclaradas, familiasConocidas }),
  ];
}
