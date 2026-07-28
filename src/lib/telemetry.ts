/**
 * TELEMETRÍA — eventos estructurados y contadores en memoria.
 *
 * Antes de esto no se podía responder ninguna de estas preguntas: ¿cuántas veces se
 * preemptó un pedido?, ¿cuánto esperan en la cola?, ¿falló algún render y por qué?, ¿cuánto
 * tarda un render? En un server hosteado sin los logs a mano, "anda lento" o "no salió" no
 * tenía forma de diagnosticarse.
 *
 * Dos salidas, a propósito:
 *
 *  1. **Una línea JSON por evento a stdout.** Cloud Run las ingiere solas y quedan
 *     consultables en Cloud Logging (`jsonPayload.evento="preempcion"`). Es la fuente para
 *     mirar hacia atrás.
 *  2. **Contadores en memoria** (`GET /api/queue`). Es la foto de AHORA, sin salir a
 *     Logging. Se reinician con el proceso a propósito: no son contabilidad, son un
 *     termómetro.
 *
 * Por qué no una librería de logging: la app ya escribe a stdout y Cloud Run ya estructura
 * el JSON. Una dependencia más no agrega nada que no tengamos.
 *
 * ⚠️ NUNCA meter secretos ni HTML de láminas acá. Los eventos van a Cloud Logging, que tiene
 * otra política de retención y de acceso que el store.
 */

/** Nombres de evento. Cerrado a propósito: si no está acá, no se emite. */
export type EventoTipo =
  | "cola.encolado"
  | "cola.arranque"
  | "cola.fin"
  | "cola.preempcion"
  | "cola.cancelacion"
  | "render.ok"
  | "render.fallo"
  | "generacion.pasada"
  | "generacion.checkpoint";

interface Contadores {
  encolados: number;
  arrancados: number;
  completados: number;
  preempciones: number;
  cancelaciones: number;
  rendersOk: number;
  rendersFallidos: number;
  /** Suma de esperas en cola, para poder sacar el promedio sin guardar cada muestra. */
  esperaTotalMs: number;
  esperaMuestras: number;
  esperaMaxMs: number;
  /** Ídem para la duración de los renders. */
  renderTotalMs: number;
  renderMuestras: number;
  renderMaxMs: number;
  /** Últimos fallos de render, para diagnosticar sin ir a Cloud Logging. */
  ultimosFallosRender: { cuando: string; motivo: string }[];
  desde: string;
}

function vacios(): Contadores {
  return {
    encolados: 0,
    arrancados: 0,
    completados: 0,
    preempciones: 0,
    cancelaciones: 0,
    rendersOk: 0,
    rendersFallidos: 0,
    esperaTotalMs: 0,
    esperaMuestras: 0,
    esperaMaxMs: 0,
    renderTotalMs: 0,
    renderMuestras: 0,
    renderMaxMs: 0,
    ultimosFallosRender: [],
    desde: new Date().toISOString(),
  };
}

/** En `globalThis` por lo mismo que el carril y los mutexes: un solo registro por proceso. */
const g = globalThis as unknown as { __ocTelemetria?: Contadores };
function contadores(): Contadores {
  return (g.__ocTelemetria ??= vacios());
}

/** Cuántos fallos de render se recuerdan. Suficiente para ver un patrón, no un log. */
const MAX_FALLOS_RECORDADOS = 10;

/**
 * Emite un evento estructurado.
 *
 * `severity` es el campo que Cloud Logging usa para colorear y filtrar por nivel; el resto
 * del objeto queda en `jsonPayload`.
 */
export function evento(
  tipo: EventoTipo,
  datos: Record<string, unknown> = {},
  nivel: "INFO" | "WARNING" | "ERROR" = "INFO"
): void {
  // Los contadores se siguen actualizando; lo único que se calla es la línea a stdout.
  // Sin esto, los tests del carril escupen una decena de líneas JSON entre los resultados.
  if (process.env.OC_TELEMETRY_SILENT === "1") return;
  const linea = JSON.stringify({
    severity: nivel,
    evento: tipo,
    ts: new Date().toISOString(),
    ...datos,
  });
  if (nivel === "ERROR") console.error(linea);
  else if (nivel === "WARNING") console.warn(linea);
  else console.log(linea);
}

/** Un trabajo entró a la cola. `espera` se mide desde acá hasta que arranca. */
export function colaEncolado(id: string, prioridad: number, puesto: number): void {
  contadores().encolados++;
  evento("cola.encolado", { id, prioridad, puesto });
}

/** Un trabajo tomó el carril. `esperaMs` es lo que estuvo en la fila. */
export function colaArranque(id: string, prioridad: number, esperaMs: number): void {
  const c = contadores();
  c.arrancados++;
  c.esperaTotalMs += esperaMs;
  c.esperaMuestras++;
  if (esperaMs > c.esperaMaxMs) c.esperaMaxMs = esperaMs;
  evento("cola.arranque", { id, prioridad, esperaMs });
}

