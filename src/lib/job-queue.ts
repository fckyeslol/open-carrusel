/**
 * EL CARRIL DE TRABAJOS — un solo carril global serializado, con prioridad y preempción.
 *
 * Antes había tres dominios de concurrencia que no se hablaban: el runner de la cola 30x
 * (4 jobs en paralelo), /api/chat (un subproceso Claude por POST, sin tope) y el resize
 * (sin coordinación entre carruseles). Cada generación levanta un subproceso Claude y
 * antes también su propio Chrome, así que "4 en paralelo" era en realidad "4 × todo".
 *
 * Acá TODO lo pesado pasa por un único carril de concurrencia 1 (QUEUE_LANE_SIZE).
 *
 * ⚠️ INVARIANTE ANTI-DEADLOCK, lo más importante de este archivo:
 *
 *     El carril se adquiere SOLO en el nivel más externo — una generación completa.
 *
 * El trabajo anidado que dispara el agente desde ADENTRO de un job (las llamadas a
 * /api/.../review y a /export, que renderizan láminas) NO debe pedir lugar en el carril:
 * usa el seam de render, que tiene su propio tope. Si el review pidiera carril, el job que
 * ya lo tiene esperaría su propia llamada y se trabaría para siempre.
 *
 * El registro vive en `globalThis` (igual que los mutexes de data.ts y el runner) para
 * sobrevivir al HMR de dev y para que una instancia duplicada del módulo no cree un
 * segundo carril, que anularía todo el propósito.
 */

/**
 * Prioridades. MENOR = más urgente.
 *
 * El orden es `(priority, enqueuedAt)`: FIFO dentro de cada prioridad. A propósito NO hay
 * envejecimiento: sería otra perilla que puede hacer que el batch le pase por encima al
 * chat, y la protección contra inanición ya la da el tope de preempciones.
 */
export const PRIORITY = {
  /** Chat interactivo: hay una diseñadora esperando en la pantalla. */
  INTERACTIVE: 0,
  /** Job de la cola marcado como urgente a mano. */
  URGENT: 10,
  /** Job normal de la cola 30x. */
  NORMAL: 20,
  /** "Generar otros tamaños": deriva de un carrusel que ya existe, puede esperar. */
  RESIZE: 30,
} as const;

export type Priority = number;

/** Fases de un job, para decidir si se lo puede preemptar en este momento. */
export type JobPhase = "waiting" | "ingesting" | "generating" | "rendering" | "other";

/**
 * Qué fases se pueden preemptar.
 *
 *  - `ingesting` NO: dura ~60s y no es resumible; cortarla dejaría un carrusel a medio
 *    crear y al reanudar habría que crear otro.
 *  - `generating` SÍ: es el 90% del tiempo y es resumible (`--resume` de Claude sobre la
 *    misma sesión, con las láminas ya escritas en disco).
 *  - `rendering` SÍ: `exportAllSlides` va lámina por lámina y es idempotente.
 */
const PREEMPTIBLE_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>(["generating", "rendering"]);

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Cuánto debe haber corrido un job antes de poder ser preemptado. Evita el thrash.
 *
 * Configurable (QUEUE_MIN_QUANTUM_MS) por dos motivos: permite ajustar la política sin
 * recompilar, y los tests no pueden esperar un minuto real por cada caso.
 */
const MIN_QUANTUM_MS = envMs("QUEUE_MIN_QUANTUM_MS", 60_000);

/**
 * Cuántas veces puede ser preemptado un job antes de volverse INPREEMPTABLE.
 *
 * Es la garantía anti-inanición: sin esto, una diseñadora chateando toda la tarde podría
 * dejar un job de la cola sin avanzar nunca. Al llegar al tope, el job termina y recién
 * después entra el trabajo interactivo.
 */
