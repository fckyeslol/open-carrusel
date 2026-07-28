/**
 * Tests del parser del CSV de carga nocturna.
 *
 *     npm test
 *
 * El foco está en lo que realmente rompe en producción: archivos exportados por Excel
 * en español (BOM + punto y coma), nombres con tilde que no matchean el slug, y filas
 * sueltas mal escritas que NO deben tumbar el lote.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./test-resolve.mts";

const {
  parseBatchCsv,
  parseHiggsfield,
  resolveAvenger,
  resolveDesigner,
  normalizeKey,
} = await import("./csv-batch.ts");

const AVATARS = [
  { slug: "maria-jose", name: "30X — María José Echeverry", ready: true },
  { slug: "andres-bilbao", name: "30X — Andrés Bilbao", ready: true },
  { slug: "cinthya", name: "30X — Cinthya Ramírez", ready: true },
];

const DESIGNERS = [
  { id: "u1", username: "laura", displayName: "Laura Gómez" },
  { id: "u2", username: "vale@30x.com", displayName: "Valentina Ruiz" },
];

const HEADER = "URL,Avenger,Diseñadora,Higgsfield";
const URL_A = "https://www.instagram.com/p/AAAAAAAAAAA/";
const URL_B = "https://www.instagram.com/p/BBBBBBBBBBB/";

describe("parseBatchCsv", () => {
  it("parsea las cuatro columnas con encabezado", () => {
    const csv = [HEADER, `${URL_A},María José,Laura,Si`, `${URL_B},Andrés Bilbao,Valentina,No`].join("\n");
    const out = parseBatchCsv(csv);

    assert.equal(out.invalid.length, 0);
    assert.equal(out.rows.length, 2);
    assert.equal(out.rows[0].referenceUrl, URL_A);
    assert.equal(out.rows[0].avengerRaw, "María José");
    assert.equal(out.rows[0].higgsfield, true);
    assert.equal(out.rows[1].higgsfield, false);
  });

  it("acepta el CSV de Excel en español: BOM, punto y coma y CRLF", () => {
    const csv = "﻿URL;Avenger;Diseñadora;Higgsfield\r\n" + `${URL_A};Cinthya;Laura;SÍ\r\n`;
    const out = parseBatchCsv(csv);

    assert.equal(out.rows.length, 1, "el BOM o el ; rompieron el encabezado");
    assert.equal(out.rows[0].avengerRaw, "Cinthya");
    assert.equal(out.rows[0].higgsfield, true);
  });

  it("salta la fila mala y conserva las buenas", () => {
    const csv = [
      HEADER,
      `${URL_A},María José,Laura,Si`,
      "no-es-una-url,María José,Laura,Si",
      ",María José,Laura,Si",
      `${URL_B},,Laura,No`,
      `${URL_B},Cinthya,Laura,No`,
    ].join("\n");
    const out = parseBatchCsv(csv);

    // Sobreviven la primera y la última; las tres del medio caen con motivo.
    assert.equal(out.rows.length, 2);
    assert.equal(out.invalid.length, 3);
    assert.ok(out.invalid.every((i) => i.reason.length > 0));
    assert.ok(out.invalid.some((i) => /Instagram/.test(i.reason)));
    assert.ok(out.invalid.some((i) => /sin URL/.test(i.reason)));
    assert.ok(out.invalid.some((i) => /sin avenger/.test(i.reason)));
  });

  it("descarta URLs repetidas dentro del mismo archivo", () => {
    const csv = [HEADER, `${URL_A},Cinthya,Laura,No`, `${URL_A},Cinthya,Laura,No`].join("\n");
    const out = parseBatchCsv(csv);

    assert.equal(out.rows.length, 1);
    assert.equal(out.invalid.length, 1);
    assert.match(out.invalid[0].reason, /repetida/);
  });

  it("asume el orden de columnas cuando no hay encabezado", () => {
    const out = parseBatchCsv(`${URL_A},Cinthya,Laura,Si`);

    assert.equal(out.assumedOrder, true);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].avengerRaw, "Cinthya");
    assert.equal(out.rows[0].higgsfield, true);
  });

  it("respeta las comillas de Excel en campos con coma", () => {
    const csv = [HEADER, `${URL_A},"Echeverry, María José",Laura,No`].join("\n");
    const out = parseBatchCsv(csv);

    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].avengerRaw, "Echeverry, María José");
  });

  it("no explota con un archivo vacío", () => {
    const out = parseBatchCsv("\n\n  \n");
    assert.equal(out.rows.length, 0);
    assert.equal(out.invalid.length, 0);
  });

  it("reporta la línea real del archivo para cada fila mala", () => {
    const csv = [HEADER, `${URL_A},Cinthya,Laura,No`, "basura"].join("\n");
    const out = parseBatchCsv(csv);
    assert.equal(out.invalid[0].line, 3);
  });
});

describe("parseHiggsfield", () => {
  it("reconoce las formas de sí", () => {
    for (const v of ["Si", "SÍ", "sí", "S", "yes", "TRUE", "1", "x"]) {
      assert.equal(parseHiggsfield(v), true, `"${v}" debería ser true`);
    }
  });

  it("reconoce las formas de no", () => {
    for (const v of ["No", "NO", "n", "false", "0", "", "-"]) {
      assert.equal(parseHiggsfield(v), false, `"${v}" debería ser false`);
    }
  });

  it("ante un valor ambiguo NO gasta Higgsfield", () => {
    // Higgsfield cuesta por imagen: la duda se resuelve sin gastar.
    assert.equal(parseHiggsfield("tal vez"), false);
    assert.equal(parseHiggsfield("???"), false);
  });
});

describe("resolveAvenger", () => {
  it("matchea por slug exacto", () => {
    assert.equal(resolveAvenger("maria-jose", AVATARS)?.slug, "maria-jose");
  });

  it("matchea el nombre con tilde contra el slug sin tilde", () => {
    assert.equal(resolveAvenger("María José", AVATARS)?.slug, "maria-jose");
    assert.equal(resolveAvenger("maria jose", AVATARS)?.slug, "maria-jose");
    assert.equal(resolveAvenger("Andrés Bilbao", AVATARS)?.slug, "andres-bilbao");
  });

  it("matchea el nombre completo del preset con prefijo 30X", () => {
    assert.equal(resolveAvenger("30X — Cinthya Ramírez", AVATARS)?.slug, "cinthya");
  });

  it("devuelve null si no reconoce el avenger", () => {
    assert.equal(resolveAvenger("Pepito Pérez", AVATARS), null);
    assert.equal(resolveAvenger("", AVATARS), null);
  });

  it("no adivina con un texto demasiado corto", () => {
    assert.equal(resolveAvenger("a", AVATARS), null);
  });
});

describe("resolveDesigner", () => {
  it("matchea por username, email y nombre completo", () => {
    assert.equal(resolveDesigner("laura", DESIGNERS)?.id, "u1");
    assert.equal(resolveDesigner("vale@30x.com", DESIGNERS)?.id, "u2");
    assert.equal(resolveDesigner("Valentina Ruiz", DESIGNERS)?.id, "u2");
  });

  it("matchea el nombre de pila cuando es inequívoco", () => {
    assert.equal(resolveDesigner("Valentina", DESIGNERS)?.id, "u2");
  });

  it("devuelve null si no la reconoce (la fila se genera igual, sin dueña)", () => {
    assert.equal(resolveDesigner("Fulana", DESIGNERS), null);
    assert.equal(resolveDesigner("", DESIGNERS), null);
  });
});

describe("normalizeKey", () => {
  it("saca tildes, mayúsculas y puntuación", () => {
    assert.equal(normalizeKey("María-José  Echeverry!"), "maria jose echeverry");
  });
});
