/**
 * Tests del contrato de fuentes entre preview, editor y export.
 *
 *     npm test
 *
 * El foco está en el fallo que motivó el archivo: el editor pedía a Google Fonts el eje
 * `ital` y el export NO, así que toda lámina con `font-style: italic` exportaba con la
 * itálica FALSEADA por Chrome (inclina la recta) y la letra salía más ancha que en
 * pantalla. Nada fallaba: el PNG se generaba igual, solo estaba mal.
 *
 * Por eso los tests de acá no miran píxeles sino la FORMA DEL PEDIDO, que es donde las dos
 * rutas se separaron. La paridad de píxeles se verifica aparte con scripts/render-parity.mjs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./test-resolve.mts";

const { extractFontFamilies, googleFontAxes, googleFontFamilyParam, usesItalic, FONT_WEIGHTS } =
  await import("./slide-html.ts");

describe("googleFontAxes", () => {
  it("pide todos los grosores", () => {
    for (const w of FONT_WEIGHTS) {
      assert.match(googleFontAxes(false), new RegExp(`(^|;|@)${w}(;|$)`));
    }
  });

  it("sin itálica no incluye el eje ital", () => {
    assert.equal(googleFontAxes(false), `wght@${FONT_WEIGHTS.join(";")}`);
    assert.doesNotMatch(googleFontAxes(false), /ital/);
  });

  it("con itálica pide cada grosor en recta Y en cursiva", () => {
    const axes = googleFontAxes(true);
    assert.match(axes, /^ital,wght@/);
    for (const w of FONT_WEIGHTS) {
      assert.ok(axes.includes(`0,${w}`), `falta la recta ${w}`);
      assert.ok(axes.includes(`1,${w}`), `falta la cursiva ${w}`);
    }
  });

  it("el fragmento family= escapa el espacio del nombre", () => {
    assert.match(googleFontFamilyParam("Playfair Display"), /^family=Playfair%20Display:/);
  });
});

describe("usesItalic", () => {
  it("detecta la declaración larga y la forma corta", () => {
    assert.equal(usesItalic(`<p style="font-style: italic">x</p>`), true);
    assert.equal(usesItalic(`<p style="font: italic 700 40px Inter">x</p>`), true);
  });

  it("detecta una clase declarada en un <style>", () => {
    assert.equal(usesItalic(`<style>.q{font-style:italic}</style><p class="q">x</p>`), true);
  });

  it("detecta <em> y <i>", () => {
    assert.equal(usesItalic("<p>de <em>verdad</em></p>"), true);
    assert.equal(usesItalic("<p>de <i>verdad</i></p>"), true);
  });

  it("no confunde <img> ni <iframe> con <i>", () => {
    assert.equal(usesItalic(`<img src="/uploads/a.png">`), false);
    assert.equal(usesItalic(`<iframe></iframe>`), false);
  });

  it("una lámina sin itálica no arrastra las caras cursivas", () => {
    assert.equal(usesItalic(`<h1 style="font-family:'Inter';font-weight:900">HOLA</h1>`), false);
  });
});

describe("extractFontFamilies", () => {
  it("saca las familias de un stack con comillas simples", () => {
    assert.deepEqual(
      extractFontFamilies(`<h1 style="font-family:'Playfair Display',serif">x</h1>`),
      ["Playfair Display"]
    );
  });

  it("desescapa las comillas que serializa el editor", () => {
    // El DOM guarda el atributo como font-family:&quot;Bricolage Grotesque&quot;. El `;`
    // de la entidad cortaba el token y la familia extraída era el literal `&quot`: la real
    // nunca se pedía y esa lámina exportaba con fuente de sistema.
    assert.deepEqual(
      extractFontFamilies(`<div style="font-family: &quot;Bricolage Grotesque&quot;;">x</div>`),
      ["Bricolage Grotesque"]
    );
  });

  it("nunca devuelve una entidad HTML como nombre de familia", () => {
    const html = `<div style="font-family: &quot;Inter&quot;;">a</div><p style="font-family:&#39;Anton&#39;">b</p>`;
    const fams = extractFontFamilies(html);
    assert.deepEqual(fams, ["Inter", "Anton"]);
    assert.ok(!fams.some((f) => f.startsWith("&")), `entidad filtrada: ${fams.join(",")}`);
  });

  it("descarta las genéricas y no se traga el cierre del atributo", () => {
    assert.deepEqual(
      extractFontFamilies(`<h1 style="font-family:'Inter',sans-serif">a</h1><p>b</p>`),
      ["Inter"]
    );
  });

  it("ignora una font-family mencionada en un comentario", () => {
    assert.deepEqual(extractFontFamilies(`<!-- font-family: Comic Sans -->`), []);
  });
});
