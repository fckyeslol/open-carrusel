/**
 * Los perfiles del equipo de diseño: quién es cada una y qué tiene.
 *
 * Es la vista que cruza el scope por diseñadora, así que vive detrás de `admin.ts`. El
 * resto de la app le muestra a cada diseñadora lo suyo; acá se ve el equipo entero, una
 * carpeta por persona, para poder entrar a su trabajo y editarlo.
 *
 * **Lo que esta vista NO puede saber:** de quién es un carrusel. El carrusel no guarda
 * dueño; la única forma de atribuirlo es el pedido que lo generó (`Assignment.designerId`)
 * o la entrada manual que lo lanzó (`ManualEntry.designerId`). Una pieza sin ninguno de los
 * dos —creada desde el home, o un hermano de "Generar otros tamaños"— no entra en ningún
 * perfil. Por eso el roster informa cuántas quedaron sin dueño en vez de repartirlas con
 * una corazonada: un perfil que se inventa piezas es peor que uno incompleto, porque nadie
 * lo puede auditar. Cerrar ese hueco pide guardarle `designerId` al carrusel.
 *
 * El agrupado y el conteo son puros a partir de los ítems ya armados por `library.ts`, para
 * no volver a leer los mismos cuatro archivos por diseñadora.
 */
import { bucketOf, type LibraryItem } from "./library-folders";
import type { User } from "./users";

/** Una diseñadora en la reja de `/equipo`. */
export interface TeamMember {
  id: string;
  username: string;
  displayName: string;
  /** Piezas terminadas (entregadas) que se le pueden atribuir. */
  entregados: number;
  /** Piezas que hizo por fuera de la cola. */
  aMano: number;
  /** Pedidos que mandó a la Biblioteca. */
  eliminados: number;
  /** Pedidos que todavía viven en su tablero (generando, por revisar, con problemas). */
  enCurso: number;
  /** Total atribuible, para ordenar y para el resumen de la tarjeta. */
  total: number;
  /** Portada de la carpeta: su pieza más reciente que tenga algo para mostrar. */
  coverCarouselId: string | null;
  /** Última actividad, en ISO. "" si no tiene nada. */
  lastActivityAt: string;
}

export interface TeamRoster {
  members: TeamMember[];
  /**
   * Piezas que existen pero no son de nadie (ver el comentario de arriba). Se informa el
   * número para que el faltante sea visible en la UI y no un silencio.
   */
  sinDueno: number;
}

/**
 * Reparte los ítems entre las usuarias.
 *
 * Van TODAS las usuarias, incluso las que no tienen nada — mismo criterio que
 * `/revisiones`: un cero explícito es información, una fila ausente se lee como si esa
 * persona no existiera.
 */
export function buildTeamRoster(
  users: readonly User[],
  items: readonly LibraryItem[]
): TeamRoster {
  const porDuena = new Map<string, LibraryItem[]>();
  let sinDueno = 0;

  for (const item of items) {
    if (!item.ownerId) {
      sinDueno++;
      continue;
    }
    const previas = porDuena.get(item.ownerId);
    if (previas) previas.push(item);
    else porDuena.set(item.ownerId, [item]);
  }

  const members = users
    .map((u) => resumir(u, porDuena.get(u.id) ?? []))
    // Primero quien más trabajo tiene atribuido, y el nombre como desempate para que las
    // que están en cero no queden ordenadas al azar entre sí.
    .sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName, "es"));

  return { members, sinDueno };
}

function resumir(user: User, items: readonly LibraryItem[]): TeamMember {
  let entregados = 0;
  let aMano = 0;
  let eliminados = 0;
  let enCurso = 0;

  for (const item of items) {
    const bucket = bucketOf(item);
    if (bucket === "entregado") entregados++;
    else if (bucket === "suelto") aMano++;
    else if (bucket === "eliminado") eliminados++;
    // `bucketOf` devuelve null para el pedido que sigue vivo en el tablero de su dueña.
    else enCurso++;
  }

  const conCarrusel = [...items]
    .filter((i) => i.carouselId)
    .sort((a, b) => fechaDe(b).localeCompare(fechaDe(a)));
  const fechas = items.map(fechaDe).filter(Boolean);

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    entregados,
    aMano,
    eliminados,
    enCurso,
    total: items.length,
    coverCarouselId: conCarrusel[0]?.carouselId ?? null,
    lastActivityAt: fechas.length ? fechas.reduce((a, b) => (a > b ? a : b)) : "",
  };
}

/**
 * La fecha que ordena. No usa `itemDate` de library-folders a propósito: ahí la fecha de
 * archivado gana, porque la Biblioteca ordena por "cuándo pasó a la Biblioteca". Acá lo
 * que importa es cuándo se tocó la pieza por última vez.
 */
function fechaDe(item: LibraryItem): string {
  return item.updatedAt || item.archivedAt || "";
}
