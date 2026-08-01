/**
 * Armado de la Biblioteca: de dónde salen las piezas que se agrupan por avenger.
 *
 * La Biblioteca se construía leyendo SOLO las asignaciones (`thirtyx-assignments.json`), y
 * eso la volvía incompleta de una forma difícil de notar: los carruseles seguían ahí, el
 * home los listaba, pero la Biblioteca no tenía forma de nombrarlos. Todo lo que no nace
 * de la cola no tiene `Assignment` — lo que se hace pegando una URL en /30x, lo que se
 * crea desde el home, y cada hermano de "Generar otros tamaños" (que además nace con
 * `prewaveJobId: undefined` a propósito) — así que quedaba afuera. En los datos con los
 * que se encontró el problema eran 60 de 72 carruseles.
 *
 * Así que la unidad pasó a ser el CARRUSEL, que es lo que la diseñadora busca cuando
 * entra acá, y la asignación pasó a ser lo que le agrega estado (entregado / eliminado) a
 * la pieza cuando existe. Se conservan también las asignaciones asentadas que nunca
 * llegaron a crear carrusel: son historial y antes sí se veían.
 *
 * El armado vive del lado del server porque necesita tres archivos (carruseles,
 * asignaciones, presets) y el de carruseles es el más grande del proyecto; el agrupado en
 * carpetas sigue siendo puro en `library-folders.ts`.
 */
import { listAssignments, type Assignment } from "./assignments";
import { listCarousels } from "./carousels";
import { listAvatarPresets } from "./style-presets";
import type { LibraryItem } from "./library-folders";
import type { Carousel } from "@/types/carousel";

/**
 * Arma las piezas de la Biblioteca.
 *
 * `designerId` NO filtra: la Biblioteca muestra el trabajo de todo el equipo, igual que
 * el home, porque el carrusel no guarda de quién es y filtrar por la asignación es
 * justamente lo que hacía desaparecer piezas. Solo decide quién ve el botón Restaurar,
 * que sí está scopeado del lado del server (`POST …/restore` responde 403 si el pedido no
 * es tuyo). `null` = modo local, donde no hay sesión y ese POST no chequea nada.
 */
export async function buildLibraryItems(designerId: string | null): Promise<LibraryItem[]> {
  const [carousels, assignments, presets] = await Promise.all([
    listCarousels(),
    listAssignments(),
    listAvatarPresets(),
  ]);

  const nombrePorSlug = new Map(
    presets
      .filter((p) => p.avatarSlug)
      .map((p) => [p.avatarSlug!.toLowerCase(), p.name] as const)
  );
  const avatarName = (slug: string | undefined): string | null =>
    slug ? nombrePorSlug.get(slug.toLowerCase()) ?? null : null;

  const puedeRestaurar = (a: Assignment): boolean =>
    designerId === null || a.designerId === designerId;

  const asignacionDe = emparejar(carousels, assignments);
  const items: LibraryItem[] = [];
  const jobsUsados = new Set<string>();

  for (const c of carousels) {
    const a = asignacionDe.get(c.id);
    if (a) jobsUsados.add(a.jobId);

    items.push({
      key: c.id,
      jobId: a?.jobId ?? null,
      // El slug del carrusel manda: es el que la pieza tiene grabado. El de la
      // asignación es el respaldo para los carruseles viejos, creados antes de que la
      // ingesta lo guardara.
      avatarSlug: c.avatarSlug || a?.avatarSlug || "",
      avatarName: avatarName(c.avatarSlug) ?? a?.avatarName ?? null,
      title: c.name || null,
      referenceUrl: c.referenceUrl || a?.referenceUrl || "",
      status: a?.status ?? "",
      carouselId: c.id,
      aspectRatio: c.aspectRatio,
      ...(c.resizedFrom ? { resizedFrom: c.resizedFrom } : {}),
      ...(a?.archivedAt ? { archivedAt: a.archivedAt } : {}),
      updatedAt: c.updatedAt || c.createdAt,
      ...(a ? { canRestore: puedeRestaurar(a) } : {}),
    });
  }

  // Los pedidos que no quedaron emparejados con ninguna pieza: los que se eliminaron
  // antes de generar, y también los que apuntan a un carrusel que después se borró (hay
  // uno así en los datos con los que se probó esto). Son historial y antes se veían, así
  // que sacarlos ahora sería cambiar una pérdida por otra. `carouselId` va en null aunque
  // el pedido tenga uno grabado: si no está en el store, el link a la pieza es un 404 y
  // la miniatura queda rota.
  for (const a of assignments) {
    if (jobsUsados.has(a.jobId)) continue;
    items.push({
      key: a.jobId,
      jobId: a.jobId,
      avatarSlug: a.avatarSlug || "",
      avatarName: avatarName(a.avatarSlug) ?? a.avatarName,
      title: null,
      referenceUrl: a.referenceUrl || "",
      status: a.status,
      carouselId: null,
      ...(a.archivedAt ? { archivedAt: a.archivedAt } : {}),
      updatedAt: a.updatedAt,
      canRestore: puedeRestaurar(a),
    });
  }

  return items;
}

/**
 * Qué pedido le corresponde a cada carrusel. **Como máximo uno cada uno, en los dos
 * sentidos.**
 *
 * La exclusividad es el punto de esta función, y cuesta verla hasta que uno mira los
 * datos: un "Reintentar" o un "Regenerar desde 0" crea un carrusel NUEVO para el mismo
 * pedido, y el carrusel viejo se queda con su `prewaveJobId` grabado. En los datos con
 * los que se probó esto, 5 pedidos tenían hasta 3 carruseles apuntándoles. Emparejar por
 * `prewaveJobId` a secas hacía que el mismo entregado saliera dos o tres veces en la
 * carpeta, con la misma fecha y el mismo referente — que es peor que perderlo, porque no
 * hay forma de saber cuál abrir.
 *
 * Así que manda el `carouselId` de la asignación: es la pieza que quedó como resultado del
 * pedido. `prewaveJobId` es solo el respaldo para los pedidos que no apuntan a ninguna
 * (generaciones viejas, anteriores al checkpoint), y ahí gana el carrusel más reciente.
 * Los intentos anteriores caen como piezas sueltas: siguen estando, se pueden abrir, pero
 * no se hacen pasar por el entregado.
 */
function emparejar(
  carousels: readonly Carousel[],
  assignments: readonly Assignment[]
): Map<string, Assignment> {
  const porCarrusel = new Map<string, Assignment>();
  const sinPieza = new Map<string, Assignment>();
  for (const a of assignments) {
    if (a.carouselId) porCarrusel.set(a.carouselId, a);
    else sinPieza.set(a.jobId, a);
  }

  // Un hermano de resize nunca reclama el pedido del original: es un derivado del mismo
  // trabajo, no la pieza que se entregó (de hecho `createResizedSibling` le borra el
  // `prewaveJobId` justamente por eso; el filtro cubre a los que se crearon antes).
  const candidatos = carousels
    .filter((c) => !c.resizedFrom && c.prewaveJobId && !porCarrusel.has(c.id))
    .sort((x, y) => fechaDe(y).localeCompare(fechaDe(x)));

  for (const c of candidatos) {
    const a = sinPieza.get(c.prewaveJobId!);
    if (!a) continue;
    porCarrusel.set(c.id, a);
    sinPieza.delete(a.jobId); // un pedido, una pieza
  }

  return porCarrusel;
}

function fechaDe(c: Carousel): string {
  return c.updatedAt || c.createdAt || "";
}
