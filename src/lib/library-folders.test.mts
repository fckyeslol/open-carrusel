/**
 * Tests del agrupado de la Biblioteca en carpetas por avenger.
 *
 *     npm test
 *
 * El foco está en lo que hace que una carpeta engañe: un pedido en curso colándose desde
 * el tablero, un pedido sin avatar desapareciendo del agrupado, y el orden (carpetas por
 * nombre, ítems del más nuevo al más viejo) que es todo el valor de la vista.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./test-resolve.mts";

const {
  buildAvengerFolders,
  folderTotal,
  itemDate,
  refHost,
  shortAvatar,
  SIN_AVATAR_KEY,
} = await import("./library-folders.ts");

type Item = Parameters<typeof buildAvengerFolders>[0][number];

function item(over: Partial<Item> & { jobId: string }): Item {
  return {
    avatarSlug: "cinthya",
    avatarName: "30X — Cinthya Ramírez",
    referenceUrl: "https://www.instagram.com/p/abc/",
    status: "done",
    carouselId: `car-${over.jobId}`,
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...over,
  };
}

describe("buildAvengerFolders", () => {
  it("agrupa por avenger y separa entregados de eliminados", () => {
    const folders = buildAvengerFolders([
      item({ jobId: "a", avatarSlug: "cinthya", status: "done" }),
      item({ jobId: "b", avatarSlug: "cinthya", status: "archived", archivedAt: "2026-07-21T10:00:00.000Z" }),
      item({ jobId: "c", avatarSlug: "liz", avatarName: "30X — Liz", status: "delivered" }),
    ]);

    assert.equal(folders.length, 2);
    const cinthya = folders.find((f) => f.key === "cinthya")!;
    assert.deepEqual(cinthya.entregados.map((i) => i.jobId), ["a"]);
    assert.deepEqual(cinthya.eliminados.map((i) => i.jobId), ["b"]);
    assert.equal(folderTotal(cinthya), 2);

    const liz = folders.find((f) => f.key === "liz")!;
    assert.deepEqual(liz.entregados.map((i) => i.jobId), ["c"]);
    assert.equal(liz.eliminados.length, 0);
  });

  it("deja afuera lo que todavía vive en el tablero", () => {
    const folders = buildAvengerFolders([
      item({ jobId: "en-curso", status: "generating" }),
      item({ jobId: "por-revisar", status: "pending_review" }),
      item({ jobId: "fallado", status: "failed" }),
    ]);

    assert.deepEqual(folders, []);
  });

  it("le da carpeta propia a los pedidos sin avatar", () => {
    const folders = buildAvengerFolders([
      item({ jobId: "x", avatarSlug: "", avatarName: null, status: "done" }),
    ]);

    assert.equal(folders.length, 1);
    assert.equal(folders[0].key, SIN_AVATAR_KEY);
    assert.equal(folders[0].name, "Sin avatar");
  });

  it("ordena las carpetas por nombre y los ítems del más nuevo al más viejo", () => {
    const folders = buildAvengerFolders([
      item({ jobId: "z1", avatarSlug: "zoe", avatarName: "30X — Zoe" }),
      item({ jobId: "viejo", updatedAt: "2026-07-01T10:00:00.000Z" }),
      item({ jobId: "nuevo", updatedAt: "2026-07-30T10:00:00.000Z" }),
      item({ jobId: "a1", avatarSlug: "ana", avatarName: "30X — Ana" }),
    ]);

    assert.deepEqual(folders.map((f) => f.name), ["Ana", "Cinthya Ramírez", "Zoe"]);
    const cinthya = folders.find((f) => f.key === "cinthya")!;
    assert.deepEqual(cinthya.entregados.map((i) => i.jobId), ["nuevo", "viejo"]);
  });

  it("usa como portada el entregado más reciente que tenga carrusel", () => {
    const folders = buildAvengerFolders([
      item({ jobId: "sin-carrusel", carouselId: null, updatedAt: "2026-07-30T10:00:00.000Z" }),
      item({ jobId: "con-carrusel", carouselId: "car-ok", updatedAt: "2026-07-29T10:00:00.000Z" }),
    ]);

    assert.equal(folders[0].coverCarouselId, "car-ok");
    assert.equal(folders[0].lastActivityAt, "2026-07-30T10:00:00.000Z");
  });

  it("cae a un eliminado para la portada cuando no hay nada entregado", () => {
    const folders = buildAvengerFolders([
      item({ jobId: "borrado", status: "archived", archivedAt: "2026-07-25T10:00:00.000Z", carouselId: "car-b" }),
    ]);

    assert.equal(folders[0].coverCarouselId, "car-b");
    assert.equal(folders[0].lastActivityAt, "2026-07-25T10:00:00.000Z");
  });

  it("no muta la lista que recibe", () => {
    const original = [
      item({ jobId: "viejo", updatedAt: "2026-07-01T10:00:00.000Z" }),
      item({ jobId: "nuevo", updatedAt: "2026-07-30T10:00:00.000Z" }),
    ];
    buildAvengerFolders(original);
    assert.deepEqual(original.map((i) => i.jobId), ["viejo", "nuevo"]);
  });
});

describe("itemDate", () => {
  it("prefiere la fecha de eliminación cuando existe", () => {
    const eliminado = item({
      jobId: "a",
      status: "archived",
      archivedAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
    });
    assert.equal(itemDate(eliminado), "2026-07-25T10:00:00.000Z");
    assert.equal(itemDate(item({ jobId: "b" })), "2026-07-20T10:00:00.000Z");
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
