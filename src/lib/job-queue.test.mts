/**
 * Tests del carril de trabajos. Corren con el runner nativo de Node (sin dependencias):
 *
 *     npm test
 *
 * Node 24 stripea los tipos de TypeScript solo, así que se importa el .ts directo.
 *
 * ⚠️ El módulo se carga con `await import()` DESPUÉS de setear los env vars, no con un
 * `import` estático. Los imports de ESM se hoistean: con la forma estática, job-queue.ts se
 * cargaría ANTES de estas asignaciones, leería el quantum real de 60s y el test de
 * preempción esperaría para siempre a algo que no va a pasar.
 *
 * Bajar los tiempos es indispensable: probar "no preempta antes del quantum mínimo" con el
 * valor de producción costaría un minuto por caso.
 */
process.env.OC_TELEMETRY_SILENT = "1";
process.env.QUEUE_MIN_QUANTUM_MS = "80";
process.env.QUEUE_STICKY_HOLD_MS = "0";
process.env.QUEUE_LANE_SIZE = "1";
process.env.QUEUE_MAX_PREEMPTIONS = "2";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

// Resuelve los imports sin extensión de la app (job-queue.ts importa "./telemetry").
// Va antes del await import() de abajo, que es lo que carga el módulo bajo prueba.
import "./test-resolve.mts";

const {
  CancelledError,
  PRIORITY,
  PreemptedError,
  cancel,
  resetLaneForTests,
  setPriority,
  snapshot,
  submit,
} = await import("./job-queue.ts");

