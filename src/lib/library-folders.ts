/**
 * Agrupado de la Biblioteca en carpetas por avenger.
 *
 * La Biblioteca crecía como dos listas planas (eliminados y entregados) que solo se hacían
 * más largas: después de unas semanas encontrar "el de Cinthya de la semana pasada" era
 * scrollear. Una carpeta por avenger corta el problema donde está: cada diseñadora trabaja
 * con pocos avengers y muchos carruseles por avenger, así que el avenger es el eje que
 * parte la lista en pedazos que caben en una pantalla.
 *
 * Es lógica pura (sin fetch, sin React) para que el agrupado se pueda testear solo —
 * `library-folders.test.mts`.
 */

/** Lo mínimo que la Biblioteca necesita de una asignación para agruparla y pintarla. */
export interface LibraryItem {
  jobId: string;
  avatarSlug: string;
  avatarName: string | null;
  referenceUrl: string;
  status: string;
  carouselId: string | null;
  /** Solo en `archived`: cuándo pasó a la Biblioteca. */
  archivedAt?: string;
  updatedAt: string;
}

/** Una carpeta = un avenger, con lo entregado y lo eliminado de ese avenger. */
export interface AvengerFolder {
  /** Clave estable para la URL (`/biblioteca?avenger=…`): el slug del avatar. */
  key: string;
  /** Nombre para mostrar, ya sin el prefijo "30X —". */
  name: string;
  entregados: LibraryItem[];
  eliminados: LibraryItem[];
  /** Portada: el carrusel más reciente que tenga algo para mostrar. */
  coverCarouselId: string | null;
  /** Última actividad de la carpeta, en ISO. "" si ninguno de sus ítems tiene fecha. */
  lastActivityAt: string;
}

/**
 * Los pedidos sin avatar también necesitan carpeta: son los que quedaron sin resolver el
 * avenger y son justo los que uno va a buscar. Sin esta clave desaparecerían del agrupado.
 */
export const SIN_AVATAR_KEY = "sin-avatar";

export function isEntregado(status: string): boolean {
  return status === "delivered" || status === "done";
}

export function isEliminado(status: string): boolean {
  return status === "archived";
}

/** El nombre del avenger sin el prefijo de marca, que en la Biblioteca es ruido repetido. */
export function shortAvatar(name: string | null, slug: string): string {
  return (name || slug || "Sin avatar").replace(/^30X\s*[—–-]\s*/i, "").trim();
}

export function refHost(url: string): string {
  return (url || "").replace(/^https?:\/\/(www\.)?/, "").slice(0, 40);
}

/** "27 jul, 14:32" — corto, porque la fecha acá es solo para ordenarse mentalmente. */
export function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * La fecha que le importa al ítem: cuándo se eliminó si está en la Biblioteca por eso,
 * y si no la última vez que se tocó.
 */
export function itemDate(item: LibraryItem): string {
  return item.archivedAt || item.updatedAt || "";
}

/** Cuántas piezas hay en la carpeta, entregadas y eliminadas juntas. */
export function folderTotal(folder: AvengerFolder): number {
  return folder.entregados.length + folder.eliminados.length;
}

/** "1 entregado" / "4 entregados": los contadores de una carpeta llegan a 1 seguido. */
export function plural(n: number, singular: string, muchos: string): string {
  return `${n} ${n === 1 ? singular : muchos}`;
}

/**
 * Reparte las asignaciones en carpetas por avenger.
 *
 * Solo entra lo que vive en la Biblioteca (entregado o eliminado): lo que está en curso es
 * del tablero, y mostrarlo acá haría que el mismo pedido apareciera en dos lugares con
 * acciones distintas.
 *
 * Las carpetas salen ordenadas alfabéticamente (una carpeta se busca por nombre, no por
 * recencia) y los ítems de cada una de lo más nuevo a lo más viejo.
 */
export function buildAvengerFolders(items: readonly LibraryItem[]): AvengerFolder[] {
  const byKey = new Map<string, AvengerFolder>();

  for (const item of items) {
    const entregado = isEntregado(item.status);
    if (!entregado && !isEliminado(item.status)) continue;

    const key = item.avatarSlug || SIN_AVATAR_KEY;
    const folder = byKey.get(key) ?? {
      key,
      name: shortAvatar(item.avatarName, item.avatarSlug),
      entregados: [],
      eliminados: [],
      coverCarouselId: null,
      lastActivityAt: "",
    };
    if (!byKey.has(key)) byKey.set(key, folder);

    if (entregado) folder.entregados.push(item);
    else folder.eliminados.push(item);
  }

  return [...byKey.values()]
    .map((folder) => {
      const entregados = sortByDateDesc(folder.entregados);
      const eliminados = sortByDateDesc(folder.eliminados);
      // La portada prefiere lo entregado: es el trabajo terminado, y una carpeta que se
      // presenta con lo que su dueña descartó cuenta la historia al revés.
      const cover =
        entregados.find((i) => i.carouselId) ?? eliminados.find((i) => i.carouselId) ?? null;
      const fechas = [...entregados, ...eliminados].map(itemDate).filter(Boolean);
      return {
        ...folder,
        entregados,
        eliminados,
        coverCarouselId: cover?.carouselId ?? null,
        lastActivityAt: fechas.length ? fechas.reduce((a, b) => (a > b ? a : b)) : "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

function sortByDateDesc(items: readonly LibraryItem[]): LibraryItem[] {
  return [...items].sort((a, b) => itemDate(b).localeCompare(itemDate(a)));
}