/** Un trabajo terminó (bien o mal), con cuánto duró. */
export function colaFin(id: string, duracionMs: number, ok: boolean, motivo?: string): void {
  contadores().completados++;
  evento("cola.fin", { id, duracionMs, ok, motivo }, ok ? "INFO" : "WARNING");
}

/**
 * Un trabajo cedió el carril. Es EL evento a vigilar: si aparece seguido sobre el mismo id,
 * la política de preempción está haciendo thrash y hay que subir el quantum o la retención.
 */
export function colaPreempcion(
  id: string,
  porQuien: string,
  vecesPreemptado: number,
  corrioMs: number
): void {
  contadores().preempciones++;
  evento(
    "cola.preempcion",
    { id, porQuien, vecesPreemptado, corrioMs },
    // Al acercarse al tope el job corre riesgo de no terminar nunca: subir el nivel.
    vecesPreemptado >= 2 ? "WARNING" : "INFO"
  );
}

export function colaCancelacion(id: string, estaba: "en_fila" | "activo"): void {
  contadores().cancelaciones++;
  evento("cola.cancelacion", { id, estaba });
}

/** Un render salió bien. `remoto` distingue el servicio del render en proceso. */
export function renderOk(ms: number, remoto: boolean, bytes: number): void {
  const c = contadores();
  c.rendersOk++;
  c.renderTotalMs += ms;
  c.renderMuestras++;
  if (ms > c.renderMaxMs) c.renderMaxMs = ms;
  evento("render.ok", { ms, remoto, bytes });
}

/**
 * Un render falló. Se guardan los últimos para poder diagnosticar desde `/api/queue` sin
 * abrir Cloud Logging — que es justo lo que no se podía hacer antes.
 */
export function renderFallo(motivo: string, remoto: boolean, intentos: number): void {
  const c = contadores();
  c.rendersFallidos++;
  c.ultimosFallosRender.unshift({ cuando: new Date().toISOString(), motivo: motivo.slice(0, 300) });
  c.ultimosFallosRender.length = Math.min(c.ultimosFallosRender.length, MAX_FALLOS_RECORDADOS);
  evento("render.fallo", { motivo: motivo.slice(0, 500), remoto, intentos }, "ERROR");
}

/** Una pasada de generación terminó: cuántas láminas sumó y cómo salió. */
export function generacionPasada(
  jobId: string,
  pasada: number,
  laminasAntes: number,
  laminasDespues: number,
  exitCode: number | null,
  preemptada: boolean
): void {
  evento("generacion.pasada", {
    jobId,
    pasada,
    laminasAntes,
    laminasDespues,
    sumo: laminasDespues - laminasAntes,
    exitCode,
    preemptada,
  });
}

/** Se guardó un checkpoint: con esto se puede reconstruir por qué un job retomó donde retomó. */
export function generacionCheckpoint(
  jobId: string,
  carouselId: string,
  pasadas: number,
  stalls: number,
  preempciones: number
): void {
  evento("generacion.checkpoint", { jobId, carouselId, pasadas, stalls, preempciones });
}

export interface ResumenTelemetria {
  desde: string;
  cola: {
    encolados: number;
    arrancados: number;
    completados: number;
    preempciones: number;
    cancelaciones: number;
    esperaPromedioMs: number | null;
    esperaMaxMs: number;
  };
  render: {
    ok: number;
    fallidos: number;
    tasaFallo: number | null;
    duracionPromedioMs: number | null;
    duracionMaxMs: number;
    ultimosFallos: { cuando: string; motivo: string }[];
  };
}

/** Foto de los contadores, para `GET /api/queue`. */
export function resumen(): ResumenTelemetria {
  const c = contadores();
  const total = c.rendersOk + c.rendersFallidos;
  return {
    desde: c.desde,
    cola: {
      encolados: c.encolados,
      arrancados: c.arrancados,
      completados: c.completados,
      preempciones: c.preempciones,
      cancelaciones: c.cancelaciones,
      esperaPromedioMs: c.esperaMuestras ? Math.round(c.esperaTotalMs / c.esperaMuestras) : null,
      esperaMaxMs: c.esperaMaxMs,
    },
    render: {
      ok: c.rendersOk,
      fallidos: c.rendersFallidos,
      tasaFallo: total ? Number((c.rendersFallidos / total).toFixed(3)) : null,
      duracionPromedioMs: c.renderMuestras
        ? Math.round(c.renderTotalMs / c.renderMuestras)
        : null,
      duracionMaxMs: c.renderMaxMs,
      ultimosFallos: c.ultimosFallosRender,
    },
  };
}

/** Solo para tests. */
export function resetTelemetriaParaTests(): void {
  g.__ocTelemetria = vacios();
}
