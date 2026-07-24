import type { BrandColors } from "@/types/brand";

/** Una muestra de color del ADN: el hex y el rol que cumple en la marca. */
export interface PaletteColor {
  hex: string;
  name: string;
}

// Orden de presentación de la paleta: del fondo hacia el acento. Es el orden en
// que una diseñadora suele necesitarlos (primero el lienzo, después el texto,
// el acento al final).
const ROLE_LABELS: readonly { key: keyof BrandColors; name: string }[] = [
  { key: "background", name: "Fondo" },
  { key: "surface", name: "Superficie" },
  { key: "primary", name: "Texto" },
  { key: "secondary", name: "Secundario" },
  { key: "accent", name: "Acento" },
];

const HEX6 = /^#[0-9a-f]{6}$/;

/**
 * Deriva las muestras del ADN desde los 5 colores del preset del avatar,
 * en orden fijo y sin repetir hex (varios avatares comparten acento y
 * secundario, y no tiene sentido mostrar el mismo cuadrito dos veces).
 */
export function paletteFromBrandColors(
  colors?: Partial<BrandColors> | null
): PaletteColor[] {
  if (!colors) return [];
  const out: PaletteColor[] = [];
  const seen = new Set<string>();
  for (const { key, name } of ROLE_LABELS) {
    const hex = colors[key]?.trim().toLowerCase();
    if (!hex || !HEX6.test(hex) || seen.has(hex)) continue;
    seen.add(hex);
    out.push({ hex, name });
  }
  return out;
}
