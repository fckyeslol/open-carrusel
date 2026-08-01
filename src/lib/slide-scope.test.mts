/**
 * Tests del acotado de una lámina para el documento multi-lámina (PDF / HTML / SVG).
 *
 *     npm test
 *
 * Los dos fallos que motivaron el archivo eran silenciosos: el PDF de un carrusel de 7
 * láminas salía de 1 página (el `html,body{overflow:hidden}` de la lámina recortaba el
 * documento entero), y todas las páginas terminaban del color de la ÚLTIMA lámina (las
 * láminas comparten nombres de clase y ganaba la de más abajo en la cascada).
 *
 * Por eso los tests miran el CSS resultante y no píxeles: es ahí donde las láminas se
 * pisaban. El resultado renderizado lo verifica `npm run check:export`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./test-resolve.mts";

const { scopeCss, toPageBody, esDocumentoCompleto } = await import("./slide-scope.ts");

describe("scopeCss", () => {
  it("acota una clase a la página", () => {
    assert.equal(scopeCss(".s{color:red}", "#oc-p1"), "#oc-p1 .s{color:red}");
  });

  it("reencauza html,body a la página en vez de borrarlo", () => {
    // De acá salen el fondo y el tamaño de la lámina: borrarlos la deja transparente.
    const out = scopeCss("html,body{width:1080px;height:1350px;background:#F6F5F0}", "#oc-p2");
    assert.match(out, /#oc-p2\{/);
    assert.match(out, /background:#F6F5F0/);
    assert.doesNotMatch(out, /\bhtml\b/);
    assert.doesNotMatch(out, /\bbody\b/);
  });

  it("se come la raíz sin encadenarla: body .t no queda como #p body .t", () => {
    const out = scopeCss("body .t{font-size:96px}", "#oc-p1");
    assert.equal(out, "#oc-p1 .t{font-size:96px}");
  });

  it(":root también apunta a la página", () => {
    assert.match(scopeCss(":root{--c:#000}", "#oc-p1"), /^#oc-p1\{/);
  });

  it("el reset * alcanza a la página y a sus hijos", () => {
    const out = scopeCss("*{margin:0;padding:0;box-sizing:border-box}", "#oc-p3");
    assert.match(out, /#oc-p3\s*,\s*#oc-p3 \*/);
  });

  it("no toca el nombre de una @font-face", () => {
    const css = "@font-face{font-family:'Inter';src:url(data:font/woff2;base64,AAA)}";
    const out = scopeCss(css, "#oc-p1");
    assert.match(out, /@font-face/);
    // css-tree normaliza las comillas al regenerar: `'Inter'` sale como `"Inter"`.
    assert.match(out, /font-family:["']Inter["']/);
    assert.doesNotMatch(out, /#oc-p1[^{]*@font-face/);
  });

  it("no toca los pasos de un @keyframes", () => {
    // `from`/`to` son selectores de keyframe, no elementos: acotarlos rompe la animación.
    const out = scopeCss("@keyframes giro{from{opacity:0}to{opacity:1}}", "#oc-p1");
    assert.doesNotMatch(out, /#oc-p1 from/);
    assert.match(out, /from\{opacity:0\}/);
  });

  it("entra a una @media y acota lo de adentro", () => {
    const out = scopeCss("@media print{.s{color:red}}", "#oc-p1");
    assert.match(out, /@media print\{#oc-p1 \.s\{color:red\}\}/);
  });

  it("acota cada selector de una lista", () => {
    const out = scopeCss(".a,.b{color:red}", "#oc-p1");
    assert.match(out, /#oc-p1 \.a/);
    assert.match(out, /#oc-p1 \.b/);
  });

  it("un CSS impresentable se devuelve tal cual en vez de tirar el export", () => {
    const roto = "esto no es css {{{";
    assert.equal(typeof scopeCss(roto, "#oc-p1"), "string");
  });
});

describe("esDocumentoCompleto", () => {
  it("reconoce una lámina guardada como documento", () => {
    assert.ok(esDocumentoCompleto('<!DOCTYPE html><html><head></head><body><p>x</p></body></html>'));
    assert.ok(esDocumentoCompleto('<html lang="es"><body>x</body></html>'));
  });

  it("una lámina a nivel body no lo es", () => {
    assert.ok(!esDocumentoCompleto('<div class="s">hola</div>'));
    assert.ok(!esDocumentoCompleto("<style>.s{color:red}</style><div>x</div>"));
  });
});

describe("toPageBody", () => {
  const DOC = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
<style>html,body{width:1080px;height:1350px;overflow:hidden;background:#FFD400}
.s{padding:80px}</style></head>
<body><div class="s">Lamina</div></body></html>`;

  it("desanida el documento y deja solo el cuerpo", () => {
    const out = toPageBody(DOC, "#oc-p1");
    assert.doesNotMatch(out, /<!DOCTYPE/i);
    assert.doesNotMatch(out, /<html/i);
    assert.doesNotMatch(out, /<body/i);
    assert.match(out, /<div class="s">Lamina<\/div>/);
  });

  it("conserva los estilos del head, acotados", () => {
    const out = toPageBody(DOC, "#oc-p1");
    assert.match(out, /#oc-p1 \.s\{padding:80px\}/);
    assert.match(out, /background:#FFD400/);
  });

  it("descarta el <link> remoto a Google Fonts", () => {
    // El documento multi-lámina inlinea las fuentes; una hoja remota que llega tarde
    // puede pisarlas justo antes de imprimir.
    assert.doesNotMatch(toPageBody(DOC, "#oc-p1"), /fonts\.googleapis/);
  });

  it("el overflow:hidden de la lámina ya no puede recortar el documento", () => {
    const out = toPageBody(DOC, "#oc-p1");
    assert.doesNotMatch(out, /html\s*,\s*body/);
    assert.match(out, /#oc-p1\{[^}]*overflow:hidden/);
  });

  it("una lámina a nivel body pasa igual, pero con su CSS acotado", () => {
    const body = '<style>.s{background:#F6F5F0}</style><div class="s">x</div>';
    const out = toPageBody(body, "#oc-p2");
    assert.match(out, /#oc-p2 \.s\{background:#F6F5F0\}/);
    assert.match(out, /<div class="s">x<\/div>/);
  });

  it("dos láminas con la misma clase no se pisan", () => {
    // El fallo real: el agente genera cada lámina por separado y reusa `.s`.
    const a = toPageBody('<style>.s{background:#FFF}</style><div class="s">a</div>', "#oc-p1");
    const b = toPageBody('<style>.s{background:#000}</style><div class="s">b</div>', "#oc-p2");
    const doc = a + b;
    assert.match(doc, /#oc-p1 \.s\{background:#FFF\}/);
    assert.match(doc, /#oc-p2 \.s\{background:#000\}/);
  });

  it("no toca los estilos inline", () => {
    const body = '<div style="color:red">x</div>';
    assert.match(toPageBody(body, "#oc-p1"), /style="color:red"/);
  });

  it("un documento sin <body> explícito igual se desanida", () => {
    const out = toPageBody("<html><head><style>.s{color:red}</style></head><p>x</p></html>", "#oc-p1");
    assert.doesNotMatch(out, /<html/i);
    assert.match(out, /<p>x<\/p>/);
    assert.match(out, /#oc-p1 \.s/);
  });
});