const MAX_PREEMPTIONS = (() => {
  const raw = process.env.QUEUE_MAX_PREEMPTIONS;
  const n = raw ? parseInt(raw, 10) : 3;
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

/**
 * Gracia durante la cual una sesión interactiva conserva el carril tras terminar su turno.
 *
 * Sin esto, una conversación de ida y vuelta preemptaría al batch en CADA mensaje: el batch
 * reanuda, avanza unos segundos, y lo vuelven a preemptar. Puro thrash pagando el
 * cache-read del `--resume` cada vez.
 */
const STICKY_HOLD_MS = envMs("QUEUE_STICKY_HOLD_MS", 45_000);

/**
 * Cuántos trabajos pesados corren a la vez. Default 1: serializado.
 *
 * ⚠️ NO hereda de THIRTYX_MAX_CONCURRENT a propósito. Una versión anterior lo usaba como
 * fallback "por compatibilidad" y el efecto real era desastroso: `.env.local` y
 * `.env.example` traen THIRTYX_MAX_CONCURRENT=4, así que todos los installs existentes
 * habrían seguido corriendo 4 generaciones en paralelo y la serialización —el punto entero
 * de este cambio— no se habría aplicado en ninguna parte, en silencio.
 *
 * Subirlo requiere pedirlo explícitamente con QUEUE_LANE_SIZE.
 */
function laneSize(): number {
  const raw = process.env.QUEUE_LANE_SIZE;
  const n = raw ? parseInt(raw, 10) : 1;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 4);
}

function preemptionEnabled(): boolean {
  return process.env.QUEUE_PREEMPTION !== "0";
}

/**
 * Se lanza cuando un job es preemptado, para que el dueño sepa que debe re-encolarse.
 *
 * Los campos se declaran y asignan a mano en vez de usar parameter properties de TS: el
 * type stripping de Node (con el que corren los tests, sin dependencias) no las soporta.
 */
export class PreemptedError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super("Trabajo preemptado por otro de mayor prioridad");
    this.name = "PreemptedError";
    this.jobId = jobId;
  }
}

/** Se lanza cuando alguien cancela el trabajo a mano. */
export class CancelledError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super("Trabajo cancelado");
    this.name = "CancelledError";
    this.jobId = jobId;
  }
}

/** Lo que ve el trabajo mientras corre: cómo declarar fase y cómo saber que debe ceder. */
export interface JobControl {
  readonly id: string;
  readonly signal: AbortSignal;
  /** Declara en qué está el job. Cambia si se lo puede preemptar AHORA. */
  setPhase: (phase: JobPhase) => void;
  /** true si hay que rendir el carril: guardá checkpoint y salí. */
  shouldYield: () => boolean;
}

export interface SubmitOptions {
  /** Id estable (el jobId del assignment). Si se repite, se ignora el duplicado. */
  id: string;
  priority: Priority;
  /** Etiqueta para la UI. */
  label?: string;
  /**
   * Sesión "pegajosa": turnos consecutivos de la misma sesión de chat conservan el carril
   * un rato, en vez de devolverlo y volver a preemptar al batch en el mensaje siguiente.
   */
  stickyKey?: string;
  /** Cuántas veces ya fue preemptado (viene del checkpoint persistido). */
  preemptions?: number;
  /** Avisos de posición en la fila, para el SSE del chat. */
  onQueued?: (position: number) => void;
}

interface Entry {
  id: string;
  priority: Priority;
  label: string;
  stickyKey?: string;
  enqueuedAt: number;
  preemptions: number;
  run: (ctl: JobControl) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onQueued?: (position: number) => void;
}

interface Active {
  entry: Entry;
  startedAt: number;
  phase: JobPhase;
  controller: AbortController;
  /** Marcado cuando se decidió preemptarlo (para distinguirlo de un cancel). */
  preempting: boolean;
  cancelling: boolean;
}

interface Lane {
  queued: Entry[];
  active: Map<string, Active>;
  /** stickyKey → hasta cuándo conserva el carril. */
  stickyUntil: Map<string, number>;
}

const g = globalThis as unknown as { __ocJobLane?: Lane };

function lane(): Lane {
  if (!g.__ocJobLane) {
    g.__ocJobLane = { queued: [], active: new Map(), stickyUntil: new Map() };
  }
  return g.__ocJobLane;
}

/** Orden del carril: prioridad, y a igual prioridad el que llegó primero. */
function compare(a: Entry, b: Entry): number {
  return a.priority - b.priority || a.enqueuedAt - b.enqueuedAt;
}

/** ¿Cuántos lugares del carril están tomados, contando la retención pegajosa? */
function occupied(l: Lane): number {
  const now = Date.now();
  let sticky = 0;
  for (const [key, until] of l.stickyUntil) {
    if (until <= now) l.stickyUntil.delete(key);
    else sticky++;
  }
  // Una sesión pegajosa que ya está corriendo no cuenta dos veces.
  for (const a of l.active.values()) {
    if (a.entry.stickyKey && l.stickyUntil.has(a.entry.stickyKey)) sticky--;
  }
  return l.active.size + Math.max(0, sticky);
}

