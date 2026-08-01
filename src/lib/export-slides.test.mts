/**
 * Tests del inlineado de imágenes del export.
 *
 *     npm test
 *
 * Lo que se protege acá es la garantía de la que depende TODO el seam de render: el HTML que
 * llega a Chrome no necesita la red. Se renderiza con `setContent` y sin base URL, en un
 * proceso que puede ser otro contenedor, así que una referencia que no se inlinee no es
 * "una imagen lenta": es una imagen que puede no estar cuando se dispara la captura.
 *
 * El fallo que motivó el archivo: el editor guarda las fotos como URL ABSOLUTA
 * (`https://carruseles.30x.com/uploads/x.png` — 258 láminas en producción) y el inlineado
 * solo miraba rutas que empiezan con `/`. Esas láminas exportaban sin la foto: PNG de 22KB
 * en vez de 2.3MB, con `complete=false` y `naturalWidth=0` al momento de capturar. En el
 * editor se veían bien, porque ahí el navegador sí espera a que baje.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./test-resolve.mts";

const { inlineImages } = await import("./export-slides.ts");

/** Archivos que existen de verdad en public/ (chicos, para no inflar el test). */
const SVG = "/30x/logo-dark.svg";
const PNG = "/textures/cuadricula.png";

const esDataUri = (html: string, mime: string) =>
  new RegExp(`data:${mime.replace("+", "\\+")};base64,[A-Za-z0-9+/=]{40,}`).test(html);

describe("inlineImages", () => {
  it("inlinea una ruta root-relative", async () => {
    const out = await inlineImages(`<img src="${SVG}">`);
    assert.ok(esDataUri(out, "image/svg+xml"), out.slice(0, 120));
    assert.ok(!out.includes(SVG), "no debe quedar la ruta original");
  });

  it("inlinea una URL ABSOLUTA al propio sitio", async () => {
    // El bug: esto salía sin tocar y la lámina exportaba sin la foto.
    const out = await inlineImages(`<img src="https://carruseles.30x.com${PNG}">`);
    assert.ok(esDataUri(out, "image/png"), out.slice(0, 120));
    assert.ok(!out.includes("carruseles.30x.com"), "no debe quedar la URL original");
  });

  it("inlinea la URL absoluta cualquiera sea el host, porque lo que decide es el archivo", async () => {
    // Sin allowlist de dominios: funciona igual en producción, en localhost y en un
    // dominio futuro, sin configuración que se pueda olvidar de actualizar.
    for (const base of ["http://localhost:3000", "https://otro-dominio.example"]) {
      const out = await inlineImages(`<img src="${base}${SVG}">`);
      assert.ok(esDataUri(out, "image/svg+xml"), `falló con ${base}`);
    }
  });

  it("inlinea el url() de CSS, con las comillas escapadas como entidad", async () => {
    // Así lo serializa el navegador cuando el editor guarda un background.
    const out = await inlineImages(
      `<div style="background:url(&quot;https://carruseles.30x.com${PNG}&quot;)"></div>`
    );
    assert.ok(esDataUri(out, "image/png"), out.slice(0, 160));
  });

  it("reemplaza TODAS las apariciones de la misma imagen", async () => {
    const out = await inlineImages(`<img src="${SVG}"><img src="${SVG}">`);
    assert.equal(out.match(/data:image\/svg\+xml;base64,/g)?.length, 2);
    assert.ok(!out.includes(SVG));
  });

  it("deja como vino lo que no está en public/", async () => {
    // Una imagen genuinamente externa se deja para que la baje el navegador; de que esté
    // cargada antes de capturar se encarga `imagesReadyPredicate` del contrato de render.
    const externa = "https://images.example.com/foto.jpg";
    const out = await inlineImages(`<img src="${externa}"><img src="/uploads/no-existe.png">`);
    assert.ok(out.includes(externa));
    assert.ok(out.includes("/uploads/no-existe.png"));
  });

  it("NO mete el base64 en los atributos de metadata del editor", async () => {
    // `data-oc-imghist` es el historial de imágenes del editor: nadie lo pinta. Antes se
    // reemplazaba con replaceAll sobre todo el documento, así que un base64 de 1MB entraba
    // ahí también e inflaba el HTML que cruza el seam de render sin pintar nada.
    const out = await inlineImages(
      `<img src="${PNG}" data-oc-imghist="[&quot;${PNG}&quot;]">`
    );
    assert.ok(esDataUri(out, "image/png"), "la carga real sí se inlinea");
    assert.ok(
      out.includes(`data-oc-imghist="[&quot;${PNG}&quot;]"`),
      "el atributo de metadata queda intacto"
    );
    assert.equal(out.match(/data:image\/png;base64,/g)?.length, 1);
  });

  it("no lee fuera de public/ con ../", async () => {
    const out = await inlineImages(`<img src="/../package.json.png">`);
    assert.ok(!out.includes("base64"), "no debe inlinear nada de afuera de public/");
  });

  it("devuelve el html intacto cuando no hay ninguna imagen local", async () => {
    const html = `<div class="s"><p>sin imágenes</p></div>`;
    assert.equal(await inlineImages(html), html);
  });
});
