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

/**
 * Una pieza de la Biblioteca.
 *
 * La unidad es el CARRUSEL, no el pedido. Antes era el pedido, y por eso la Biblioteca
 * perdía todo lo que no nacía de la cola: lo que se hace pegando una URL a mano, lo que
 * se crea desde el home y cada hermano de "Generar otros tamaños" no tienen `Assignment`
 * detrás, así que no existían acá aunque el home los listara. `jobId` en null es
 * justamente eso: una pieza sin pedido.
 */
export interface LibraryItem {
  /** Clave estable de la fila: el carrusel, o el pedido si nunca llegó a crear uno. */
  key: string;
  /** El pedido de la cola detrás de la pieza. Null en lo que se hizo a mano. */
  jobId: string | null;
  avatarSlug: string;
  avatarName: string | null;
  /** Nombre del carrusel: es lo único que identifica a una pieza sin referente. */
  title: string | null;
  referenceUrl: string;
  /** Estado del pedido. "" cuando no hay pedido detrás. */
  status: string;
  carouselId: string | null;
  /** "4:5", "1:1"… Solo se pinta en los hermanos de resize, donde distingue duplicados. */
  aspectRatio?: string;
  /** Id del carrusel original si esta pieza nació de "Generar otros tamaños". */
  resizedFrom?: string;
  /**
   * De quién es la pieza, para los perfiles de `/equipo`. Sale del pedido o de la entrada
   * manual — el carrusel no lo guarda —, así que `null` significa "no atribuible a nadie"
   * (creada desde el home, o un hermano de resize), no "de nadie".
   */
  ownerId?: string | null;
  /** Solo en `archived`: cuándo pasó a la Biblioteca. */
  archivedAt?: string;
  updatedAt: string;
  /**
   * ¿Puede la sesión actual restaurar este eliminado? La Biblioteca muestra las piezas de
   * todo el equipo, pero el POST de restore solo acepta las propias: sin esto, el botón
   * aparecería en filas ajenas y devolvería 403 al apretarlo.
   */
  canRestore?: boolean;
}

/** En qué sección de la carpeta cae una pieza. `null` = no pertenece a la Biblioteca. */
export type LibraryBucket = "entregado" | "eliminado" | "suelto";

/** Una carpeta = un avenger, con todo lo suyo repartido en secciones. */
export interface AvengerFolder {
  /** Clave estable para la URL (`/biblioteca?avenger=…`): el slug del avatar. */
  key: string;
  /** Nombre para mostrar, ya sin el prefijo "30X —". */
  name: string;
  entregados: LibraryItem[];
  eliminados: LibraryItem[];
  /** Piezas sin pedido detrás: las hechas a mano, las del home, los otros tamaños. */
  sueltos: LibraryItem[];
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

/**
 * A qué sección de su carpeta va la pieza, o `null` si no le toca estar en la Biblioteca.
 *
 * Una pieza SIN pedido siempre entra: no hay nada que pueda estar en curso, así que no
 * puede aparecer también en el tablero. Una pieza CON pedido solo entra si el pedido ya
 * se asentó (entregado o eliminado); mientras el pedido vive en el tablero, mostrarlo acá
 * pondría el mismo trabajo en dos lugares con acciones distintas.
 */
export function bucketOf(item: LibraryItem): LibraryBucket | null {
  if (!item.jobId) return "suelto";
  if (isEntregado(item.status)) return "entregado";
  if (isEliminado(item.status)) return "eliminado";
  return null;
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

/** Cuántas piezas hay en la carpeta, contando las tres secciones. */
export function folderTotal(folder: AvengerFolder): number {
  return folder.entregados.length + folder.eliminados.length + folder.sueltos.length;
}

/** "1 entregado" / "4 entregados": los contadores de una carpeta llegan a 1 seguido. */
export function plural(n: number, singular: string, muchos: string): string {
  return `${n} ${n === 1 ? singular : muchos}`;
}

/**
 * Reparte las piezas en carpetas por avenger.
 *
 * Qué entra y qué no lo decide `bucketOf`. Las carpetas salen ordenadas alfabéticamente
 * (una carpeta se busca por nombre, no por recencia) y los ítems de cada una de lo más
 * nuevo a lo más viejo.
 */
export function buildAvengerFolders(items: readonly LibraryItem[]): AvengerFolder[] {
  const byKey = new Map<string, AvengerFolder>();

  for (const item of items) {
    const bucket = bucketOf(item);
    if (!bucket) continue;

    const key = item.avatarSlug || SIN_AVATAR_KEY;
    const folder = byKey.get(key) ?? {
      key,
      name: shortAvatar(item.avatarName, item.avatarSlug),
      entregados: [],
      eliminados: [],
      sueltos: [],
      coverCarouselId: null,
      lastActivityAt: "",
    };
    if (!byKey.has(key)) byKey.set(key, folder);

    if (bucket === "entregado") folder.entregados.push(item);
    else if (bucket === "eliminado") folder.eliminados.push(item);
    else folder.sueltos.push(item);
  }

  return [...byKey.values()]
    .map((folder) => {
      const entregados = sortByDateDesc(folder.entregados);
      const eliminados = sortByDateDesc(folder.eliminados);
      const sueltos = sortByDateDesc(folder.sueltos);
      // La portada prefiere lo entregado, después lo suelto y recién al final lo
      // eliminado: una carpeta que se presenta con lo que su dueña descartó cuenta la
      // historia al revés.
      const cover =
        entregados.find((i) => i.carouselId) ??
        sueltos.find((i) => i.carouselId) ??
        eliminados.find((i) => i.carouselId) ??
        null;
      const fechas = [...entregados, ...eliminados, ...sueltos].map(itemDate).filter(Boolean);
      return {
        ...folder,
        entregados,
        eliminados,
        sueltos,
        coverCarouselId: cover?.carouselId ?? null,
        lastActivityAt: fechas.length ? fechas.reduce((a, b) => (a > b ? a : b)) : "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

function sortByDateDesc(items: readonly LibraryItem[]): LibraryItem[] {
  return [...items].sort((a, b) => itemDate(b).localeCompare(itemDate(a)));
}