/**
 * ¿Se puede preemptar al activo `a` para que entre `incoming`?
 *
 * Las cuatro condiciones deben cumplirse; cada una tapa un fallo distinto:
 *  1. prioridad ESTRICTAMENTE mayor — dos jobs normales nunca se pelean el carril
 *  2. la fase actual es preemptible — no se corta una ingesta a medias
 *  3. ya corrió el quantum mínimo — sin esto, dos chats seguidos matan el batch al instante
 *  4. no llegó al tope de preempciones — garantía de que el batch termina alguna vez
 */
function canPreempt(a: Active, incoming: Entry): boolean {
  if (!preemptionEnabled()) return false;
  if (a.preempting || a.cancelling) return false;
  if (incoming.priority >= a.entry.priority) return false;
  if (!PREEMPTIBLE_PHASES.has(a.phase)) return false;
  if (Date.now() - a.startedAt < MIN_QUANTUM_MS) return false;
  if (a.entry.preemptions >= MAX_PREEMPTIONS) return false;
  return true;
}

/** Avisa a los que esperan su posición actual en la fila. */
function notifyPositions(l: Lane): void {
  l.queued.forEach((e, i) => e.onQueued?.(i + 1));
}

function pump(): void {
  const l = lane();
  l.queued.sort(compare);

  // 1) Arrancar lo que entre en los lugares libres.
  while (l.queued.length > 0 && occupied(l) < laneSize()) {
    const entry = l.queued.shift()!;
    start(entry);
  }

  // 2) Si quedó algo esperando, ver si vale preemptar a un activo por él.
  if (l.queued.length === 0) {
    notifyPositions(l);
    return;
  }
  const next = l.queued[0];
  // Se preempta al activo MENOS urgente que sea candidato.
  let victim: Active | null = null;
  for (const a of l.active.values()) {
    if (!canPreempt(a, next)) continue;
    if (!victim || a.entry.priority > victim.entry.priority) victim = a;
  }
  if (victim) {
    victim.preempting = true;
    // La retención pegajosa no debe frenar al que va a ocupar el lugar liberado.
    if (victim.entry.stickyKey) l.stickyUntil.delete(victim.entry.stickyKey);
    victim.controller.abort();
  }

  notifyPositions(l);
}

function start(entry: Entry): void {
  const l = lane();
  const controller = new AbortController();
  const active: Active = {
    entry,
    startedAt: Date.now(),
    phase: "other",
    controller,
    preempting: false,
    cancelling: false,
  };
  l.active.set(entry.id, active);

  const ctl: JobControl = {
    id: entry.id,
    signal: controller.signal,
    setPhase: (phase) => {
      active.phase = phase;
      // Cambiar de fase puede volver preemptable a este job: reevaluar la fila.
      if (PREEMPTIBLE_PHASES.has(phase)) queueMicrotask(pump);
    },
    shouldYield: () => active.preempting || active.cancelling,
  };

  void (async () => {
    try {
      const value = await entry.run(ctl);
      entry.resolve(value);
    } catch (e) {
      // Un abort nuestro se traduce al error tipado, así el dueño sabe si re-encolar
      // (preempción) o dar por terminado (cancelación).
      if (active.preempting) entry.reject(new PreemptedError(entry.id));
      else if (active.cancelling) entry.reject(new CancelledError(entry.id));
      else entry.reject(e as Error);
    } finally {
      l.active.delete(entry.id);
      // Retención pegajosa: solo si terminó por su cuenta. Un job preemptado no debe
      // conservar el carril que justo le acabamos de quitar.
      if (entry.stickyKey && !active.preempting && !active.cancelling) {
        l.stickyUntil.set(entry.stickyKey, Date.now() + STICKY_HOLD_MS);
        setTimeout(() => {
          const cur = lane();
          if ((cur.stickyUntil.get(entry.stickyKey!) ?? 0) <= Date.now()) {
            cur.stickyUntil.delete(entry.stickyKey!);
            pump();
          }
        }, STICKY_HOLD_MS + 50).unref?.();
      }
      pump();
    }
  })();
}

/**
 * Encola un trabajo y devuelve su resultado.
 *
 * Rechaza con `PreemptedError` si fue preemptado (el dueño debe re-encolar desde su
 * checkpoint) o con `CancelledError` si lo cancelaron a mano.
 */
