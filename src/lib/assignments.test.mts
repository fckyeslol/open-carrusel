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
  getAssignment,
  isArchivable,
  listAssignmentsForDesigner,
  restoreAssignment,
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
