/**
 * Tests del armado de la Biblioteca: qué piezas salen de los carruseles y de los pedidos.
 *
 *     npm test
 *
 * Lo que se protege acá son las dos formas en que esta vista miente, y las dos ya
 * pasaron. Perder: la Biblioteca se armaba solo con los pedidos, así que todo lo hecho a
 * mano (60 de 72 carruseles en los datos donde se encontró) no existía acá aunque el home
 * lo listara. Y duplicar: un "Reintentar" deja el carrusel viejo con su `prewaveJobId`
 * grabado, así que emparejar por ese campo a secas hacía salir el mismo entregado dos o
 * tres veces, con la misma fecha y el mismo referente — peor que perderlo, porque no hay
 * forma de saber cuál abrir.
 *
 * Mismo andamiaje que assignments.test.mts: el módulo se carga con `await import()`
 * DESPUÉS del `chdir` y del hook de resolución, porque `data.ts` calcula su DATA_DIR desde
 * `process.cwd()` al cargarse.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
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
    const padre = (context as { parentURL?: string } | undefined)?.parentURL;
    if (
      padre?.includes("/src/") &&
      !padre.includes("/node_modules/") &&
      specifier.startsWith(".") &&
      !path.extname(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const ORIGINAL_CWD = process.cwd();
const workDir = await mkdtemp(path.join(tmpdir(), "oc-library-"));
await mkdir(path.join(workDir, "data"), { recursive: true });
process.chdir(workDir);

const { buildLibraryItems } = await import("./library.ts");
const { buildAvengerFolders } = await import("./library-folders.ts");

const DATA = path.join(workDir, "data");

/**
 * El avenger de casi todos los seeds. Va explícito en el carrusel porque el agrupado se
 * hace por el slug de la PIEZA: sin él la pieza cae en la carpeta "Sin avatar" y no en la
 * del pedido, que es correcto pero no es lo que estos casos quieren mirar.
 */
const AB = { avatarSlug: "andres-bilbao" } as const;

interface CarouselSeed {
  id: string;
  name?: string;
  avatarSlug?: string;
  source?: string;
  referenceUrl?: string;
  prewaveJobId?: string;
  resizedFrom?: string;
  aspectRatio?: string;
  isTemplate?: boolean;
  updatedAt?: string;
}

interface AssignmentSeed {
  jobId: string;
  status: string;
  carouselId?: string | null;
  avatarSlug?: string;
  designerId?: string | null;
  archivedAt?: string;
}

/** Lo único que importa de una entrada manual acá: a quién le pertenece la pieza. */
interface ManualSeed {
  carouselId: string;
  designerId: string | null;
}

async function seed(
  carousels: CarouselSeed[],
  assignments: AssignmentSeed[] = [],
  manuales: ManualSeed[] = []
) {
  await writeFile(
    path.join(DATA, "carousels.json"),
    JSON.stringify({
      carousels: carousels.map((c) => ({
        name: `Carrusel ${c.id}`,
        aspectRatio: "4:5",
        slides: [],
        referenceImages: [],
        chatSessionId: null,
        isTemplate: false,
        tags: [],
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
        ...c,
      })),
    })
  );
  await writeFile(
    path.join(DATA, "thirtyx-assignments.json"),
    JSON.stringify({
      assignments: assignments.map((a) => ({
        briefId: null,
        avatarId: null,
        deliveryId: null,
        event: "pull",
        avatarSlug: "andres-bilbao",
        avatarName: "30X — Andrés Bilbao",
        referenceUrl: "https://instagram.com/p/abc",
        designerId: "sofia",
        carouselId: null,
        resultUrl: null,
        error: null,
        attempts: 1,
        receivedAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
        ...a,
      })),
    })
  );
  await writeFile(
    path.join(DATA, "style-presets.json"),
    JSON.stringify({
      presets: [{ id: "avatar-ab", name: "30X — Andrés Bilbao", avatarSlug: "andres-bilbao" }],
    })
  );
  // Siempre se reescribe, y con `backfilledAt` puesto. Sin el marcador,
  // `listManualEntries` sembraría el historial desde los carruseles del seed y cada test
  // arrastraría entradas del anterior.
  await writeFile(
    path.join(DATA, "thirtyx-manual-entries.json"),
    JSON.stringify({
      backfilledAt: "2026-07-01T00:00:00.000Z",
      entries: manuales.map((m, i) => ({
        id: `entry-${i}`,
        referenceUrl: "https://instagram.com/p/manual",
        avatarSlug: "andres-bilbao",
        avatarName: null,
        note: null,
        designerId: m.designerId,
        status: "ready",
        carouselId: m.carouselId,
        referenceCount: 1,
        stage: null,
        error: null,
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
      })),
    })
  );
}