export function submit<T>(
  run: (ctl: JobControl) => Promise<T>,
  opts: SubmitOptions
): Promise<T> {
  const l = lane();

  // Duplicados: ya está corriendo o esperando. No se encola dos veces el mismo job.
  if (l.active.has(opts.id) || l.queued.some((e) => e.id === opts.id)) {
    return Promise.reject(new Error(`El trabajo ${opts.id} ya está en la cola`));
  }

  return new Promise<T>((resolve, reject) => {
    const entry: Entry = {
      id: opts.id,
      priority: opts.priority,
      label: opts.label ?? opts.id,
      stickyKey: opts.stickyKey,
      enqueuedAt: Date.now(),
      preemptions: opts.preemptions ?? 0,
      run: run as (ctl: JobControl) => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
      onQueued: opts.onQueued,
    };
    l.queued.push(entry);
    pump();
  });
}

/**
 * Cambia la prioridad de un trabajo.
 *
 * Sirve para los dos casos: reordenar la fila, y volver urgente algo que YA está corriendo
 * (que no lo acelera, pero lo protege de ser preemptado). Reevalúa la preempción, así que
 * subirle la prioridad a un job en fila puede echar al activo si califica.
 */
export function setPriority(id: string, priority: Priority): boolean {
  const l = lane();
  const queued = l.queued.find((e) => e.id === id);
  if (queued) {
    queued.priority = priority;
    pump();
    return true;
  }
  const active = l.active.get(id);
  if (active) {
    active.entry.priority = priority;
    pump();
    return true;
  }
  return false;
}

/** Saca un trabajo de la fila, o aborta el activo. */
export function cancel(id: string): boolean {
  const l = lane();
  const i = l.queued.findIndex((e) => e.id === id);
  if (i >= 0) {
    const [entry] = l.queued.splice(i, 1);
    entry.reject(new CancelledError(id));
    pump();
    return true;
  }
  const active = l.active.get(id);
  if (active) {
    active.cancelling = true;
    active.controller.abort();
    return true;
  }
  return false;
}

export interface QueueSnapshotItem {
  id: string;
  label: string;
  priority: Priority;
  state: "active" | "queued";
  /** 1-based en la fila; null si está activo. */
  position: number | null;
  phase: JobPhase | null;
  /** Milisegundos corriendo (activo) o esperando (en fila). */
  elapsedMs: number;
  preemptions: number;
  preemptibleNow: boolean;
}

/** Estado del carril, para /api/queue y la UI. */
export function snapshot(): {
  laneSize: number;
  preemptionEnabled: boolean;
  items: QueueSnapshotItem[];
} {
  const l = lane();
  const now = Date.now();
  const items: QueueSnapshotItem[] = [];

  for (const a of l.active.values()) {
    items.push({
      id: a.entry.id,
      label: a.entry.label,
      priority: a.entry.priority,
      state: "active",
      position: null,
      phase: a.phase,
      elapsedMs: now - a.startedAt,
      preemptions: a.entry.preemptions,
      preemptibleNow:
        preemptionEnabled() &&
        PREEMPTIBLE_PHASES.has(a.phase) &&
        now - a.startedAt >= MIN_QUANTUM_MS &&
        a.entry.preemptions < MAX_PREEMPTIONS,
    });
  }

  [...l.queued].sort(compare).forEach((e, i) => {
    items.push({
      id: e.id,
      label: e.label,
      priority: e.priority,
      state: "queued",
      position: i + 1,
      phase: null,
      elapsedMs: now - e.enqueuedAt,
      preemptions: e.preemptions,
      preemptibleNow: false,
    });
  });

  return { laneSize: laneSize(), preemptionEnabled: preemptionEnabled(), items };
}

/** ¿Este trabajo está en el carril (activo o esperando)? */
export function isTracked(id: string): boolean {
  const l = lane();
  return l.active.has(id) || l.queued.some((e) => e.id === id);
}

/** Constantes expuestas para los tests y para explicar la política en la UI. */
export const LANE_TUNING = {
  MIN_QUANTUM_MS,
  MAX_PREEMPTIONS,
  STICKY_HOLD_MS,
  PREEMPTIBLE_PHASES,
} as const;

/**
 * Vacía el carril. SOLO PARA TESTS — el estado vive en `globalThis` para sobrevivir al HMR,
 * así que sin esto cada test heredaría la cola del anterior.
 */
export function resetLaneForTests(): void {
  const l = lane();
  for (const a of l.active.values()) a.controller.abort();
  l.queued.length = 0;
  l.active.clear();
  l.stickyUntil.clear();
}
