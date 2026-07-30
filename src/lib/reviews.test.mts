/**
 * Tests del contador de revisiones.
 *
 *     npm test
 *
 * Lo que se protege acá es lo que hace que el número del dashboard signifique algo: que
 * marcar dos veces el mismo pedido el mismo día NO sume (si no, el contador se infla
 * apretando el botón), que al día siguiente SÍ sume (es trabajo nuevo), y que el día se
 * calcule en hora local — con UTC, todo lo revisado después de las 19:00 de Bogotá caería
 * en el día siguiente y partiría en dos la tarde de una diseñadora.
 *
 * Mismo andamiaje que assignments.test.mts: el módulo se carga con `await import()`
 * DESPUÉS del `chdir`, porque `data.ts` calcula su DATA_DIR desde `process.cwd()` al
 * cargarse.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import "./test-resolve.mts";

const ORIGINAL_CWD = process.cwd();
const workDir = await mkdtemp(path.join(tmpdir(), "oc-reviews-"));
await mkdir(path.join(workDir, "data"), { recursive: true });
process.chdir(workDir);

const { markReviewed, listReviewedOn, countsByDesigner, localDay, recentDays } =
  await import("./reviews.ts");

const STORE = path.join(workDir, "data", "thirtyx-reviews.json");

beforeEach(async () => {
  await writeFile(STORE, JSON.stringify({ marks: [] }), "utf-8");
});

after(async () => {
  process.chdir(ORIGINAL_CWD);
  await rm(workDir, { recursive: true, force: true });
});

describe("localDay", () => {
  it("usa la hora LOCAL, no UTC", () => {
    // 23:30 local. En Bogotá (UTC-5) eso es 04:30 UTC del día siguiente: si el día se
    // sacara de toISOString(), esta revisión se contaría mañana.
    assert.equal(localDay(new Date(2026, 6, 28, 23, 30)), "2026-07-28");
  });

  it("rellena mes y día con cero", () => {
    assert.equal(localDay(new Date(2026, 0, 5, 12, 0)), "2026-01-05");
  });
});

describe("recentDays", () => {
  it("devuelve la ventana del más viejo al más nuevo, terminando hoy", () => {
    const days = recentDays(3, new Date(2026, 6, 28));
    assert.deepEqual(days, ["2026-07-26", "2026-07-27", "2026-07-28"]);
  });

  it("cruza bien el cambio de mes", () => {
    const days = recentDays(3, new Date(2026, 7, 1));
    assert.deepEqual(days, ["2026-07-30", "2026-07-31", "2026-08-01"]);
  });
});

describe("markReviewed", () => {
  it("cuenta la primera marca", async () => {
    const r = await markReviewed("ana", "job-1", new Date(2026, 6, 28, 10, 0));
    assert.equal(r.counted, true);
    assert.equal(r.day, "2026-07-28");
    assert.deepEqual(await listReviewedOn("ana", "2026-07-28"), ["job-1"]);
  });

  it("NO cuenta dos veces el mismo pedido el mismo día", async () => {
    await markReviewed("ana", "job-1", new Date(2026, 6, 28, 10, 0));
    const segunda = await markReviewed("ana", "job-1", new Date(2026, 6, 28, 17, 45));

    assert.equal(segunda.counted, false, "el segundo click no debería sumar");
    assert.deepEqual(await listReviewedOn("ana", "2026-07-28"), ["job-1"]);
  });

  it("cuenta de nuevo al día siguiente: es trabajo nuevo", async () => {
    await markReviewed("ana", "job-1", new Date(2026, 6, 28, 10, 0));
    const manana = await markReviewed("ana", "job-1", new Date(2026, 6, 29, 9, 0));

    assert.equal(manana.counted, true);
    assert.deepEqual(await listReviewedOn("ana", "2026-07-29"), ["job-1"]);
  });

  it("cuenta por separado a dos diseñadoras sobre el mismo pedido", async () => {
    const at = new Date(2026, 6, 28, 10, 0);
    assert.equal((await markReviewed("ana", "job-1", at)).counted, true);
    assert.equal((await markReviewed("bea", "job-1", at)).counted, true);

    assert.deepEqual(await listReviewedOn("ana", "2026-07-28"), ["job-1"]);
    assert.deepEqual(await listReviewedOn("bea", "2026-07-28"), ["job-1"]);
  });

  it("poda las marcas más viejas que la retención", async () => {
    await markReviewed("ana", "viejo", new Date(2025, 0, 1, 10, 0));
    await markReviewed("ana", "nuevo", new Date(2026, 6, 28, 10, 0));

    assert.deepEqual(await listReviewedOn("ana", "2025-01-01"), [], "debió podarse");
    assert.deepEqual(await listReviewedOn("ana", "2026-07-28"), ["nuevo"]);
  });
});

describe("countsByDesigner", () => {
  it("alinea la serie con los días pedidos", async () => {
    await markReviewed("ana", "a", new Date(2026, 6, 27, 10, 0));
    await markReviewed("ana", "b", new Date(2026, 6, 28, 10, 0));
    await markReviewed("ana", "c", new Date(2026, 6, 28, 11, 0));
    await markReviewed("bea", "d", new Date(2026, 6, 28, 12, 0));

    const days = recentDays(3, new Date(2026, 6, 28));
    const counts = await countsByDesigner(days);

    assert.deepEqual(counts.get("ana"), [0, 1, 2]);
    assert.deepEqual(counts.get("bea"), [0, 0, 1]);
  });

  it("ignora las marcas fuera de la ventana", async () => {
    await markReviewed("ana", "a", new Date(2026, 6, 20, 10, 0));
    const counts = await countsByDesigner(recentDays(3, new Date(2026, 6, 28)));

    assert.equal(counts.has("ana"), false, "quedó fuera de la ventana");
  });
});
