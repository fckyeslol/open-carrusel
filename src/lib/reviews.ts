/**
 * Contador de REVISIONES por diseñadora (data/thirtyx-reviews.json).
 *
 * El tablero ya sabe cuántos carruseles se ENTREGARON, pero entregar no es revisar: una
 * diseñadora puede pasarse la mañana abriendo borradores, corrigiendo láminas y mandando
 * varios a regenerar sin entregar ninguno. Ese trabajo no dejaba rastro en ningún lado.
 * Este store lo mide: cuántos carruseles miró cada una en el día.
 *
 * La marca es IDEMPOTENTE por (diseñadora, pedido, día). Un contador que sumara por click
 * sería trivial de inflar y no se podría auditar; acá cada marca guarda DE QUÉ PEDIDO
 * salió, así que el número siempre se puede desarmar en la lista que lo produjo. Volver a
 * apretar el mismo día no suma. Revisar el mismo pedido MAÑANA sí, porque es trabajo
 * nuevo: el borrador cambió, o volvió de una regeneración.
 *
 * El "día" es el día LOCAL DEL SERVER, igual que la ventana del lote nocturno
 * (batch-scheduler.ts). El deploy corre con TZ=America/Bogota — de ahí el tzdata del
 * Dockerfile —, así que "hoy" es el hoy de las diseñadoras y no el de UTC.
 */
import { readDataSafe, updateData, SKIP_WRITE } from "./data";

const FILE = "thirtyx-reviews.json";

/**
 * Cuántos días de marcas se conservan. El dashboard mira ventanas de días o semanas, no
 * de meses; más allá de esto son bytes que se leen enteros en cada marca y que nadie
 * consulta. Se podan al escribir, que es cuando ya tenemos el archivo en la mano.
 */
const RETENTION_DAYS = 120;

/** Ventanas que el dashboard ofrece. El API valida contra esta lista. */
export const RANGE_DAYS: readonly number[] = [7, 14, 30];

export interface ReviewMark {
  designerId: string;
  /** El `jobId` de la asignación revisada: hace la marca idempotente y auditable. */
  jobId: string;
  /** Día local del server (YYYY-MM-DD). */
  day: string;
  /** ISO del momento en que se marcó por primera vez ese día. */
  at: string;
}

interface Store {
  marks: ReviewMark[];
}

const EMPTY: Store = { marks: [] };

/**
 * Día local en YYYY-MM-DD. Se arma con los getters locales a propósito: `toISOString()`
 * devuelve UTC y a las 19:00 de Bogotá ya sería el día siguiente, lo que partiría en dos
 * la tarde de trabajo de una diseñadora.
 */
export function localDay(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Corre una fecha `delta` días. Se construye desde los componentes locales (y no restando
 * milisegundos) para que el cruce de mes y de año lo haga el propio Date.
 */
function shiftDay(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

/** Los últimos `count` días terminando en `from`, del más viejo al más nuevo. */
export function recentDays(count: number, from: Date = new Date()): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) days.push(localDay(shiftDay(from, -i)));
  return days;
}

/**
 * Anota que `designerId` revisó `jobId`. Devuelve si ESTA llamada fue la que contó, para
 * que quien la invoque sepa distinguir "primera vez" de "ya estaba marcado" sin volver a
 * leer el store.
 *
 * El chequeo de duplicado va DENTRO de `updateData` (no antes) porque es ahí donde el
 * mutex serializa: dos pestañas apretando el botón a la vez leerían las dos un store sin
 * la marca y escribirían dos.
 */
export async function markReviewed(
  designerId: string,
  jobId: string,
  at: Date = new Date()
): Promise<{ counted: boolean; day: string }> {
  const day = localDay(at);
  const cutoff = localDay(shiftDay(at, -RETENTION_DAYS));
  let counted = false;

  await updateData<Store>(FILE, EMPTY, (store) => {
    const yaEsta = store.marks.some(
      (m) => m.designerId === designerId && m.jobId === jobId && m.day === day
    );
    if (yaEsta) return SKIP_WRITE;
    counted = true;
    return {
      // Las fechas en YYYY-MM-DD ordenan bien como strings, así que la poda es un filtro.
      marks: [
        ...store.marks.filter((m) => m.day >= cutoff),
        { designerId, jobId, day, at: at.toISOString() },
      ],
    };
  });

  return { counted, day };
}

/**
 * Los `jobId` que una diseñadora marcó en un día. La UI lo usa para pintar el botón ya
 * apretado al recargar: sin esto, "Revisado" volvería a verse sin marcar en cada refresh
 * y la diseñadora no sabría cuáles ya contó.
 */
export async function listReviewedOn(
  designerId: string,
  day: string = localDay()
): Promise<string[]> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  return store.marks
    .filter((m) => m.designerId === designerId && m.day === day)
    .map((m) => m.jobId);
}

/**
 * Conteo por diseñadora para una ventana de días, alineado con el array `days` que se
 * pasa: `counts[i]` corresponde a `days[i]`. Devolver la serie completa (y no solo el
 * total) es lo que permite dibujar la evolución sin una segunda consulta.
 *
 * Solo aparecen las diseñadoras que tienen al menos una marca en la ventana; completar
 * con las que no revisaron nada es tarea de quien tiene la lista de usuarias.
 */
export async function countsByDesigner(
  days: readonly string[]
): Promise<Map<string, number[]>> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  const index = new Map(days.map((d, i) => [d, i] as const));
  const counts = new Map<string, number[]>();

  for (const mark of store.marks) {
    const i = index.get(mark.day);
    if (i === undefined) continue;
    let serie = counts.get(mark.designerId);
    if (!serie) {
      serie = new Array<number>(days.length).fill(0);
      counts.set(mark.designerId, serie);
    }
    serie[i] += 1;
  }

  return counts;
}
