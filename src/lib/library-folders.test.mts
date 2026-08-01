/**
 * Tests del agrupado de la Biblioteca en carpetas por avenger.
 *
 *     npm test
 *
 * El foco está en lo que hace que una carpeta engañe: un pedido en curso colándose desde
 * el tablero, una pieza sin pedido desapareciendo (que es el bug por el que la Biblioteca
 * mostraba 12 de 72 carruseles), un pedido sin avatar quedando fuera del agrupado, y el
 * orden (carpetas por nombre, ítems del más nuevo al más viejo) que es todo el valor de la
 * vista.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./test-resolve.mts";

const {
  bucketOf,
  buildAvengerFolders,
  folderTotal,
  itemDate,
  refHost,
  shortAvatar,
  SIN_AVATAR_KEY,
} = await import("./library-folders.ts");

type Item = Parameters<typeof buildAvengerFolders>[0][number];

/** Una pieza con pedido detrás (la que llega de la cola). */
function item(over: Partial<Item> & { key: string }): Item {
  return {
    jobId: `job-${over.key}`,
    avatarSlug: "cinthya",
    avatarName: "30X — Cinthya Ramírez",
    title: "Carrusel de prueba",
    referenceUrl: "https://www.instagram.com/p/abc/",
    status: "done",
    carouselId: `car-${over.key}`,
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...over,
  };
}

/** Una pieza SIN pedido: hecha a mano, desde el home, o un hermano de resize. */
function suelto(over: Partial<Item> & { key: string }): Item {
  return item({ ...over, jobId: null, status: "" });
}

describe("buildAvengerFolders", () => {
  it("agrupa por avenger y separa entregados, eliminados y hechos a mano", () => {
    const folders = buildAvengerFolders([
      item({ key: "a", avatarSlug: "cinthya", status: "done" }),
      item({
        key: "b",
        avatarSlug: "cinthya",
        status: "archived",
        archivedAt: "2026-07-21T10:00:00.000Z",
      }),
      suelto({ key: "m", avatarSlug: "cinthya" }),
      item({ key: "c", avatarSlug: "liz", avatarName: "30X — Liz", status: "delivered" }),
    ]);

    assert.equal(folders.length, 2);
    const cinthya = folders.find((f) => f.key === "cinthya")!;
    assert.deepEqual(cinthya.entregados.map((i) => i.key), ["a"]);
    assert.deepEqual(cinthya.eliminados.map((i) => i.key), ["b"]);
    assert.deepEqual(cinthya.sueltos.map((i) => i.key), ["m"]);
    assert.equal(folderTotal(cinthya), 3);

    const liz = folders.find((f) => f.key === "liz")!;
    assert.deepEqual(liz.entregados.map((i) => i.key), ["c"]);
    assert.equal(liz.eliminados.length, 0);
    assert.equal(liz.sueltos.length, 0);
  });

  it("deja afuera lo que todavía vive en el tablero", () => {
    const folders = buildAvengerFolders([
      item({ key: "en-curso", status: "generating" }),
      item({ key: "por-revisar", status: "pending_review" }),
      item({ key: "fallado", status: "failed" }),
    ]);

    assert.deepEqual(folders, []);
  });

  it("nunca esconde una pieza sin pedido, sea cual sea su estado", () => {
    // Es el bug que se arregló: sin `jobId` no hay nada que pueda estar en curso, así que
    // la pieza no puede aparecer en el tablero y esconderla acá la borra de la app.
    const folders = buildAvengerFolders([
      suelto({ key: "a-mano" }),
      suelto({ key: "del-home", referenceUrl: "", title: "Sin nombre aún" }),
      suelto({ key: "otro-tamano", resizedFrom: "car-a-mano", aspectRatio: "1:1" }),
    ]);

    assert.equal(folders.length, 1);
    assert.deepEqual(folders[0].sueltos.map((i) => i.key).sort(), [
      "a-mano",
      "del-home",
      "otro-tamano",
    ]);
    assert.equal(folders[0].entregados.length, 0);
  });

  it("le da carpeta propia a las piezas sin avatar", () => {
    const folders = buildAvengerFolders([
      item({ key: "x", avatarSlug: "", avatarName: null, status: "done" }),
      suelto({ key: "y", avatarSlug: "", avatarName: null }),
    ]);

    assert.equal(folders.length, 1);
    assert.equal(folders[0].key, SIN_AVATAR_KEY);
    assert.equal(folders[0].name, "Sin avatar");
    assert.equal(folderTotal(folders[0]), 2);
  });

  it("ordena las carpetas por nombre y los ítems del más nuevo al más viejo", () => {
    const folders = buildAvengerFolders([
      item({ key: "z1", avatarSlug: "zoe", avatarName: "30X — Zoe" }),
      item({ key: "viejo", updatedAt: "2026-07-01T10:00:00.000Z" }),
      item({ key: "nuevo", updatedAt: "2026-07-30T10:00:00.000Z" }),
      item({ key: "a1", avatarSlug: "ana", avatarName: "30X — Ana" }),
    ]);

    assert.deepEqual(folders.map((f) => f.name), ["Ana", "Cinthya Ramírez", "Zoe"]);
    const cinthya = folders.find((f) => f.key === "cinthya")!;
    assert.deepEqual(cinthya.entregados.map((i) => i.key), ["nuevo", "viejo"]);
  });

  it("usa como portada el entregado más reciente que tenga carrusel", () => {
    const folders = buildAvengerFolders([
      item({ key: "sin-carrusel", carouselId: null, updatedAt: "2026-07-30T10:00:00.000Z" }),
      item({ key: "con-carrusel", carouselId: "car-ok", updatedAt: "2026-07-29T10:00:00.000Z" }),
    ]);

    assert.equal(folders[0].coverCarouselId, "car-ok");
    assert.equal(folders[0].lastActivityAt, "2026-07-30T10:00:00.000Z");
  });

  it("prefiere un hecho a mano antes que un eliminado para la portada", () => {
    const folders = buildAvengerFolders([
      item({
        key: "borrado",
        status: "archived",
        archivedAt: "2026-07-28T10:00:00.000Z",
        carouselId: "car-b",
      }),
      suelto({ key: "manual", carouselId: "car-m", updatedAt: "2026-07-25T10:00:00.000Z" }),
    ]);

    assert.equal(folders[0].coverCarouselId, "car-m");
    assert.equal(folders[0].lastActivityAt, "2026-07-28T10:00:00.000Z");
  });

  it("cae a un eliminado para la portada cuando no hay nada más", () => {
    const folders = buildAvengerFolders([
      item({
        key: "borrado",
        status: "archived",
        archivedAt: "2026-07-25T10:00:00.000Z",
        carouselId: "car-b",
      }),
    ]);

    assert.equal(folders[0].coverCarouselId, "car-b");
    assert.equal(folders[0].lastActivityAt, "2026-07-25T10:00:00.000Z");
  });

  it("no muta la lista que recibe", () => {
    const original = [
      item({ key: "viejo", updatedAt: "2026-07-01T10:00:00.000Z" }),
      item({ key: "nuevo", updatedAt: "2026-07-30T10:00:00.000Z" }),
    ];
    buildAvengerFolders(original);
    assert.deepEqual(original.map((i) => i.key), ["viejo", "nuevo"]);
  });
});

