/**
 * Tests del contrato de render compartido entre la app y el servicio de render.
 *
 *     npm test
 *
 * `fontsReadyPredicate` corre DENTRO de la página (`page.waitForFunction`), así que acá se
 * le pasa un `document.fonts` de mentira. El fallo que motivó el archivo: el predicado
 * exigía que TODAS las caras estuvieran `loaded`, y el CSS inlineado de una familia trae
 * ~63 caras (grosor × subset) de las que una lámina usa dos. Las demás nunca se bajan, así
 * que el predicado era falso hasta que expiraba el timeout: 10s tirados en cada export.
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import "./test-resolve.mts";

const { fontsReadyPredicate, imagesReadyPredicate, decodeImagesInPage, CONTRACT_VERSION } =
  await import("./slide-render-contract.mjs");

/** Monta un `document.fonts` con los estados dados y devuelve el resultado del predicado. */
async function conFuentes(estados: string[]): Promise<boolean> {
  const caras = estados.map((status) => ({ status }));
  (globalThis as { document?: unknown }).document = {
    fonts: {
      ready: Promise.resolve(),
      [Symbol.iterator]: () => caras[Symbol.iterator](),
    },
  };
  return fontsReadyPredicate();
}

/** Monta un `document` con las `<img>` dadas. */
function conImagenes(imgs: unknown[]): void {
  (globalThis as { document?: unknown }).document = {
    querySelectorAll: () => imgs,
  };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe("fontsReadyPredicate", () => {
  it("no espera a las caras que nadie usó", async () => {
    // El caso real: 2 caras en uso, 61 que el navegador nunca va a bajar.
    const estados = ["loaded", "loaded", ...Array(61).fill("unloaded")];
    assert.equal(await conFuentes(estados), true);
  });

  it("espera mientras haya una cara en vuelo", async () => {
    assert.equal(await conFuentes(["loaded", "loading", "unloaded"]), false);
  });

  it("una cara que falló no bloquea para siempre", async () => {
    // `error` es terminal: seguir esperándola es garantizar el timeout.
    assert.equal(await conFuentes(["loaded", "error"]), true);
  });

  it("sin fuentes declaradas resuelve en true", async () => {
    assert.equal(await conFuentes([]), true);
  });
});

describe("imagesReadyPredicate", () => {
  it("espera mientras una imagen siga en vuelo", () => {
    // El caso real: la foto guardada como URL absoluta bajando por red mientras la captura
    // ya se disparó. Salía un PNG de 22KB con la lámina vacía.
    conImagenes([{ complete: true }, { complete: false }]);
    assert.equal(imagesReadyPredicate(), false);
  });

  it("resuelve cuando ya no queda ninguna en vuelo", () => {
    conImagenes([{ complete: true }, { complete: true }]);
    assert.equal(imagesReadyPredicate(), true);
  });

  it("una imagen que falló no bloquea para siempre", () => {
    // Un 404 deja `complete: true` con `naturalWidth: 0`. Exigir píxeles la haría esperar
    // 20s por lámina para terminar capturando exactamente lo mismo.
    conImagenes([{ complete: true, naturalWidth: 0 }]);
    assert.equal(imagesReadyPredicate(), true);
  });

  it("una lámina sin imágenes no espera nada", () => {
    conImagenes([]);
    assert.equal(imagesReadyPredicate(), true);
  });
});

describe("decodeImagesInPage", () => {
  it("espera el decode de todas las imágenes", async () => {
    let decodificadas = 0;
    const img = () => ({
      decode: () => {
        decodificadas++;
        return Promise.resolve();
      },
    });
    conImagenes([img(), img(), img()]);
    await decodeImagesInPage();
    assert.equal(decodificadas, 3);
  });

  it("un decode que rechaza no aborta el render", async () => {
    // `decode()` rechaza en una imagen que falló. Sin el catch, esa promesa tumbaría el
    // render de una lámina que igual se puede entregar con el resto de su contenido.
    conImagenes([
      { decode: () => Promise.reject(new Error("imagen rota")) },
      { decode: () => Promise.resolve() },
    ]);
    await decodeImagesInPage();
  });
});

describe("CONTRACT_VERSION", () => {
  it("es un entero positivo", () => {
    assert.ok(Number.isInteger(CONTRACT_VERSION) && CONTRACT_VERSION > 0);
  });
});
