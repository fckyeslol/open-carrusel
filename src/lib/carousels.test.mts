/**
 * Tests del store de carruseles. Corren con el runner nativo de Node:
 *
 *     npm test
 *
 * Cubren el incidente que vació `data/carousels.json` en producción: las
 * mutaciones hacían `readDataSafe()` (que cae al store VACÍO ante cualquier
 * error de lectura) y después `writeData()`, así que una lectura fallida
 * —ESTALE/EIO del volumen GCS FUSE en Cloud Run, o el archivo pillado a medio
 * renombrar— persistía ese vacío encima de los datos vivos y se perdían todos
 * los carruseles. Ahora todo pasa por `updateData`, que aborta la escritura si
 * la lectura falló por algo que no sea "el archivo no existe".
 *
 * El módulo se carga con `await import()` DESPUÉS del `chdir` y del hook de
 * resolución, no con un `import` estático: los imports de ESM se hoistean y
 * `data.ts` calcula su DATA_DIR desde `process.cwd()` al cargarse.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * `module.registerHooks` existe en Node 24 pero todavía no está en la versión de
 * @types/node del proyecto, así que se tipa acá en el borde en vez de arrastrar
 * una actualización de tipos por un test.
 */
type NextResolve = (specifier: string, context: unknown) => unknown;
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve: (specifier: string, context: unknown, next: NextResolve) => unknown;
  }) => void;
};

/**
 * El código de la app usa dos cosas que Node no resuelve solo, pero TypeScript sí:
 * el alias `@/…` del tsconfig y los imports relativos sin extensión (`./data`).
 * El hook traduce ambos a rutas `.ts` reales.
 */
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
const workDir = await mkdtemp(path.join(tmpdir(), "oc-carousels-"));
await mkdir(path.join(workDir, "data"), { recursive: true });
process.chdir(workDir);

const {
  addSlide,
  createCarousel,
  getCarousel,
  listCarousels,
  updateSlide,
} = await import("./carousels.ts");

const STORE = path.join(workDir, "data", "carousels.json");

/** Tres carruseles con una lámina cada uno: la línea base de cada test. */
function seedStore() {
  return {
    carousels: ["uno", "dos", "tres"].map((name, i) => ({
      id: `id-${name}`,
      name,
      aspectRatio: "4:5",
      slides: [
        { id: `slide-${name}`, html: `<p>${name}</p>`, previousVersions: [], order: 0, notes: "" },
      ],
      referenceImages: [],
      chatSessionId: null,
      isTemplate: false,
      tags: [],
      createdAt: `2026-07-2${i + 1}T00:00:00.000Z`,
      updatedAt: `2026-07-2${i + 1}T00:00:00.000Z`,
    })),
  };
}

async function writeStore(contents: string) {
  await writeFile(STORE, contents, "utf-8");
}

async function readStoreRaw(): Promise<string> {
  return readFile(STORE, "utf-8");
}

before(() => {
  process.chdir(workDir);
});

after(() => {
  process.chdir(ORIGINAL_CWD);
});

beforeEach(async () => {
  await writeStore(JSON.stringify(seedStore(), null, 2));
});

describe("carousels — camino feliz", () => {
  it("agrega una lámina sin tocar los otros carruseles", async () => {
    const slide = await addSlide("id-dos", "<p>nueva</p>");
    assert.ok(slide, "debería devolver la lámina creada");

    const all = await listCarousels();
    assert.equal(all.length, 3, "los tres carruseles siguen ahí");

    const target = await getCarousel("id-dos");
    assert.equal(target?.slides.length, 2);
    assert.equal(target?.slides[1].html, "<p>nueva</p>");
  });

  it("crea un carrusel conservando los existentes", async () => {
    const created = await createCarousel("cuatro", "1:1");
    const all = await listCarousels();
    assert.equal(all.length, 4);
    assert.ok(all.some((c) => c.id === created.id));
  });
});

describe("carousels — no pisa datos vivos cuando la lectura falla", () => {
  /**
   * EL BUG: con `readDataSafe` + `writeData`, esto dejaba el archivo con UN solo
   * carrusel (el recién creado) y borraba los otros tres. Ahora la escritura se
   * aborta y el archivo queda tal cual estaba.
   */
  it("createCarousel no vacía el store si el archivo está corrupto", async () => {
    const corrupt = '{"carousels": [{"id": "id-uno", "name": "u';
    await writeStore(corrupt);

    await assert.rejects(
      () => createCarousel("nuevo", "4:5"),
      /corrupted/i,
      "debe fallar ruidosamente, no escribir encima"
    );

    assert.equal(await readStoreRaw(), corrupt, "el archivo quedó intacto");
  });

  it("addSlide no vacía el store si el archivo está corrupto", async () => {
    const corrupt = "esto no es json";
    await writeStore(corrupt);

    await assert.rejects(() => addSlide("id-uno", "<p>x</p>"), /corrupted/i);

    assert.equal(await readStoreRaw(), corrupt, "el archivo quedó intacto");
  });

  it("se recupera solo cuando el archivo vuelve a ser legible", async () => {
    await writeStore("roto");
    await assert.rejects(() => addSlide("id-uno", "<p>x</p>"));

    await writeStore(JSON.stringify(seedStore(), null, 2));
    const slide = await addSlide("id-uno", "<p>x</p>");

    assert.ok(slide);
    assert.equal((await listCarousels()).length, 3);
  });
});

describe("carousels — no reescribe por operaciones que no cambian nada", () => {
  it("updateSlide sobre un carrusel inexistente deja el archivo igual", async () => {
    const before = await readStoreRaw();

    const result = await updateSlide("no-existe", "tampoco", { html: "<p>x</p>" });

    assert.equal(result, null);
    assert.equal(await readStoreRaw(), before);
  });

  it("updateSlide sobre una lámina inexistente deja el archivo igual", async () => {
    const before = await readStoreRaw();

    const result = await updateSlide("id-uno", "no-existe", { html: "<p>x</p>" });

    assert.equal(result, null);
    assert.equal(await readStoreRaw(), before);
  });
});

describe("carousels — mutaciones concurrentes", () => {
  /**
   * Antes, leer y escribir fuera del mismo lock hacía que dos pedidos simultáneos
   * partieran de la misma base y el segundo pisara al primero: se perdían láminas
   * que la API ya había respondido como creadas. Es lo que pasa durante una
   * generación, cuando el agente agrega varias láminas seguidas.
   */
  it("no pierde láminas agregadas en paralelo", async () => {
    const total = 8;
    const slides = await Promise.all(
      Array.from({ length: total }, (_, i) => addSlide("id-uno", `<p>${i}</p>`))
    );

    assert.equal(slides.filter(Boolean).length, total, "todas las llamadas devolvieron lámina");

    const target = await getCarousel("id-uno");
    assert.equal(target?.slides.length, 1 + total, "todas quedaron persistidas");

    const orders = target!.slides.map((s) => s.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), "los order quedan consistentes");
  });

  it("no pierde carruseles creados en paralelo", async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => createCarousel(`paralelo-${i}`, "4:5"))
    );

    assert.equal((await listCarousels()).length, 3 + 6);
  });
});
