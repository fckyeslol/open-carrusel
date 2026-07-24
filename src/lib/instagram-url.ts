/**
 * Helpers de URL de Instagram — SIN dependencias de Node.
 *
 * Viven aparte de `instagram.ts` a propósito: ese módulo importa puppeteer y
 * fs/promises, así que no puede tocarlo un componente cliente. Estas funciones
 * las usan los dos lados (validación en el form y en la ruta).
 */

/** Normaliza a la URL canónica del post: https://www.instagram.com/p/<code>/ */
export function normalizeInstagramUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (!/instagram\.com|instagr\.am/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    return `https://www.instagram.com/p/${m[2]}/`;
  } catch {
    return null;
  }
}

export function isInstagramUrl(raw: string): boolean {
  return normalizeInstagramUrl(raw) !== null;
}

/**
 * ¿La URL sugiere que el post es un CARRUSEL (varias láminas)? Instagram agrega
 * `?img_index=N` cuando compartís un post multi-imagen; los posts de una sola
 * imagen NO lo llevan. Se usa como señal barata para detectar una ingesta
 * degradada: si la URL apunta a un carrusel pero el scraper solo pudo recuperar
 * la portada, el referente quedó incompleto y NO hay que generar con él.
 */
export function hasCarouselHint(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.searchParams.has("img_index");
  } catch {
    return false;
  }
}
