/**
 * Tests de la compactación del historial de deshacer. Corren con:
 *
 *     npm test
 *
 * El historial era el 75% de `carousels.json` en producción (20.9 MB de 28 MB): cada
 * versión es una copia COMPLETA del HTML de la lámina y el tope era 30. Como cada lectura
 * del store parsea el archivo entero, ese peso se pagaba en cada request.
 *
 * El bug de fondo que cubren estos tests no es el tamaño, es que el recorte NO CONVERGÍA.
 * Era `if (length > MAX) shift()`: un elemento por push. Con una pila ya en 30 y el tope
 * bajado a 5, el push la llevaba a 31, el shift la devolvía a 30, y ahí se quedaba para
 * siempre. Es decir que bajar la constante no compactaba nada — y una compactación de una
 * vez se habría vuelto a llenar hasta 30 sola.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
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
    if (specifier.startsWith(".") && !path.extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const ORIGINAL_CWD = process.cwd();
const workDir = await mkdtemp(path.join(tmpdir(), "oc-compactar-"));
await mkdir(path.join(workDir, "data"), { recursive: true });
process.chdir(workDir);

const { compactarHistorial, getCarousel, updateSlide } = await import("./carousels.ts");
const { MAX_VERSIONS } = await import("../types/carousel.ts");

const STORE = path.join(workDir, "data", "carousels.json");

/** Una lámina con `n` versiones guardadas, como quedaron las de producción. */
function seed(n: number, redo = 0) {
  return {
    carousels: [
      {
        id: "id-uno",
        name: "uno",
        aspectRatio: "4:5",
        slides: [
          {
            id: "slide-uno",
            html: "<p>actual</p>",
            previousVersions: Array.from({ length: n }, (_, i) => `<p>v${i}</p>`),
            redoVersions: Array.from({ length: redo }, (_, i) => `<p>r${i}</p>`),
            order: 0,
            notes: "",
          },
        ],
        referenceImages: [],
        chatSessionId: null,
        isTemplate: false,
        tags: [],
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    ],
  };
}

async function escribirStore(contenido: unknown) {
  await writeFile(STORE, JSON.stringify(contenido, null, 2), "utf-8");
}

before(() => {
  process.chdir(workDir);
});

after(() => {
  process.chdir(ORIGINAL_CWD);
});

beforeEach(async () => {
  await escribirStore(seed(30));
});

describe("recorte del historial al editar", () => {
  it("una pila ya por encima del tope CONVERGE al tope, no se queda arriba", async () => {
    // El bug: con `if (length > MAX) shift()` una pila de 30 y tope 5 se quedaba en 30
    // para siempre, así que bajar la constante no compactaba nada.
    const antes = await getCarousel("id-uno");
    assert.equal(antes?.slides[0].previousVersions.length, 30);

    await updateSlide("id-uno", "slide-uno", { html: "<p>editado</p>" });

    const despues = await getCarousel("id-uno");
    assert.equal(
      despues?.slides[0].previousVersions.length,
      MAX_VERSIONS,
      "una sola edición debe dejar la pila en el tope, no un elemento menos"
    );
  });

  it("conserva las versiones MÁS NUEVAS, no las más viejas", async () => {
    await updateSlide("id-uno", "slide-uno", { html: "<p>editado</p>" });

    const c = await getCarousel("id-uno");
    const pila = c!.slides[0].previousVersions;
    // Lo último que se apila es el html que había justo antes de editar.
    assert.equal(pila.at(-1), "<p>actual</p>");
    assert.equal(pila.at(-2), "<p>v29</p>", "debe quedar la punta nueva de la pila");
    assert.ok(!pila.includes("<p>v0</p>"), "las versiones viejas se descartan");
  });

  it("una pila por debajo del tope no se toca", async () => {
    await escribirStore(seed(2));

    await updateSlide("id-uno", "slide-uno", { html: "<p>editado</p>" });

    const c = await getCarousel("id-uno");
    assert.equal(c?.slides[0].previousVersions.length, 3, "2 + la que se acaba de apilar");
  });
});

describe("compactarHistorial", () => {
  it("el dry-run mide pero NO escribe", async () => {
    const crudoAntes = await readFile(STORE, "utf-8");

    const r = await compactarHistorial(5, false);

    assert.equal(r.aplicado, false);
    assert.equal(r.respaldo, null, "un dry-run no deja respaldo porque no toca nada");
    assert.ok(r.bytesDespues < r.bytesAntes, "debe informar el ahorro que lograría");
    assert.equal(
      await readFile(STORE, "utf-8"),
      crudoAntes,
      "el archivo no puede haber cambiado ni un byte"
    );
  });

  it("aplicado recorta de verdad y deja respaldo", async () => {
    const r = await compactarHistorial(5, true);

    assert.equal(r.aplicado, true);
    assert.equal(r.laminas, 1);
    assert.equal(r.laminasRecortadas, 1);
    assert.equal(r.versionesDescartadas, 25);
    assert.ok(r.respaldo?.startsWith("carousels.pre-compact-"), "debe nombrar el respaldo");

    const c = await getCarousel("id-uno");
    assert.equal(c?.slides[0].previousVersions.length, 5);

    // El respaldo tiene que servir para volver atrás: debe conservar las 30.
    const respaldado = JSON.parse(
      await readFile(path.join(workDir, "data", r.respaldo!), "utf-8")
    );
    assert.equal(
      respaldado.carousels[0].slides[0].previousVersions.length,
      30,
      "el respaldo debe tener el historial completo de antes"
    );
  });

  it("conservar 0 vacía el historial (slice(-0) devolvería todo)", async () => {
    // `slice(-0)` es `slice(0)`: el array ENTERO. Con esa trampa, pedir 0 no borraba nada.
    const r = await compactarHistorial(0, true);

    assert.equal(r.versionesDescartadas, 30);
    const c = await getCarousel("id-uno");
    assert.equal(c?.slides[0].previousVersions.length, 0);
  });

  it("no cuenta de menos cuando una pila ya está por debajo del tope", async () => {
    // previas=2 con tope 5 descarta 0, no -3. Sumado crudo, ese -3 restaba de lo que
    // descartaba la pila de rehacer y el informe salía por debajo de lo real.
    await escribirStore(seed(2, 10));

    const r = await compactarHistorial(5, false);

    assert.equal(r.versionesDescartadas, 5, "0 de deshacer + 5 de rehacer");
  });

  it("rechaza un tope que no es un entero >= 0", async () => {
    await assert.rejects(() => compactarHistorial(-1, true), /entero >= 0/);
    await assert.rejects(() => compactarHistorial(2.5, true), /entero >= 0/);
  });
});
