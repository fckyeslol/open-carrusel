import { readDataSafe, updateData } from "./data";

/**
 * Paletas de color propias de cada diseñadora, guardadas POR AVATAR (por su
 * style-preset). Se suman a las muestras del ADN en los selectores de color del
 * editor, así que un color guardado aparece de un clic en todos los carruseles
 * de ese avatar y sobrevive a la regeneración de presets (que sí pisa
 * data/style-presets.json). Por eso viven en su propio archivo.
 */

const FILE = "custom-palettes.json";
const HEX6 = /^#[0-9a-f]{6}$/;
const MAX_COLORS = 24; // tope defensivo: una paleta no es un catálogo entero

/** presetId → lista de hex (#rrggbb en minúscula, sin repetir). */
type PaletteStore = Record<string, string[]>;

/** Normaliza a #rrggbb en minúscula; descarta lo que no sea un hex de 6 dígitos. */
function cleanColors(colors: unknown): string[] {
  if (!Array.isArray(colors)) return [];
  const seen = new Set<string>();
  for (const raw of colors) {
    if (typeof raw !== "string") continue;
    const hex = raw.trim().toLowerCase();
    if (HEX6.test(hex)) seen.add(hex);
  }
  return [...seen].slice(0, MAX_COLORS);
}

/** Colores guardados para un avatar (vacío si no hay o si el id es falsy). */
export async function getPalette(presetId: string): Promise<string[]> {
  if (!presetId) return [];
  const store = await readDataSafe<PaletteStore>(FILE, {});
  return cleanColors(store[presetId]);
}

/**
 * Reemplaza la paleta del avatar con `colors` (ya normalizados). Devuelve la
 * lista final persistida. Una lista vacía deja la clave vacía, no la borra.
 */
export async function setPalette(
  presetId: string,
  colors: string[]
): Promise<string[]> {
  const clean = cleanColors(colors);
  await updateData<PaletteStore>(FILE, {}, (store) => ({
    ...store,
    [presetId]: clean,
  }));
  return clean;
}