before(() => {
  process.chdir(workDir);
});

after(() => {
  process.chdir(ORIGINAL_CWD);
});

describe("buildLibraryItems", () => {
  it("incluye los carruseles que no tienen ningún pedido detrás", async () => {
    await seed([
      { id: "car-manual", source: "manual", referenceUrl: "https://instagram.com/p/x" },
      { id: "car-del-home" },
    ]);

    const items = await buildLibraryItems(null);
    assert.deepEqual(items.map((i) => i.key).sort(), ["car-del-home", "car-manual"]);
    assert.deepEqual(items.map((i) => i.jobId), [null, null]);

    // Y llegan a una carpeta, que es lo que antes no pasaba.
    const folders = buildAvengerFolders(items);
    assert.equal(folders.reduce((n, f) => n + f.sueltos.length, 0), 2);
  });

  it("le pone el estado del pedido a la pieza que el pedido apunta", async () => {
    await seed(
      [{ id: "car-1", avatarSlug: "andres-bilbao" }],
      [{ jobId: "job-1", status: "delivered", carouselId: "car-1" }]
    );

    const [item] = await buildLibraryItems(null);
    assert.equal(item.jobId, "job-1");
    assert.equal(item.status, "delivered");
    assert.equal(item.avatarName, "30X — Andrés Bilbao");
    assert.deepEqual(buildAvengerFolders([item])[0].entregados.map((i) => i.key), ["car-1"]);
  });

  it("un pedido reintentado no duplica el entregado: solo su pieza actual lo es", async () => {
    // El carrusel viejo se queda con el `prewaveJobId` grabado; el pedido apunta al nuevo.
    await seed(
      [
        { id: "car-viejo", ...AB, prewaveJobId: "job-1", updatedAt: "2026-07-20T00:00:00.000Z" },
        { id: "car-nuevo", ...AB, prewaveJobId: "job-1", updatedAt: "2026-07-28T00:00:00.000Z" },
      ],
      [{ jobId: "job-1", status: "delivered", carouselId: "car-nuevo" }]
    );

    const items = await buildLibraryItems(null);
    assert.equal(items.length, 2, "las dos piezas siguen estando");
    assert.equal(items.filter((i) => i.jobId === "job-1").length, 1, "un pedido, una pieza");

    const folder = buildAvengerFolders(items)[0];
    assert.deepEqual(folder.entregados.map((i) => i.key), ["car-nuevo"]);
    assert.deepEqual(folder.sueltos.map((i) => i.key), ["car-viejo"]);
  });

  it("cuando el pedido no apunta a ninguna pieza, la reclama la más reciente", async () => {
    await seed(
      [
        { id: "car-viejo", prewaveJobId: "job-1", updatedAt: "2026-07-20T00:00:00.000Z" },
        { id: "car-nuevo", prewaveJobId: "job-1", updatedAt: "2026-07-28T00:00:00.000Z" },
      ],
      [{ jobId: "job-1", status: "done", carouselId: null }]
    );

    const items = await buildLibraryItems(null);
    assert.equal(items.filter((i) => i.jobId === "job-1").length, 1);
    assert.equal(items.find((i) => i.jobId === "job-1")!.key, "car-nuevo");
  });

  it("un hermano de resize no se hace pasar por el entregado", async () => {
    // El hermano copia el `prewaveJobId` del original: los creados por
    // `createResizedSibling` ya nacen sin él, pero los de antes de ese cambio lo tienen.
    await seed(
      [
        { id: "car-1", ...AB, prewaveJobId: "job-1" },
        {
          id: "car-1-cuadrado",
          ...AB,
          prewaveJobId: "job-1",
          resizedFrom: "car-1",
          aspectRatio: "1:1",
        },
      ],
      [{ jobId: "job-1", status: "done", carouselId: null }]
    );

    const folder = buildAvengerFolders(await buildLibraryItems(null))[0];
    assert.deepEqual(folder.entregados.map((i) => i.key), ["car-1"]);
    assert.deepEqual(folder.sueltos.map((i) => i.key), ["car-1-cuadrado"]);
  });

  it("conserva el pedido que apunta a un carrusel borrado, pero sin link muerto", async () => {
    await seed([], [{ jobId: "job-fantasma", status: "done", carouselId: "car-que-ya-no-esta" }]);

    const [item] = await buildLibraryItems(null);
    assert.equal(item.jobId, "job-fantasma");
    assert.equal(item.carouselId, null);
    assert.equal(buildAvengerFolders([item])[0].entregados.length, 1);
  });

  it("no repite un pedido que quedó sin pieza", async () => {
    await seed(
      [{ id: "car-otro" }],
      [{ jobId: "job-sin-pieza", status: "archived", archivedAt: "2026-07-26T00:00:00.000Z" }]
    );

    const items = await buildLibraryItems(null);
    assert.equal(items.filter((i) => i.jobId === "job-sin-pieza").length, 1);
    assert.equal(new Set(items.map((i) => i.key)).size, items.length);
  });

  it("solo deja restaurar los pedidos de la sesión, porque el server tampoco deja más", async () => {
    await seed(
      [],
      [
        { jobId: "mio", status: "archived", designerId: "sofia" },
        { jobId: "ajeno", status: "archived", designerId: "otra" },
      ]
    );

    const items = await buildLibraryItems("sofia");
    assert.equal(items.find((i) => i.jobId === "mio")!.canRestore, true);
    assert.equal(items.find((i) => i.jobId === "ajeno")!.canRestore, false);
  });

  it("en local (sin sesión) se puede restaurar todo", async () => {
    await seed([], [{ jobId: "x", status: "archived", designerId: null }]);
    assert.equal((await buildLibraryItems(null))[0].canRestore, true);
  });

  it("deja afuera los templates, que no son piezas del historial", async () => {
    await seed([{ id: "car-real" }, { id: "car-template", isTemplate: true }]);
    assert.deepEqual((await buildLibraryItems(null)).map((i) => i.key), ["car-real"]);
  });
});

