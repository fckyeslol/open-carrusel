/**
 * Historial de las ENTRADAS MANUALES de /30x (data/thirtyx-manual-entries.json).
 *
 * La cola de Prewave deja rastro de todo en `assignments.ts`: qué se pidió, con
 * qué avatar, cómo terminó. La entrada manual (pegar una URL de Instagram y darle
 * "Generar carrusel") no dejaba nada: si la ingesta reventaba, o la diseñadora
 * cerraba la pestaña antes de que terminara, la URL se perdía y había que volver
 * a buscarla en Instagram. Este store es el equivalente manual de esa cola.
 *
 * Guarda lo que hace falta para RETOMAR el trabajo (URL, avatar, nota) y para
 * saber cómo salió (carrusel creado, o etapa + motivo del fallo). No duplica el
 * carrusel en sí: `carouselId` lo enlaza y el carrusel sigue siendo la fuente de
 * verdad de su contenido.
 *
 * Igual que `assignments.ts`, escribe con `updateData` (mutex + escritura
 * atómica) para que dos ingestas en paralelo no se pisen el archivo.
 */
import { readDataSafe, updateData } from "./data";
import { listCarousels } from "./carousels";
import { listAvatarPresets } from "./style-presets";
import { isHostedMode } from "./hosted";
import { generateId, now } from "./utils";
import type { IngestStageId } from "@/types/ingest-progress";

const FILE = "thirtyx-manual-entries.json";

/**
 * Cuántas entradas se conservan. Es un historial de trabajo, no una auditoría:
 * pasadas unas decenas ya nadie vuelve a mirarlas y solo engordan el JSON que se
 * lee entero en cada poll. Se podan las más viejas al insertar.
 */
const MAX_ENTRIES = 60;

/**
 * Una ingesta que sigue "en curso" pasado este tiempo se da por cortada. La ruta
 * tiene `maxDuration = 120`, así que a los 5 minutos no hay proceso vivo posible:
 * o se cayó el server, o la diseñadora cerró la pestaña a mitad de camino. Sin
 * esto, esas entradas quedarían pulsando "Generando…" para siempre.
 */
const STALE_MS = 5 * 60 * 1000;

export type ManualEntryStatus =
  | "ingesting" // bajando el referente + creando el carrusel
  | "ready" // referente adjunto: el carrusel existe y se puede abrir
  | "failed"; // reventó en alguna etapa (o se cortó a la mitad)

