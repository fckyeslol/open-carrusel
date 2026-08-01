/**
 * Tests del reparto de las piezas entre las diseñadoras.
 *
 *     npm test
 *
 * Lo que se protege acá es que un perfil no MIENTA en ninguna de las dos direcciones: que
 * no se apropie de piezas que no son suyas (el carrusel no guarda dueño, así que la
 * tentación de adivinar es real) y que las que no son de nadie se cuenten aparte en vez de
 * desaparecer del total sin decirlo.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./test-resolve.mts";

const { buildTeamRoster } = await import("./team.ts");

type Item = Parameters<typeof buildTeamRoster>[1][number];
type Usuaria = Parameters<typeof buildTeamRoster>[0][number];

function user(id: string, displayName = id): Usuaria {
  return {
    id,
    username: `${id}@30x.com`,
    displayName,
    passwordHash: "x",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function item(over: Partial<Item> & { key: string }): Item {
  return {
    jobId: `job-${over.key}`,
    avatarSlug: "cinthya",
    avatarName: "30X — Cinthya",
    title: "Pieza",
    referenceUrl: "https://instagram.com/p/abc/",
    status: "done",
    carouselId: `car-${over.key}`,
    updatedAt: "2026-07-20T10:00:00.000Z",
    ownerId: "sofia",
    ...over,
  };
}

describe("buildTeamRoster", () => {
  it("reparte las piezas por dueña y las clasifica como en la Biblioteca", () => {
    const { members } = buildTeamRoster([user("sofia"), user("liz")], [
      item({ key: "a", ownerId: "sofia", status: "delivered" }),
      item({ key: "b", ownerId: "sofia", status: "done" }),
      item({ key: "c", ownerId: "sofia", jobId: null, status: "" }),
      item({ key: "d", ownerId: "sofia", status: "archived" }),
      item({ key: "e", ownerId: "sofia", status: "generating" }),
      item({ key: "f", ownerId: "liz", status: "done" }),
    ]);

    const sofia = members.find((m) => m.id === "sofia")!;
    assert.equal(sofia.entregados, 2);
    assert.equal(sofia.aMano, 1);
    assert.equal(sofia.eliminados, 1);
    assert.equal(sofia.enCurso, 1, "lo que sigue en el tablero se cuenta aparte");
    assert.equal(sofia.total, 5);

    const liz = members.find((m) => m.id === "liz")!;
    assert.equal(liz.entregados, 1);
    assert.equal(liz.total, 1);
  });

  it("cuenta aparte lo que no es de nadie en vez de repartirlo", () => {
    // Es la razón por la que existe `sinDueno`: el carrusel no guarda dueño, así que una
    // pieza del home o un hermano de resize no se le puede achacar a nadie. Adivinar
    // inflaría un perfil con trabajo ajeno.
    const { members, sinDueno } = buildTeamRoster([user("sofia")], [
      item({ key: "mia", ownerId: "sofia" }),
      item({ key: "del-home", ownerId: null, jobId: null, status: "" }),
      item({ key: "sin-campo", ownerId: undefined, jobId: null, status: "" }),
    ]);

    assert.equal(sinDueno, 2);
    assert.equal(members[0].total, 1);
  });

  it("no le atribuye a nadie las piezas de una usuaria que no está en la lista", () => {
    const { members, sinDueno } = buildTeamRoster([user("sofia")], [
      item({ key: "de-otra", ownerId: "usuaria-borrada" }),
    ]);

    assert.equal(members.length, 1);
    assert.equal(members[0].total, 0, "sofia no hereda lo de otra");
    assert.equal(sinDueno, 0, "tiene dueña, aunque esa dueña ya no esté en la lista");
  });

  it("incluye a las diseñadoras sin trabajo, con cero explícito", () => {
    const { members } = buildTeamRoster([user("sofia"), user("nueva")], [
      item({ key: "a", ownerId: "sofia" }),
    ]);

    assert.deepEqual(members.map((m) => m.id), ["sofia", "nueva"]);
    assert.equal(members[1].total, 0);
    assert.equal(members[1].coverCarouselId, null);
    assert.equal(members[1].lastActivityAt, "");
  });

  it("ordena por trabajo atribuido, y por nombre entre las que empatan", () => {
    const { members } = buildTeamRoster(
      [user("z", "Zoe"), user("a", "Ana"), user("m", "Maru")],
      [item({ key: "1", ownerId: "m" }), item({ key: "2", ownerId: "m" })]
    );

    assert.deepEqual(members.map((m) => m.displayName), ["Maru", "Ana", "Zoe"]);
  });

  it("la portada es la pieza más reciente que tenga carrusel", () => {
    const { members } = buildTeamRoster([user("sofia")], [
      item({ key: "vieja", carouselId: "car-vieja", updatedAt: "2026-07-01T00:00:00.000Z" }),
      item({ key: "nueva", carouselId: "car-nueva", updatedAt: "2026-07-30T00:00:00.000Z" }),
      // Un pedido sin pieza es lo más reciente, pero no hay nada para mostrar.
      item({ key: "sin-pieza", carouselId: null, updatedAt: "2026-07-31T00:00:00.000Z" }),
    ]);

    assert.equal(members[0].coverCarouselId, "car-nueva");
    assert.equal(members[0].lastActivityAt, "2026-07-31T00:00:00.000Z");
  });

  it("no muta la lista que recibe", () => {
    const items = [
      item({ key: "b", updatedAt: "2026-07-01T00:00:00.000Z" }),
      item({ key: "a", updatedAt: "2026-07-30T00:00:00.000Z" }),
    ];
    buildTeamRoster([user("sofia")], items);
    assert.deepEqual(items.map((i) => i.key), ["b", "a"]);
  });
});
