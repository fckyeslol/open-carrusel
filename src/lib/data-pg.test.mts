/**
 * Tests del store de documentos sobre PostgreSQL.
 *
 * Necesitan una base real. Se saltean solos si no hay `TEST_DATABASE_URL`, para que
 * `npm test` siga andando en una máquina sin Postgres (el caso de las diseñadoras).
 *
 *     docker run -d --name oc-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=oc \
 *       -e POSTGRES_DB=opencarrusel -p 55432:5432 postgres:16-alpine
 *     docker exec -i oc-pg psql -U oc -d opencarrusel < db/001_esquema_inicial.sql
 *     $env:TEST_DATABASE_URL = "postgres://oc:dev@localhost:55432/opencarrusel"
 *     npm test
 *
 * Lo que de verdad se está probando acá no es "sabe guardar un JSON": es que las
 * mutaciones concurrentes se serialicen ENTRE conexiones distintas. Ese es el motivo de
 * toda la migración — el mutex en memoria solo valía dentro de un proceso, y por eso Cloud
 * Run tenía que correr con una sola instancia.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import "./test-resolve.mts";
// Estático y con extensión explícita: `data-shared.ts` no lee env al cargarse, así que no
// necesita el import dinámico, y de paso conserva el tipo `unique symbol` de SKIP_WRITE —
// al destructurarlo de un `await import()`, TS lo ensancha a `symbol` y no compila.
import { SKIP_WRITE } from "./data-shared.ts";

const URL_TEST = process.env.TEST_DATABASE_URL;
const saltear = !URL_TEST;
if (URL_TEST) process.env.DATABASE_URL = URL_TEST;

const { readDataPg, readDataSafePg, updateDataPg, writeDataPg } = await import("./data-pg.ts");
const { query, closePool } = await import("./db.ts");

interface Store {
  items: { id: string; n: number }[];
}
const VACIO: Store = { items: [] };
const CLAVE = "test-doc.json";

describe("store de documentos en Postgres", { skip: saltear ? "sin TEST_DATABASE_URL" : false }, () => {
  before(async () => {
    // Falla temprano y claro si el esquema no está aplicado, en vez de con un error de SQL.
    const t = await query<{ existe: boolean }>(
      "SELECT to_regclass('public.documents') IS NOT NULL AS existe"
    );
    assert.equal(t[0]?.existe, true, "falta aplicar db/001_esquema_inicial.sql");

    // La guarda anti-store-vacío exige la marca de migración. En los tests la base arranca
    // legítimamente vacía, así que se pone a mano — el test de abajo verifica que SIN ella
    // el store se niega a funcionar, que es el comportamiento que protege producción.
    await query(
      "INSERT INTO schema_migrations (version) VALUES ('datos_migrados') ON CONFLICT DO NOTHING"
    );
  });

  beforeEach(async () => {
    await query("DELETE FROM documents WHERE key = $1", [CLAVE]);
  });

  after(async () => {
    await query("DELETE FROM documents WHERE key = $1", [CLAVE]).catch(() => {});
    await closePool();
  });

  it("un documento que no existe se comporta como archivo inexistente", async () => {
    await assert.rejects(readDataPg(CLAVE), /Data file not found/);
    // La lectura tolerante devuelve el fallback en vez de explotar.
    assert.deepEqual(await readDataSafePg(CLAVE, VACIO), VACIO);
  });

  it("guarda y devuelve el payload tal cual", async () => {
    await writeDataPg<Store>(CLAVE, { items: [{ id: "a", n: 1 }] });
    assert.deepEqual(await readDataPg<Store>(CLAVE), { items: [{ id: "a", n: 1 }] });
  });

  it("updateData arranca desde el fallback cuando no existe", async () => {
    const res = await updateDataPg<Store>(CLAVE, VACIO, (s) => ({
      items: [...s.items, { id: "nuevo", n: 1 }],
    }));
    assert.equal(res.items.length, 1);
    assert.deepEqual(await readDataPg<Store>(CLAVE), res);
  });

  it("SKIP_WRITE no escribe nada", async () => {
    await writeDataPg<Store>(CLAVE, { items: [{ id: "a", n: 1 }] });
    const antes = await query<{ revision: string }>(
      "SELECT revision FROM documents WHERE key = $1",
      [CLAVE]
    );
    const res = await updateDataPg<Store>(CLAVE, VACIO, () => SKIP_WRITE);
    const despues = await query<{ revision: string }>(
      "SELECT revision FROM documents WHERE key = $1",
      [CLAVE]
    );
    assert.equal(res.items.length, 1, "devuelve el estado actual");
    assert.equal(despues[0].revision, antes[0].revision, "la revisión no cambió");
  });

  it("50 mutaciones concurrentes no pierden ninguna (el punto de la migración)", async () => {
    // Con el store de archivos esto solo funcionaba dentro de UN proceso, gracias al mutex
    // en memoria. Acá cada `updateDataPg` toma su propia conexión del pool, así que es el
    // escenario real de varias instancias escribiendo a la vez.
    await writeDataPg<Store>(CLAVE, VACIO);
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateDataPg<Store>(CLAVE, VACIO, (s) => ({
          items: [...s.items, { id: `i${i}`, n: i }],
        }))
      )
    );
    const final = await readDataPg<Store>(CLAVE);
    assert.equal(final.items.length, N, "no se perdió ninguna escritura");
    assert.equal(new Set(final.items.map((i) => i.id)).size, N, "no hay duplicados");
  });

  it("sin la marca de migración se niega a leer, en vez de devolver vacío", async () => {
    // Es el escenario que arruinaría producción: base configurada y esquema creado, pero
    // los JSON todavía sin volcar. Sin la guarda, readDataSafe devolvería el store VACÍO —
    // igual que si se hubieran perdido todos los carruseles— y la primera escritura lo
    // persistiría. Tiene que reventar fuerte y con instrucciones.
    const modulo = await import(`./data-pg.ts?sin-marca=${Date.now()}`);
    await query("DELETE FROM schema_migrations WHERE version = 'datos_migrados'");
    try {
      await assert.rejects(modulo.readDataPg(CLAVE), /datos todavía NO se migraron/);
    } finally {
      await query(
        "INSERT INTO schema_migrations (version) VALUES ('datos_migrados') ON CONFLICT DO NOTHING"
      );
    }
  });

  it("si la mutación tira, no deja escritura a medias", async () => {
    await writeDataPg<Store>(CLAVE, { items: [{ id: "original", n: 0 }] });
    await assert.rejects(
      updateDataPg<Store>(CLAVE, VACIO, () => {
        throw new Error("explota a propósito");
      }),
      /explota a propósito/
    );
    const final = await readDataPg<Store>(CLAVE);
    assert.deepEqual(final.items, [{ id: "original", n: 0 }], "el documento quedó intacto");
  });
});