describe("atribución por diseñadora (perfiles de /equipo)", () => {
  it("le pone dueña a la pieza según el pedido que la generó", async () => {
    await seed(
      [{ id: "car-1", ...AB }],
      [{ jobId: "job-1", status: "done", carouselId: "car-1", designerId: "sofia" }]
    );

    const [item] = await buildLibraryItems(null);
    assert.equal(item.ownerId, "sofia");
    assert.deepEqual((await buildLibraryItems(null, { ownedBy: "sofia" })).map((i) => i.key), [
      "car-1",
    ]);
    assert.deepEqual(await buildLibraryItems(null, { ownedBy: "liz" }), []);
  });

  it("una pieza sin pedido ni entrada manual no es de nadie", async () => {
    // El carrusel no guarda dueño, así que la del home y el hermano de resize quedan sin
    // atribuir. Es el hueco que hace falta declarar, no adivinar.
    await seed([{ id: "car-del-home" }, { id: "car-otro-tamano", resizedFrom: "car-del-home" }]);

    const items = await buildLibraryItems(null);
    assert.deepEqual(items.map((i) => i.ownerId), [null, null]);
    assert.deepEqual(await buildLibraryItems(null, { ownedBy: "sofia" }), []);
  });

  it("el pedido manda sobre la entrada manual cuando las dos apuntan a la pieza", async () => {
    await seed(
      [{ id: "car-1", ...AB }],
      [{ jobId: "job-1", status: "done", carouselId: "car-1", designerId: "sofia" }],
      [{ carouselId: "car-1", designerId: "liz" }]
    );

    const [item] = await buildLibraryItems(null);
    assert.equal(item.ownerId, "sofia", "la pieza salió de la cola: es de quien la tenía asignada");
  });

  it("una pieza lanzada a mano es de quien la lanzó", async () => {
    await seed([{ id: "car-m", ...AB }], [], [{ carouselId: "car-m", designerId: "liz" }]);

    assert.deepEqual((await buildLibraryItems(null, { ownedBy: "liz" })).map((i) => i.key), [
      "car-m",
    ]);
  });
});
