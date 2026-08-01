/**
 * Tests del caché de lecturas de `data.ts`. Corren con el runner nativo de Node:
 *
 *     npm test
 *
 * Cubren la caída que se repetía en producción hasta 10 veces por día. `carousels.json`
 * llegó a 28 MB y cada `GET /api/carousels/{id}` parseaba el archivo COMPLETO sin caché;
 * ~40 tarjetas del tablero polleando disparaban ~40 parseos simultáneos y el heap de V8
 * reventaba (`FATAL ERROR: Reached heap limit`, `exit(134)`). Con `min=max=1` en Cloud Run
 * cada muerte era una caída total que además se llevaba las generaciones en vuelo.
 *
 * Lo que se prueba acá no es velocidad, es lo que hace que el arreglo sea correcto:
 * que los lectores concurrentes compartan UN parseo, que una escritura invalide, que un
 * cambio hecho por afuera se note, y que las mutaciones no toquen el objeto que los
 * lectores comparten por referencia.
 *
 * El módulo se carga con `await import()` DESPUÉS del `chdir` y del hook de resolución,
 * no con un `import` estático: los imports de ESM se hoistean y `data.ts` calcula su
 * DATA_DIR desde `process.cwd()` al cargarse.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
const workDir = await mkdtemp(path.join(tmpdir(), "oc-data-cache-"));
await mkdir(path.join(workDir, "data"), { recursive: true });
process.chdir(workDir);

const { readDataSafe, updateData } = await import("./data.ts");
const { getCarousel, updateSlide } = await import("./carousels.ts");

const FILE = "cache-probe.json";
const PROBE = path.join(workDir, "data", FILE);
const CAROUSELS = path.join(workDir, "data", "carousels.json");

interface Probe {
  valor: string;
  relleno?: string[];
}

const EMPTY: Probe = { valor: "" };

/** Escribe el archivo por afuera de la app, como lo haría otro proceso. */
async function escribirPorAfuera(contenido: Probe): Promise<void> {
  await writeFile(PROBE, JSON.stringify(contenido, null, 2), "utf-8");
}

function seedCarousel(html: string) {
  return {
    carousels: [
      {
        id: "id-uno",
        name: "uno",
        aspectRatio: "4:5",
        slides: [
          { id: "slide-uno", html, previousVersions: [], order: 0, notes: "" },
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

before(() => {
  process.chdir(workDir);
});

after(() => {
  process.chdir(ORIGINAL_CWD);
});

beforeEach(async () => {
  await escribirPorAfuera({ valor: "inicial" });
  await writeFile(CAROUSELS, JSON.stringify(seedCarousel("<p>viejo</p>"), null, 2), "utf-8");
});

describe("caché de lecturas de data.ts", () => {
  it("colapsa las lecturas concurrentes en un solo parseo", async () => {
    // La identidad del objeto es la prueba: si cada lectura hubiera parseado por su
    // cuenta, cada una tendría su propio grafo de objetos. Eso es exactamente lo que
    // hacía reventar el heap con ~40 tarjetas pidiendo a la vez.
    const [a, b, c] = await Promise.all([
      readDataSafe<Probe>(FILE, EMPTY),
      readDataSafe<Probe>(FILE, EMPTY),
      readDataSafe<Probe>(FILE, EMPTY),
    ]);

    assert.equal(a.valor, "inicial");
    assert.equal(a, b, "las lecturas concurrentes deben compartir el mismo parseo");
    assert.equal(b, c, "las lecturas concurrentes deben compartir el mismo parseo");
  });

  it("no vuelve a parsear cuando el archivo no cambió", async () => {
    const primera = await readDataSafe<Probe>(FILE, EMPTY);
    const segunda = await readDataSafe<Probe>(FILE, EMPTY);

    assert.equal(primera, segunda, "sin cambios en el archivo debe servir lo ya parseado");
  });

  it("una escritura de la app invalida: la lectura siguiente ve lo nuevo", async () => {
    const antes = await readDataSafe<Probe>(FILE, EMPTY);
    assert.equal(antes.valor, "inicial");

    await updateData<Probe>(FILE, EMPTY, () => ({ valor: "escrito por la app" }));

    const despues = await readDataSafe<Probe>(FILE, EMPTY);
    assert.equal(despues.valor, "escrito por la app");
  });

  it("detecta un cambio hecho por afuera del proceso", async () => {
    const antes = await readDataSafe<Probe>(FILE, EMPTY);
    assert.equal(antes.valor, "inicial");

    // Otro proceso (o una restauración a mano) reescribe el archivo. El caché no fue
    // avisado, así que la validación por mtime+tamaño es lo único que lo puede notar.
    await escribirPorAfuera({ valor: "cambiado por afuera", relleno: ["a", "b", "c"] });

    const despues = await readDataSafe<Probe>(FILE, EMPTY);
    assert.equal(despues.valor, "cambiado por afuera");
  });

  it("mutar por updateData no toca el objeto que ya tienen los lectores", async () => {
    // El peligro real del caché: se entrega POR REFERENCIA. Varios stores mutan en el
    // lugar dentro de `mutate` (`slide.previousVersions.push(...)`), así que si
    // `updateData` partiera del objeto cacheado, publicaría la mutación en el store en
    // memoria de todos los lectores — antes de escribir, y hasta si no escribe.
    const leido = await getCarousel("id-uno");
    assert.equal(leido?.slides[0].html, "<p>viejo</p>");
    assert.equal(leido?.slides[0].previousVersions.length, 0);

    await updateSlide("id-uno", "slide-uno", { html: "<p>nuevo</p>" });

    assert.equal(
      leido?.slides[0].html,
      "<p>viejo</p>",
      "el objeto que ya tenía el lector no debe haber cambiado bajo sus pies"
    );
    assert.equal(
      leido?.slides[0].previousVersions.length,
      0,
      "la pila de undo del objeto leído no debe haber crecido"
    );

    const releido = await getCarousel("id-uno");
    assert.equal(releido?.slides[0].html, "<p>nuevo</p>", "la relectura sí ve el cambio");
  });
});
