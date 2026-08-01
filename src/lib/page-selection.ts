/**
 * Qué láminas entran en una exportación — el "1, 3, 5-7" de Canva.
 *
 * Vive en su propio módulo porque lo comparten los dos lados de la exportación: el menú
 * (valida lo que escribe la diseñadora antes de habilitar el botón y arma el nombre del
 * archivo) y la ruta `/api/carousels/[id]/export`, que recibe la selección como `?pages=`.
 * Si cada lado lo parseara a su manera, la UI podría habilitar una selección que el
 * servidor rechaza — o peor, aceptar una que el servidor interpreta distinto y bajar un
 * archivo con láminas que nadie pidió.
 */

/** Resultado de parsear una selección. Nunca lanza: el error es texto para la UI. */
export type PageSelection =
  | { ok: true; pages: number[] }
  | { ok: false; error: string };

/** Coma, punto y coma o espacios separan ítems: "1, 3 5;7" son cuatro láminas. */
const SEPARADORES = /[,;\s]+/;

/** Un ítem es una lámina (`3`) o un rango (`5-7`). */
const ITEM = /^(\d+)(?:-(\d+))?$/;

/** Guiones normales, en dash y em dash: los tres se escriben al pegar desde otro lado. */
const GUIONES = /\s*[-–—]\s*/g;

/** Todas las láminas, 1-based. */
export function allPages(total: number): number[] {
  return Array.from({ length: total }, (_, i) => i + 1);
}

/**
 * Parsea una selección de láminas 1-based ("1, 3, 5-7") contra un carrusel de `total`
 * láminas. Devuelve las láminas ordenadas y sin repetir, o un error explicando qué falló.
 *
 * Los rangos al revés (`7-5`) se aceptan y se normalizan; una lámina fuera de rango es un
 * error y no se recorta en silencio, porque "exporté 1-9" y recibir 7 archivos es
 * exactamente el tipo de fallo mudo que no se nota hasta que el carrusel ya se entregó.
 */
export function parsePageSelection(input: string, total: number): PageSelection {
  if (total <= 0) {
    return { ok: false, error: "El carrusel no tiene láminas" };
  }

  const items = input
    .replace(GUIONES, "-")
    .trim()
    .split(SEPARADORES)
    .filter(Boolean);

  if (items.length === 0) {
    return {
      ok: false,
      error: "Escribí qué láminas exportar (ej. 1, 3, 5-7)",
    };
  }

  const pages = new Set<number>();

  for (const item of items) {
    const match = ITEM.exec(item);
    if (!match) {
      return {
        ok: false,
        error: `No entiendo "${item}" — usá números y rangos (ej. 1, 3, 5-7)`,
      };
    }

    const desde = Number.parseInt(match[1], 10);
    const hasta = match[2] === undefined ? desde : Number.parseInt(match[2], 10);
    const [inicio, fin] = desde <= hasta ? [desde, hasta] : [hasta, desde];

    for (const page of [inicio, fin]) {
      if (page < 1 || page > total) {
        return {
          ok: false,
          error: `La lámina ${page} no existe — el carrusel tiene ${total}`,
        };
      }
    }

    for (let page = inicio; page <= fin; page++) pages.add(page);
  }

  return { ok: true, pages: Array.from(pages).sort((a, b) => a - b) };
}

/**
 * Sufijo para el nombre del archivo según la selección.
 *
 * Una sola lámina mantiene el `-slide-N` que las diseñadoras ya conocen; la selección
 * completa no lleva sufijo (es el nombre del carrusel, como siempre).
 */
export function pageFileSuffix(pages: number[], total: number): string {
  if (pages.length === 0 || pages.length === total) return "";
  if (pages.length === 1) return `-slide-${pages[0]}`;
  return `-laminas-${pages.join("-")}`;
}