describe("bucketOf", () => {
  it("manda a su sección según el estado del pedido", () => {
    assert.equal(bucketOf(item({ key: "a", status: "done" })), "entregado");
    assert.equal(bucketOf(item({ key: "b", status: "delivered" })), "entregado");
    assert.equal(bucketOf(item({ key: "c", status: "archived" })), "eliminado");
    assert.equal(bucketOf(item({ key: "d", status: "generating" })), null);
    assert.equal(bucketOf(item({ key: "e", status: "pending_review" })), null);
  });

  it("una pieza sin pedido es suelta aunque traiga un estado heredado", () => {
    assert.equal(bucketOf(suelto({ key: "a" })), "suelto");
    assert.equal(bucketOf({ ...suelto({ key: "b" }), status: "generating" }), "suelto");
  });
});

describe("itemDate", () => {
  it("prefiere la fecha de eliminación cuando existe", () => {
    const eliminado = item({
      key: "a",
      status: "archived",
      archivedAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
    });
    assert.equal(itemDate(eliminado), "2026-07-25T10:00:00.000Z");
    assert.equal(itemDate(item({ key: "b" })), "2026-07-20T10:00:00.000Z");
  });
});

describe("helpers de presentación", () => {
  it("saca el prefijo de marca del nombre del avenger", () => {
    assert.equal(shortAvatar("30X — María José Echeverry", "maria-jose"), "María José Echeverry");
    assert.equal(shortAvatar(null, "liz"), "liz");
    assert.equal(shortAvatar(null, ""), "Sin avatar");
  });

  it("acorta la URL del referente", () => {
    assert.equal(refHost("https://www.instagram.com/p/abc/"), "instagram.com/p/abc/");
    assert.equal(refHost(""), "");
  });
});
