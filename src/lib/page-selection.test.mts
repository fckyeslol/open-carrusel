/**
 * Tests de la selección de láminas del export ("1, 3, 5-7", como Canva).
 *
 *     npm test
 *
 * Lo que se protege acá es que los dos lados del export coincidan: el menú habilita el
 * botón con este parser y la ruta `/api/carousels/[id]/export` resuelve `?pages=` con el
 * MISMO parser. Si se duplicara la lógica, la diferencia no daría un error visible —
 * daría un archivo con láminas que nadie pidió, que es peor.
 *
 * Por eso los casos raros están acá y no en la UI: rangos al revés, láminas repetidas,
 * desordenadas, y sobre todo la fuera-de-rango, que se rechaza en vez de recortarse en
 * silencio (pedir 1-9 en un carrusel de 7 y recibir 7 archivos sin aviso es el tipo de
 * fallo que no se nota hasta que el carrusel ya se entregó).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./test-resolve.mts";

const { parsePageSelection, allPages, pageFileSuffix } = await import(
  "./page-selection.ts"
);

/** Atajo: espera éxito y devuelve las láminas. */
function pages(input: string, total = 7): number[] {
  const result = parsePageSelection(input, total);
  assert.ok(result.ok, `esperaba ok para "${input}": ${!result.ok && result.error}`);
  return result.pages;
}

/** Atajo: espera error y devuelve el mensaje. */
function error(input: string, total = 7): string {
  const result = parsePageSelection(input, total);
  assert.ok(!result.ok, `esperaba error para "${input}"`);
  return result.error;
}

describe("parsePageSelection", () => {
  it("acepta una sola lámina", () => {
    assert.deepEqual(pages("3"), [3]);
  });

  it("acepta una lista separada por comas", () => {
    assert.deepEqual(pages("1, 3, 5"), [1, 3, 5]);
  });

  it("expande rangos", () => {
    assert.deepEqual(pages("2-5"), [2, 3, 4, 5]);
  });

  it("combina láminas y rangos", () => {
    assert.deepEqual(pages("1, 3-5, 7"), [1, 3, 4, 5, 7]);
  });

  it("normaliza rangos al revés", () => {
    assert.deepEqual(pages("5-2"), [2, 3, 4, 5]);
  });

  it("ordena y deduplica lo repetido o desordenado", () => {
    assert.deepEqual(pages("5, 1, 5, 2-3, 3"), [1, 2, 3, 5]);
  });

  it("tolera espacios alrededor del guion y separadores sueltos", () => {
    assert.deepEqual(pages("1 , 3 - 5;7"), [1, 3, 4, 5, 7]);
  });

  it("acepta el guion largo que se pega desde otras apps", () => {
    assert.deepEqual(pages("2–4"), [2, 3, 4]);
  });

  it("acepta el carrusel entero", () => {
    assert.deepEqual(pages("1-7"), allPages(7));
  });

  it("rechaza una lámina que no existe, sin recortar", () => {
    assert.match(error("1-9"), /no existe/);
    assert.match(error("8"), /tiene 7/);
    assert.match(error("0"), /no existe/);
  });

  it("rechaza texto que no es número ni rango", () => {
    assert.match(error("hola"), /No entiendo/);
    assert.match(error("1, x"), /No entiendo/);
    assert.match(error("1-2-3"), /No entiendo/);
  });

  it("rechaza el vacío pidiendo qué exportar", () => {
    assert.match(error(""), /Escribí/);
    assert.match(error("   "), /Escribí/);
    assert.match(error(",,"), /Escribí/);
  });

  it("rechaza cualquier selección si el carrusel no tiene láminas", () => {
    assert.match(error("1", 0), /no tiene láminas/);
  });
});

describe("pageFileSuffix", () => {
  it("no marca nada cuando entran todas las láminas", () => {
    assert.equal(pageFileSuffix(allPages(7), 7), "");
  });

  it("mantiene el -slide-N de siempre para una sola", () => {
    assert.equal(pageFileSuffix([4], 7), "-slide-4");
  });

  it("lista las láminas cuando es una selección parcial", () => {
    assert.equal(pageFileSuffix([1, 3, 5], 7), "-laminas-1-3-5");
  });
});
