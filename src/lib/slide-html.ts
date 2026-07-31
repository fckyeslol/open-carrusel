import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

/**
 * Todos los grosores (font-weight) que pedimos a Google Fonts.
 *
 * La forma de lista explícita con `;` del endpoint css2 es TOLERANTE: al pedir
 * `wght@100;200;…;900` Google responde 200 y sirve solo los pesos que la fuente
 * realmente tiene (una fuente de un solo peso como Bebas Neue devuelve solo 400),
 * descartando el resto sin error. Por eso es seguro pedir el rango completo para
 * cualquier familia. (La forma de RANGO `wght@100..900` sí es estricta y da 400
 * en fuentes no-variables — no la usamos.)
 */
export const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/**
 * Los ejes que le pedimos a Google Fonts para una familia.
 *
 * `italic` es CONDICIONAL, y las dos ramas existen por razones concretas:
 *
 * - Sin el eje `ital` NO viaja ninguna cara en itálica, y entonces Chrome la FALSEA:
 *   inclina la recta por transformación. Eso ensancha los glifos y cambia el avance, así
 *   que el PNG dejaba de coincidir con lo que muestra el editor —que sí pedía `ital`—. Era
 *   el bug: una lámina con `font-style: italic` exportaba con la letra ensanchada.
 * - Pedirlo SIEMPRE duplica el CSS inlineado (Inter: 2.5MB → 5.2MB de base64), y ese HTML
 *   viaja por HTTP al servicio de render una vez por lámina. Caro para las láminas —la
 *   mayoría— que no tienen una sola itálica.
 *
 * La forma de lista con `;` es tolerante en los DOS ejes: una familia sin itálica (Anton,
 * Bebas Neue, Bricolage Grotesque) responde 200 y sirve solo las rectas. Por eso es seguro
 * pedir `ital` para cualquier familia.
 */
export function googleFontAxes(italic: boolean): string {
  if (!italic) return `wght@${FONT_WEIGHTS.join(";")}`;
  const upright = FONT_WEIGHTS.map((w) => `0,${w}`).join(";");
  const cursive = FONT_WEIGHTS.map((w) => `1,${w}`).join(";");
  return `ital,wght@${upright};${cursive}`;
}

/** Fragmento `family=<nombre>:<ejes>` para el endpoint css2. */
export function googleFontFamilyParam(family: string, italic = false): string {
  return `family=${encodeURIComponent(family)}:${googleFontAxes(italic)}`;
}

/**
 * ¿Esta lámina necesita las caras en itálica?
 *
 * Deliberadamente AMPLIO: un falso positivo solo cuesta CSS de más, mientras que un falso
 * negativo devuelve el bug (itálica falseada, letra ensanchada). Por eso alcanza con que la
 * palabra aparezca en cualquier parte del HTML —cubre `font-style: italic`, la forma corta
 * `font: italic 700 40px X` y una clase declarada en un `<style>`— además de `<em>`/`<i>`.
 */
export function usesItalic(html: string): boolean {
  return /italic|oblique/i.test(html) || /<(?:em|i)[\s>/]/i.test(html);
}

/**
 * Extract Google Font family names from slide HTML.
 * Looks for font-family declarations in inline styles and <style> tags.
 */
export function extractFontFamilies(html: string): string[] {
  const families = new Set<string>();
  // Los comentarios no declaran fuentes reales; sacarlos evita que un
  // `<!-- font-family: … -->` descriptivo entre como fuente a cargar.
  const sinComentarios = html.replace(/<!--[\s\S]*?-->/g, "");
  // Las comillas del atributo style vienen ESCAPADAS cuando la lámina la serializó el
  // editor: el DOM guarda `style="font-family:&quot;Bricolage Grotesque&quot;,sans-serif"`.
  // Sin desescaparlas, el `;` de `&quot;` cortaba el token y la familia extraída era el
  // literal `&quot` — la real nunca se pedía y esa lámina exportaba con fuente de sistema.
  // Mismo criterio que `inlineImages` en export-slides.ts, que ya desescapa las de url().
  const sinEntidades = sinComentarios
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#0?39);/gi, "'");
  // Captura el stack de font-family: tramos entre comillas simples o caracteres
  // sueltos, hasta `;`, `}`, `<`, salto de línea, o la comilla doble que cierra
  // el atributo style="...".
  //
  // El valor se parsea como una LISTA separada por comas, donde cada ítem es un
  // nombre entre comillas simples, entre comillas dobles, o un token pelado (sin
  // comillas ni espacios). Modelar la coma explícitamente es lo que evita el bug
  // de swallow: tras un token pelado como `sans-serif`, si lo que sigue no es una
  // coma, la lista termina — así la comilla doble que CIERRA el atributo
  // (`'Inter',sans-serif">`) no se consume como apertura de un span. Y como los
  // ítems entre comillas sí se contemplan, un `"Playfair Display"` legítimo entra.
  //
  // Reemplaza dos regex previos rotos: el original no matcheaba `'Inter',...`
  // (devolvía [] → export con fuente de sistema), y su parche permitía spans
  // "[^"]*" que se tragaban el HTML desde la comilla de cierre del atributo.
  const item = `(?:'[^']*'|"[^"]*"|[^\\s,;}"'<]+)`;
  const regex = new RegExp(`font-family:\\s*(${item}(?:\\s*,\\s*${item})*)`, "g");
  let match;
  while ((match = regex.exec(sinEntidades)) !== null) {
    const raw = match[1].trim();
    // Split on commas and take non-generic font names
    const generics = new Set([
      "serif",
      "sans-serif",
      "monospace",
      "cursive",
      "fantasy",
      "system-ui",
      "inherit",
      "initial",
      "unset",
    ]);
    for (const part of raw.split(",")) {
      const name = part.trim().replace(/['"]/g, "");
      if (name && !generics.has(name.toLowerCase())) {
        families.add(name);
      }
    }
  }
  return Array.from(families);
}

/**
 * Wraps slide body HTML into a full HTML document at the correct dimensions.
 * This is THE shared rendering contract between preview (iframe) and export (Puppeteer).
 */
export function wrapSlideHtml(
  slideHtml: string,
  aspectRatio: AspectRatio,
  options?: { inlineFontCss?: string }
): string {
  const { width, height } = DIMENSIONS[aspectRatio];
  const fontFamilies = extractFontFamilies(slideHtml);

  let fontBlock = "";
  if (options?.inlineFontCss) {
    // For export: use inlined base64 @font-face CSS
    fontBlock = `<style>${options.inlineFontCss}</style>`;
  } else if (fontFamilies.length > 0) {
    // For preview: use Google Fonts CDN link (rango completo de grosores). El eje `ital`
    // se decide con la MISMA función que usa el export, así el preview no puede quedar con
    // itálica real mientras el PNG la falsea.
    const italic = usesItalic(slideHtml);
    const params = fontFamilies.map((f) => googleFontFamilyParam(f, italic)).join("&");
    fontBlock = `<link href="https://fonts.googleapis.com/css2?${params}&display=swap" rel="stylesheet">`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${width}, initial-scale=1">
  ${fontBlock}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  </style>
</head>
<body>
  ${slideHtml}
</body>
</html>`;
}
