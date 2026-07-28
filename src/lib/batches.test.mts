/**
 * Tests de la ventana nocturna y del progreso del lote.
 *
 *     npm test
 *
 * Son las dos piezas que corren SIN NADIE MIRANDO: si `nextNightWindow` calcula mal, el
 * lote arranca a la hora en que las diseñadoras están trabajando (justo lo que se quiso
 * evitar) o no arranca nunca; si `batchProgress` cuenta mal, un lote terminado queda
 * "Generando" para siempre.
 *
 * ⚠️ El módulo se carga con `await import()` DESPUÉS de setear BATCH_NIGHT_HOUR: los
 * imports estáticos se hoistean y leerían el default de las 20:00 antes de estas líneas.
 */
process.env.BATCH_NIGHT_HOUR = "20";
process.env.BATCH_NIGHT_MINUTE = "0";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./test-resolve.mts";

const { nextNightWindow, nightHour } = await import("./batch-scheduler.ts");
const { batchProgress } = await import("./batches.ts");

type Assignment = Parameters<typeof batchProgress>[0][number];

/** Assignment mínima con el status que interesa al conteo. */
function withStatus(status: string): Assignment {
  return { status } as Assignment;
}

describe("nextNightWindow", () => {
  it("programa para HOY si todavía no dieron las 20:00", () => {
    const from = new Date(2026, 6, 28, 14, 30); // martes 14:30
    const next = nextNightWindow(from);

    assert.equal(next.getDate(), 28, "debería ser el mismo día");
    assert.equal(next.getHours(), 20);
    assert.equal(next.getMinutes(), 0);
  });

  it("programa para MAÑANA si ya pasaron las 20:00", () => {
    // El caso real: se acuerdan tarde y suben el CSV a las 21:00. Correr "ya" sería
    // exactamente lo que el lote existe para evitar.
    const from = new Date(2026, 6, 28, 21, 0);
    const next = nextNightWindow(from);

    assert.equal(next.getDate(), 29, "debería pasar al día siguiente");
    assert.equal(next.getHours(), 20);
  });

  it("cruza bien el fin de mes", () => {
    const from = new Date(2026, 6, 31, 23, 0); // 31 de julio, 23:00
    const next = nextNightWindow(from);

    assert.equal(next.getMonth(), 7, "debería ser agosto");
    assert.equal(next.getDate(), 1);
  });

  it("en el borde exacto de las 20:00 pasa al día siguiente", () => {
    // Igualdad, no solo "mayor": un lote subido a las 20:00:00 clavadas no debe
    // dispararse en el mismo tick en que se crea.
    const from = new Date(2026, 6, 28, 20, 0, 0, 0);
    assert.equal(nextNightWindow(from).getDate(), 29);
  });

  it("lee la hora de BATCH_NIGHT_HOUR", () => {
    assert.equal(nightHour(), 20);
  });
});

describe("batchProgress", () => {
  it("cuenta vacío sin romperse", () => {
    assert.deepEqual(batchProgress([]), {
      total: 0,
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
    });
  });

  it("clasifica cada estado en su balde", () => {
    const p = batchProgress([
      withStatus("queued"),
      withStatus("received"),
      withStatus("generating"),
      withStatus("rendering"),
      withStatus("done"),
      withStatus("delivered"),
      withStatus("failed"),
      withStatus("blocked"),
    ]);

    assert.equal(p.total, 8);
    assert.equal(p.pending, 2, "queued + received");
    assert.equal(p.running, 2, "generating + rendering");
    assert.equal(p.done, 2, "done + delivered");
    assert.equal(p.failed, 2, "failed + blocked");
  });

  it("un lote todo fallado igual está terminado (pending y running en 0)", () => {
    // Es lo que decide si el lote se cierra: si 'failed' contara como pendiente, un lote
    // donde todo falló quedaría en "Generando" para siempre.
    const p = batchProgress([withStatus("failed"), withStatus("failed")]);
    assert.equal(p.pending, 0);
    assert.equal(p.running, 0);
    assert.equal(p.failed, 2);
  });

  it("cuenta pending_review y archived como terminados", () => {
    const p = batchProgress([withStatus("pending_review"), withStatus("archived")]);
    assert.equal(p.done, 2);
    assert.equal(p.pending, 0);
  });

  it("un lote a medias reporta las tres categorías", () => {
    const p = batchProgress([
      withStatus("done"),
      withStatus("generating"),
      withStatus("queued"),
      withStatus("failed"),
    ]);
    assert.deepEqual(p, { total: 4, pending: 1, running: 1, done: 1, failed: 1 });
  });
});
