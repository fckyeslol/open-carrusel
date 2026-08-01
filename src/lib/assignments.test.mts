/**
 * Tests del store de asignaciones, con foco en "eliminar" del tablero (la Biblioteca).
 *
 *     npm test
 *
 * Lo que se protege acá es la razón por la que eliminar ARCHIVA en vez de borrar: el
 * pull de Prewave decide qué encolar mirando los `briefId` que ya existen localmente, así
 * que si el registro desapareciera, el siguiente ciclo de poll lo volvería a crear y la
 * diseñadora vería reaparecer lo que eliminó.
 *
 * Mismo andamiaje que carousels.test.mts: el módulo se carga con `await import()`
 * DESPUÉS del `chdir` y del hook de resolución, porque `data.ts` calcula su DATA_DIR
 * desde `process.cwd()` al cargarse.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

type NextResolve = (specifier: string, context: unknown) => unknown;
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve: (specifier: string, context: unknown, next: NextResolve) => unknown;
  }) => void;
};

const SRC_DIR = path.resolve(import.meta.dirname, "..");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = path.join(SRC_DIR, `${specifier.slice(2)}.ts`);
      return nextResolve(pathToFileURL(target).href, context);
    }
    if (specifier.startsWith(".") && !path.extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const ORIGINAL_CWD = process.cwd();
const workDir = await mkdtemp(path.join(tmpdir(), "oc-assignments-"));
await mkdir(path.join(workDir, "data"), { recursive: true });
process.chdir(workDir);

const {
  archiveAssignment,
  archiveCancelled,
  bumpReconcile,
  getAssignment,
  isArchivable,
  listAssignmentsForDesigner,
  MAX_RECONCILES,
  reconcilePlan,
  restoreAssignment,
  setStatus,
  upsertFromAgentJob,
} = await import("./assignments.ts");

const STORE = path.join(workDir, "data", "thirtyx-assignments.json");

/** Tres pedidos de la misma diseñadora: uno en revisión, uno generando, uno entregado. */
function seedStore() {
  const base = {
    briefId: null as string | null,
    avatarId: null,
    deliveryId: null,
    event: "pull",
    avatarSlug: "andres-bilbao",
    avatarName: "30X — Andrés Bilbao",
    referenceUrl: "https://instagram.com/p/abc",
    designerId: "sofia",
    carouselId: null as string | null,
    resultUrl: null,
    error: null,
    attempts: 1,
    receivedAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
  return {
    assignments: [
      { ...base, jobId: "job-revisar", briefId: "brief-1", status: "pending_review", carouselId: "car-1" },
      { ...base, jobId: "job-generando", briefId: "brief-2", status: "generating" },
      { ...base, jobId: "job-entregado", briefId: "brief-3", status: "delivered", carouselId: "car-3" },
    ],
  };
}

before(() => {
  process.chdir(workDir);
});

after(() => {
  process.chdir(ORIGINAL_CWD);
});

beforeEach(async () => {
  await writeFile(STORE, JSON.stringify(seedStore(), null, 2), "utf-8");
});

describe("eliminar del tablero (archivar)", () => {
  it("archiva sin borrar el registro y recuerda el estado anterior", async () => {
    await archiveAssignment("job-revisar");

    const a = await getAssignment("job-revisar");
    assert.equal(a?.status, "archived");
    assert.equal(a?.archivedFrom, "pending_review");
    assert.ok(a?.archivedAt, "guarda cuándo se archivó");
    assert.equal(a?.carouselId, "car-1", "el borrador queda intacto");

    const raw = JSON.parse(await readFile(STORE, "utf-8")) as { assignments: unknown[] };
    assert.equal(raw.assignments.length, 3, "sigue en el store: el re-pull no lo recrea");
  });

  it("no toca a los demás pedidos", async () => {
    await archiveAssignment("job-revisar");

    assert.equal((await getAssignment("job-generando"))?.status, "generating");
    assert.equal((await getAssignment("job-entregado"))?.status, "delivered");
  });

  it("sale del tablero pero sigue siendo de la diseñadora (lo ve la Biblioteca)", async () => {
    await archiveAssignment("job-revisar");

    const mine = await listAssignmentsForDesigner("sofia");
    assert.equal(mine.length, 3);
    assert.equal(mine.filter((a) => a.status === "archived").length, 1);
    assert.equal(mine.filter((a) => a.status === "pending_review").length, 0);
  });

  it("es idempotente: archivar dos veces no pisa el estado original", async () => {
    await archiveAssignment("job-revisar");
    const primero = await getAssignment("job-revisar");
    await archiveAssignment("job-revisar");
    const segundo = await getAssignment("job-revisar");

    assert.equal(segundo?.archivedFrom, "pending_review", "no queda archivedFrom: archived");
    assert.equal(segundo?.archivedAt, primero?.archivedAt);
  });

  it("un re-pull del mismo job no lo devuelve al tablero", async () => {
    await archiveAssignment("job-revisar");

    const { isNew } = await upsertFromAgentJob(
      {
        jobId: "job-revisar",
        briefId: "brief-1",
        avatarId: null,
        avatarSlug: "andres-bilbao",
        avatarName: "30X — Andrés Bilbao",
        referenceUrl: "https://instagram.com/p/abc",
      },
      "sofia"
    );

    assert.equal(isNew, false);
    assert.equal((await getAssignment("job-revisar"))?.status, "archived");
  });

  it("no se archiva algo que se está generando", () => {
    assert.equal(isArchivable("generating"), false);
    assert.equal(isArchivable("queued"), false);
    assert.equal(isArchivable("preempted"), false);
    assert.equal(isArchivable("pending_review"), true);
    assert.equal(isArchivable("failed"), true);
    assert.equal(isArchivable("delivered"), true);
  });
});

/**
 * Eliminar desde la columna "Generando". El riesgo acá no es archivar —eso es un write y
 * ya está probado arriba— sino que la generación que se está muriendo devuelva el pedido
 * al tablero con su último `setStatus`, o que restaurarlo lo deje como un fantasma en
 * "Generando" sin nadie generándolo.
 */
describe("cancelar y archivar algo en vuelo", () => {
  it("queda archivado con el motivo, y como failed para poder restaurarlo", async () => {
    await archiveCancelled("job-generando", "Cancelado desde el tablero.");

    const a = await getAssignment("job-generando");
    assert.equal(a?.status, "archived");
    assert.equal(a?.archivedFrom, "failed", "no vuelve a 'generating': nadie lo generaría");
    assert.equal(a?.error, "Cancelado desde el tablero.");
    assert.ok(a?.archivedAt);
  });

  it("restaurarlo lo deja en Con problemas, con su Reintentar", async () => {
    await archiveCancelled("job-generando", "Cancelado desde el tablero.");

    assert.equal(await restoreAssignment("job-generando"), "failed");
    const a = await getAssignment("job-generando");
    assert.equal(a?.status, "failed");
    assert.equal(a?.archivedFrom, undefined);
  });

  it("un estado tardío de la generación cancelada NO lo devuelve al tablero", async () => {
    await archiveCancelled("job-generando", "Cancelado desde el tablero.");

    // Lo que el runner escribe segundos después de que el AbortSignal llega al subproceso.
    await setStatus("job-generando", "preempted");
    await setStatus("job-generando", "failed", { error: "Cancelado a mano desde la cola." });

    const a = await getAssignment("job-generando");
    assert.equal(a?.status, "archived");
    assert.equal(a?.error, "Cancelado desde el tablero.", "conserva el motivo real");
  });

  it("setStatus sigue funcionando en un pedido que no está archivado", async () => {
    await setStatus("job-generando", "rendering");
    assert.equal((await getAssignment("job-generando"))?.status, "rendering");
  });
});

describe("restaurar desde la Biblioteca", () => {
  it("vuelve al estado que tenía y limpia las marcas de archivo", async () => {
    await archiveAssignment("job-revisar");

    const status = await restoreAssignment("job-revisar");
    assert.equal(status, "pending_review");

    const a = await getAssignment("job-revisar");
    assert.equal(a?.status, "pending_review");
    assert.equal(a?.archivedFrom, undefined);
    assert.equal(a?.archivedAt, undefined);
    assert.equal(a?.carouselId, "car-1", "el borrador sigue ahí: no hay que regenerar");
  });

  it("un entregado archivado vuelve a entregado, no a revisión", async () => {
    await archiveAssignment("job-entregado");
    assert.equal(await restoreAssignment("job-entregado"), "delivered");
  });

  it("restaurar algo que no está archivado no hace nada", async () => {
    assert.equal(await restoreAssignment("job-generando"), null);
    assert.equal((await getAssignment("job-generando"))?.status, "generating");
  });
});

/**
 * La política de arranque. Antes de esto, `reconcile()` re-encolaba TODO lo que
 * estuviera en vuelo, en cada arranque, sin memoria entre arranques: en hosteado, donde
 * el contenedor se reinicia solo, el mismo carrusel se regeneraba una y otra vez
 * pagando la ingesta y la visión de cero. Se prueba como función pura porque la
 * alternativa —probarla a través del runner— exige cola, subprocesos y Puppeteer, que
 * es justamente la razón por la que nadie la miraba.
 */
describe("reconcilePlan (qué hacer al arrancar con jobs a medias)", () => {
  const job = (over: Record<string, unknown>) => ({
    jobId: "j", briefId: null, avatarId: null, deliveryId: null, event: "pull",
    avatarSlug: "andres-bilbao", avatarName: null, referenceUrl: "u", designerId: "sofia",
    carouselId: null, resultUrl: null, error: null, attempts: 1,
    receivedAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z",
    status: "generating", ...over,
  }) as never;

  it("un job con checkpoint RETOMA (no vuelve a pagar la ingesta ni la visión)", () => {
    const plan = reconcilePlan([
      job({ jobId: "a", generation: { carouselId: "car-1", passesDone: 2, stalls: 0, preemptions: 0 } }),
    ]);
    assert.deepEqual(plan.map((d) => [d.jobId, d.action]), [["a", "resume"]]);
  });

  it("un job sin checkpoint arranca de cero, pero queda contado", () => {
    const plan = reconcilePlan([job({ jobId: "b", status: "ingesting" })]);
    assert.deepEqual(plan.map((d) => [d.jobId, d.action]), [["b", "restart"]]);
  });

  it("al llegar al tope se BLOQUEA en vez de seguir gastando", () => {
    const plan = reconcilePlan([job({ jobId: "c", reconciles: MAX_RECONCILES })]);
    assert.equal(plan[0].action, "block");
    assert.match(plan[0].reason, /Reintentar/, "el mensaje tiene que decirle qué hacer");
  });

  it("el tope aplica igual con checkpoint: retomar tampoco es gratis para siempre", () => {
    const plan = reconcilePlan([
      job({
        jobId: "d", reconciles: MAX_RECONCILES + 5,
        generation: { carouselId: "car-9", passesDone: 1, stalls: 0, preemptions: 0 },
      }),
    ]);
    assert.equal(plan[0].action, "block");
  });

  it("lo que NO está en vuelo ni se mira (un entregado no se regenera nunca)", () => {
    const plan = reconcilePlan([
      job({ jobId: "e", status: "delivered" }),
      job({ jobId: "f", status: "pending_review" }),
      job({ jobId: "g", status: "archived", reconciles: 99 }),
      job({ jobId: "h", status: "failed" }),
      job({ jobId: "i", status: "blocked" }),
    ]);
    assert.deepEqual(plan, [], "ninguno de estos estados se re-encola solo");
  });

  it("cubre las siete etapas en vuelo", () => {
    const enVuelo = ["received", "queued", "claiming", "ingesting", "generating", "rendering", "preempted"];
    const plan = reconcilePlan(enVuelo.map((status, i) => job({ jobId: `v${i}`, status })));
    assert.equal(plan.length, enVuelo.length);
  });
});

describe("contador de reconciliaciones", () => {
  it("suma en cada arranque y frena al tope", async () => {
    assert.equal(await bumpReconcile("job-generando"), 1);
    assert.equal(await bumpReconcile("job-generando"), 2);
    assert.equal(await bumpReconcile("job-generando"), 3);

    const a = await getAssignment("job-generando");
    assert.equal(reconcilePlan([a!])[0].action, "block");
  });

  it("se pone en cero al asentarse, para que Reintentar arranque con presupuesto limpio", async () => {
    await bumpReconcile("job-generando");
    await bumpReconcile("job-generando");
    await bumpReconcile("job-generando");

    await setStatus("job-generando", "failed", { error: "reventó" });
    assert.equal((await getAssignment("job-generando"))?.reconciles, 0);

    await setStatus("job-generando", "received");
    assert.equal(reconcilePlan([(await getAssignment("job-generando"))!])[0].action, "restart");
  });

  it("mientras sigue en vuelo NO se reinicia (si no, el tope no frenaría nunca)", async () => {
    await bumpReconcile("job-generando");
    await setStatus("job-generando", "rendering");
    assert.equal((await getAssignment("job-generando"))?.reconciles, 1);
  });
});
