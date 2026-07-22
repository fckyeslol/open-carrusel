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
