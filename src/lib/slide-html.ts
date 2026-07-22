import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

/**
 * Extract Google Font family names from slide HTML.
 * Looks for font-family declarations in inline styles and <style> tags.
 */
export function extractFontFamilies(html: string): string[] {
  const families = new Set<string>();
  // Los comentarios no declaran fuentes reales; sacarlos evita que un
  // `<!-- font-family: … -->` descriptivo entre como fuente a cargar.
  const sinComentarios = html.replace(/<!--[\s\S]*?-->/g, "");
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
  while ((match = regex.exec(sinComentarios)) !== null) {
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
    // For preview: use Google Fonts CDN link
    const params = fontFamilies
      .map(
        (f) =>
          `family=${encodeURIComponent(f)}:wght@300;400;500;600;700;800`
      )
      .join("&");
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