export interface ManualEntry {
  id: string;
  referenceUrl: string;
  avatarSlug: string;
  /** Nombre del preset del avatar al momento de lanzar; null si no se resolvió. */
  avatarName: string | null;
  /** La nota de generación que escribió la diseñadora, para poder reusarla. */
  note: string | null;
  /** Modo hosteado: cada diseñadora ve solo SU historial. Null en local. */
  designerId: string | null;
  status: ManualEntryStatus;
  carouselId: string | null;
  /** Cuántas láminas del referente se adjuntaron (solo si terminó bien). */
  referenceCount: number | null;
  /** Etapa donde reventó, para que la UI diga algo más útil que "falló". */
  stage: IngestStageId | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Store {
  entries: ManualEntry[];
  /**
   * Cuándo se sembró el historial desde los carruseles que ya existían. Es la
   * marca que hace que la siembra corra UNA sola vez (ver ensureBackfilled).
   */
  backfilledAt?: string;
}

const EMPTY: Store = { entries: [] };

/** Más recientes primero: el historial se lee de arriba hacia abajo. */
function byNewest(a: ManualEntry, b: ManualEntry): number {
  return b.createdAt.localeCompare(a.createdAt);
}

function isStale(entry: ManualEntry, cutoff: number): boolean {
  return (
    entry.status === "ingesting" && Date.parse(entry.updatedAt) < cutoff
  );
}

/**
 * Reconstruye el historial de los carruseles que YA se habían creado pegando una
 * URL a mano, antes de que este historial existiera. El carrusel guarda todo lo
 * necesario (`source: "manual"` + `referenceUrl` + `avatarSlug`), así que la
 * bitácora no tiene por qué arrancar en blanco.
 *
 * Se saltean los hermanos de resize: `createResizedSibling` copia el `source` y
 * el `referenceUrl` del original, así que sin este filtro cada "Generar otros
 * tamaños" aparecería como una entrada manual repetida.
 */
async function seedsFromCarousels(): Promise<ManualEntry[]> {
  const carousels = await listCarousels();
  const manual = carousels.filter(
    (c) => c.source === "manual" && c.referenceUrl && !c.resizedFrom
  );
  if (manual.length === 0) return [];

  // Los presets se leen UNA vez y no uno por carrusel: solo hacen falta para
  // mostrar "Andrés Bilbao" en vez de "andres-bilbao".
  const names = new Map(
    (await listAvatarPresets())
      .filter((p) => p.avatarSlug)
      .map((p) => [p.avatarSlug!.toLowerCase(), p.name] as const)
  );

  return manual.map((c) => ({
    id: generateId(),
    referenceUrl: c.referenceUrl!,
    avatarSlug: c.avatarSlug ?? "",
    avatarName: names.get((c.avatarSlug ?? "").toLowerCase()) ?? null,
    note: null,
    designerId: null,
    status: "ready" as const,
    carouselId: c.id,
    referenceCount: c.referenceImages?.length ?? null,
    stage: null,
    error: null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
}

/**
 * Siembra el historial una única vez y devuelve el store ya listo.
 *
 * El marcador `backfilledAt` (y no "¿está vacío?") es lo que decide: si se
 * volviera a derivar del listado de carruseles en cada lectura, cada "Quitar del
 * historial" se desharía solo en el próximo poll. Una vez sembrado, el store es
 * la única fuente de verdad. El chequeo se repite DENTRO de `updateData` porque
 * dos pedidos en paralelo pueden llegar los dos con el archivo sin sembrar; ahí
 * el mutex los serializa y el segundo ve la marca del primero.
 *
 * En modo hosteado NO se siembra: el carrusel no guarda de quién es, así que no
 * hay forma de atribuirle las entradas viejas a una diseñadora. Quedarían con
 * `designerId: null` — invisibles para todas y ocupando lugar en el historial.
 * Igual se deja la marca, para no recalcular la siembra en cada lectura.
 */
async function ensureBackfilled(): Promise<Store> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  if (store.backfilledAt) return store;

  const seeds = isHostedMode() ? [] : await seedsFromCarousels();
  return updateData<Store>(FILE, EMPTY, (current) => {
    if (current.backfilledAt) return current; // otro pedido ganó la carrera
    const known = new Set(current.entries.map((e) => e.carouselId).filter(Boolean));
    return {
      ...current,
      entries: [...current.entries, ...seeds.filter((s) => !known.has(s.carouselId))]
        .sort(byNewest)
        .slice(0, MAX_ENTRIES),
      backfilledAt: now(),
    };
  });
}

/**
 * Lista el historial, cerrando de paso las ingestas que quedaron colgadas (ver
 * STALE_MS). La reconciliación va acá y no en un job aparte porque este store
 * solo se lee cuando la UI abre el historial: es el único momento en que
 * alguien puede ver una entrada zombi, y es cuando conviene corregirla.
 */
export async function listManualEntries(): Promise<ManualEntry[]> {
  const store = await ensureBackfilled();
  const cutoff = Date.now() - STALE_MS;
  if (!store.entries.some((e) => isStale(e, cutoff))) {
    return [...store.entries].sort(byNewest);
  }

  // Hay zombis: se marcan como fallidas de forma durable antes de devolverlas.
  let reconciled: ManualEntry[] = [];
  await updateData<Store>(FILE, EMPTY, (current) => {
    reconciled = current.entries.map((e) =>
      isStale(e, cutoff)
        ? {
            ...e,
            status: "failed" as const,
            error:
              e.error ??
              "La ingesta se cortó antes de terminar (se cerró la pestaña o se reinició el servidor).",
            updatedAt: now(),
          }
        : e
    );
    return { ...current, entries: reconciled };
  });
  return [...reconciled].sort(byNewest);
}

/** Historial de UNA diseñadora (modo hosteado). */
export async function listManualEntriesForDesigner(
  designerId: string
): Promise<ManualEntry[]> {
  return (await listManualEntries()).filter((e) => e.designerId === designerId);
}

export async function getManualEntry(id: string): Promise<ManualEntry | null> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  return store.entries.find((e) => e.id === id) ?? null;
}

export interface NewManualEntry {
  referenceUrl: string;
  avatarSlug: string;
  avatarName?: string | null;
  note?: string | null;
  designerId?: string | null;
}

/**
 * Anota una entrada manual APENAS se lanza, en estado `ingesting`. Se escribe
 * antes de empezar a bajar el referente a propósito: si el proceso muere en el
 * medio, la URL igual quedó guardada — que es justo lo que antes se perdía.
 */
export async function createManualEntry(input: NewManualEntry): Promise<ManualEntry> {
  const ts = now();
  const entry: ManualEntry = {
    id: generateId(),
    referenceUrl: input.referenceUrl,
    avatarSlug: input.avatarSlug,
    avatarName: input.avatarName ?? null,
    note: input.note ?? null,
    designerId: input.designerId ?? null,
    status: "ingesting",
    carouselId: null,
    referenceCount: null,
    stage: null,
    error: null,
    createdAt: ts,
    updatedAt: ts,
  };

  await updateData<Store>(FILE, EMPTY, (store) => ({
    ...store,
    // Se poda por fecha, no por posición: el orden de inserción y el de creación
    // pueden divergir si dos ingestas escriben intercaladas.
    entries: [...store.entries, entry].sort(byNewest).slice(0, MAX_ENTRIES),
  }));
  return entry;
}

/**
 * Parchea una entrada. Todas las mutaciones esparcen `...store` a propósito: si
 * alguna devolviera solo `{ entries }` se perdería `backfilledAt` y la siembra
 * volvería a correr, resucitando lo que se hubiera quitado del historial.
 */
async function patch(id: string, changes: Partial<ManualEntry>): Promise<void> {
  await updateData<Store>(FILE, EMPTY, (store) => ({
    ...store,
    entries: store.entries.map((e) =>
      e.id === id ? { ...e, ...changes, updatedAt: now() } : e
    ),
  }));
}

/** Cierra la entrada OK: el carrusel existe y tiene el referente adjunto. */
export async function completeManualEntry(
  id: string,
  result: { carouselId: string; referenceCount: number; avatarName?: string | null }
): Promise<void> {
  await patch(id, {
    status: "ready",
    carouselId: result.carouselId,
    referenceCount: result.referenceCount,
    ...(result.avatarName ? { avatarName: result.avatarName } : {}),
    stage: null,
    error: null,
  });
}

/**
 * Cierra la entrada con error. Conserva `carouselId` si la ingesta llegó a
 * crearlo: un carrusel a medias (sin todas las láminas del referente) igual sirve
 * para abrirlo y ver qué pasó.
 */
export async function failManualEntry(
  id: string,
  failure: { stage: IngestStageId | null; message: string; carouselId?: string | null }
): Promise<void> {
  await patch(id, {
    status: "failed",
    stage: failure.stage,
    error: failure.message.slice(0, 1000),
    ...(failure.carouselId ? { carouselId: failure.carouselId } : {}),
  });
}

/** Quita una entrada del historial. NO borra el carrusel que haya creado. */
export async function deleteManualEntry(id: string): Promise<boolean> {
  let removed = false;
  await updateData<Store>(FILE, EMPTY, (store) => {
    const kept = store.entries.filter((e) => e.id !== id);
    removed = kept.length !== store.entries.length;
    return { ...store, entries: kept };
  });
  return removed;
}