type JobControl = Parameters<Parameters<typeof submit>[0]>[0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Trabajo que avisa cuándo arrancó y que se puede terminar a voluntad.
 *
 * Sondea `shouldYield()` en un loop, igual que hace `generateAllSlides` entre pasadas:
 * ceder el carril es responsabilidad del trabajo, no algo que el carril pueda forzar.
 *
 * El loop DEBE terminar cuando el trabajo termina. Una versión anterior usaba un
 * `Promise.race` con un poller aparte que seguía girando después de resolver, y eso dejaba
 * el event loop vivo: `node --test` nunca salía y parecía un cuelgue de la cola.
 */
function controllable(opts: { phase?: "generating" | "ingesting" } = {}) {
  let done = false;
  let started!: () => void;
  const isRunning = new Promise<void>((r) => (started = r));

  const run = async (ctl: JobControl) => {
    ctl.setPhase(opts.phase ?? "generating");
    started();
    while (!done) {
      if (ctl.shouldYield()) throw new Error("yielded");
      await sleep(5);
    }
    return "ok";
  };

  return { run, release: () => void (done = true), isRunning };
}

afterEach(() => {
  resetLaneForTests();
});

describe("orden del carril", () => {
  it("corre uno a la vez cuando el carril es de tamaño 1", async () => {
    const a = controllable();
    const b = controllable();
    const pa = submit(a.run, { id: "a", priority: PRIORITY.NORMAL });
    const pb = submit(b.run, { id: "b", priority: PRIORITY.NORMAL });

    await a.isRunning;
    const s = snapshot();
    assert.equal(s.items.filter((i) => i.state === "active").length, 1);
    assert.equal(s.items.filter((i) => i.state === "queued").length, 1);

    a.release();
    await pa;
    b.release();
    await pb;
  });

  it("respeta la prioridad, y a igual prioridad es FIFO", async () => {
    const running = controllable();
    const pRunning = submit(running.run, { id: "ocupa", priority: PRIORITY.NORMAL });
    await running.isRunning;

    const orden: string[] = [];
    const mk = (id: string) => async () => {
      orden.push(id);
      return id;
    };
    // Se encolan a propósito en orden "equivocado" para que solo la prioridad decida.
    const p1 = submit(mk("normal-1"), { id: "normal-1", priority: PRIORITY.NORMAL });
    const p2 = submit(mk("resize"), { id: "resize", priority: PRIORITY.RESIZE });
    const p3 = submit(mk("urgente"), { id: "urgente", priority: PRIORITY.URGENT });
    const p4 = submit(mk("normal-2"), { id: "normal-2", priority: PRIORITY.NORMAL });

    running.release();
    await pRunning;
    await Promise.all([p1, p2, p3, p4]);

    assert.deepEqual(orden, ["urgente", "normal-1", "normal-2", "resize"]);
  });

  it("rechaza encolar el mismo id dos veces", async () => {
    const a = controllable();
    const pa = submit(a.run, { id: "dup", priority: PRIORITY.NORMAL });
    await a.isRunning;

    await assert.rejects(
      submit(async () => "x", { id: "dup", priority: PRIORITY.NORMAL }),
      /ya está en la cola/
    );

    a.release();
    await pa;
  });
});

describe("setPriority", () => {
  it("reordena la fila", async () => {
    const running = controllable();
    const pRunning = submit(running.run, { id: "ocupa", priority: PRIORITY.NORMAL });
    await running.isRunning;

    const orden: string[] = [];
    const mk = (id: string) => async () => {
      orden.push(id);
      return id;
    };
    const p1 = submit(mk("primero"), { id: "primero", priority: PRIORITY.NORMAL });
    const p2 = submit(mk("segundo"), { id: "segundo", priority: PRIORITY.NORMAL });

    // "segundo" pasa al frente.
    assert.equal(setPriority("segundo", PRIORITY.URGENT), true);

    running.release();
    await pRunning;
    await Promise.all([p1, p2]);

    assert.deepEqual(orden, ["segundo", "primero"]);
  });

  it("devuelve false para un id que no está en el carril", () => {
    assert.equal(setPriority("fantasma", PRIORITY.URGENT), false);
  });
});

describe("cancel", () => {
  it("saca de la fila con CancelledError", async () => {
    const running = controllable();
    const pRunning = submit(running.run, { id: "ocupa", priority: PRIORITY.NORMAL });
    await running.isRunning;

    let corrio = false;
    const pending = submit(
      async () => {
        corrio = true;
        return "no debería";
      },
      { id: "esperando", priority: PRIORITY.NORMAL }
    );

    assert.equal(cancel("esperando"), true);
    await assert.rejects(pending, (e: Error) => e instanceof CancelledError);
    assert.equal(corrio, false, "un trabajo cancelado en la fila no debe ejecutarse");

    running.release();
    await pRunning;
  });

  it("aborta el activo", async () => {
    const a = controllable();
    const pa = submit(a.run, { id: "activo", priority: PRIORITY.NORMAL });
    await a.isRunning;

    assert.equal(cancel("activo"), true);
    await assert.rejects(pa, (e: Error) => e instanceof CancelledError);
  });
});

describe("preempción", () => {
  it("NO preempta antes del quantum mínimo", async () => {
    const batch = controllable();
    const pBatch = submit(batch.run, { id: "batch", priority: PRIORITY.NORMAL });
    await batch.isRunning;

    // Sin esperar el quantum: el chat entra a la fila pero no echa a nadie.
    const pChat = submit(async () => "chat", { id: "chat", priority: PRIORITY.INTERACTIVE });
    await sleep(20);
    assert.equal(
      snapshot().items.find((i) => i.id === "batch")?.state,
      "active",
      "el batch no debería ser preemptado dentro del quantum mínimo"
    );

    batch.release();
    await pBatch;
    await pChat;
  });

  it("preempta cuando se cumplen todas las condiciones", async () => {
    const batch = controllable();
    const pBatch = submit(batch.run, { id: "batch", priority: PRIORITY.NORMAL });
    await batch.isRunning;
    await sleep(120); // pasa el quantum mínimo (80ms)

    const pChat = submit(async () => "chat", { id: "chat", priority: PRIORITY.INTERACTIVE });

    await assert.rejects(pBatch, (e: Error) => e instanceof PreemptedError);
    assert.equal(await pChat, "chat");
  });

  it("NO preempta una fase no preemptible (ingesta)", async () => {
    const batch = controllable({ phase: "ingesting" });
    const pBatch = submit(batch.run, { id: "batch", priority: PRIORITY.NORMAL });
    await batch.isRunning;
    await sleep(120);

    const pChat = submit(async () => "chat", { id: "chat", priority: PRIORITY.INTERACTIVE });
    await sleep(40);
    assert.equal(
      snapshot().items.find((i) => i.id === "batch")?.state,
      "active",
      "una ingesta no se corta a medias: crearía un carrusel duplicado"
    );

    batch.release();
    await pBatch;
    await pChat;
  });

  it("NO preempta a alguien de prioridad igual o mayor", async () => {
    const batch = controllable();
    const pBatch = submit(batch.run, { id: "batch", priority: PRIORITY.NORMAL });
    await batch.isRunning;
    await sleep(120);

    const pOtro = submit(async () => "otro", { id: "otro", priority: PRIORITY.NORMAL });
    await sleep(40);
    assert.equal(snapshot().items.find((i) => i.id === "batch")?.state, "active");

    batch.release();
    await pBatch;
    await pOtro;
  });

  it("al llegar al tope de preempciones se vuelve inpreemptable (anti-inanición)", async () => {
    // QUEUE_MAX_PREEMPTIONS = 2, así que un job que ya fue preemptado 2 veces no cede más.
    const batch = controllable();
    const pBatch = submit(batch.run, {
      id: "batch",
      priority: PRIORITY.NORMAL,
      preemptions: 2,
    });
    await batch.isRunning;
    await sleep(120);

    const pChat = submit(async () => "chat", { id: "chat", priority: PRIORITY.INTERACTIVE });
    await sleep(40);
    assert.equal(
      snapshot().items.find((i) => i.id === "batch")?.state,
      "active",
      "tras el tope de preempciones el job debe poder terminar"
    );

    batch.release();
    assert.equal(await pBatch, "ok", "el job llega a completarse");
    await pChat;
  });
});

describe("snapshot", () => {
  it("numera los puestos desde 1 y marca el activo sin puesto", async () => {
    const running = controllable();
    const pRunning = submit(running.run, { id: "activo", priority: PRIORITY.NORMAL });
    await running.isRunning;

    const p1 = submit(async () => 1, { id: "q1", priority: PRIORITY.NORMAL });
    const p2 = submit(async () => 2, { id: "q2", priority: PRIORITY.NORMAL });

    const s = snapshot();
    assert.equal(s.laneSize, 1);
    assert.equal(s.items.find((i) => i.id === "activo")?.position, null);
    assert.equal(s.items.find((i) => i.id === "q1")?.position, 1);
    assert.equal(s.items.find((i) => i.id === "q2")?.position, 2);

    running.release();
    await Promise.all([pRunning, p1, p2]);
  });

  it("avisa el puesto a quien espera (es lo que alimenta el SSE del chat)", async () => {
    const running = controllable();
    const pRunning = submit(running.run, { id: "activo", priority: PRIORITY.NORMAL });
    await running.isRunning;

    const puestos: number[] = [];
    const pWait = submit(async () => "listo", {
      id: "espera",
      priority: PRIORITY.NORMAL,
      onQueued: (p) => puestos.push(p),
    });

    assert.ok(puestos.length > 0, "debería avisar al menos una vez");
    assert.equal(puestos[0], 1);

    running.release();
    await Promise.all([pRunning, pWait]);
  });
});
