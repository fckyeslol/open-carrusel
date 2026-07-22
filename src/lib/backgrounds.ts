import { readDataSafe, updateData } from "./data";
import { generateId, now } from "./utils";
import type { Background, BackgroundsData } from "@/types/background";

const FILE = "backgrounds.json";
const EMPTY: BackgroundsData = { backgrounds: [] };

async function load(): Promise<BackgroundsData> {
  return readDataSafe<BackgroundsData>(FILE, EMPTY);
}

export async function listBackgrounds(): Promise<Background[]> {
  const data = await load();
  return data.backgrounds;
}

/** Categorías presentes, ordenadas alfabéticamente y sin repetidos. */
export async function listCategories(): Promise<string[]> {
  const data = await load();
  return [...new Set(data.backgrounds.map((b) => b.category))].sort();
}

export async function createBackground(
  params: Omit<Background, "id" | "createdAt">
): Promise<Background> {
  const background: Background = {
    ...params,
    id: generateId(),
    createdAt: now(),
  };
  await updateData<BackgroundsData>(FILE, EMPTY, (current) => ({
    backgrounds: [...current.backgrounds, background],
  }));
  return background;
}

/**
 * Saca el fondo de la biblioteca pero NO borra el archivo de `public/uploads`:
 * una lámina que ya lo tenga aplicado lo referencia por URL dentro de su HTML,
 * así que borrar el archivo rompería carruseles ya hechos.
 */
export async function deleteBackground(id: string): Promise<boolean> {
  let existed = false;
  await updateData<BackgroundsData>(FILE, EMPTY, (current) => {
    const remaining = current.backgrounds.filter((b) => b.id !== id);
    existed = remaining.length !== current.backgrounds.length;
    return existed ? { backgrounds: remaining } : current;
  });
  return existed;
}
