/**
 * Tests de las reglas 30x del detector de calidad.
 *
 *     npm test
 *
 * Foco: la regla del VELO sobre una imagen generada, que es la que corresponde al
 * defecto más caro del reporte de las diseñadoras ("la generadora copia el referente,
 * deja el texto y solo lo tapa con una sombra rectangular"). Mira el HTML crudo, así
 * que lo que hay que proteger es que la señal no se dispare sobre los usos legítimos
 * del degradado — que son la mayoría.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { correrReglas30x } = await import("./slide-rules.mjs");

const CTX = { aspectRatio: "4:5", dimensiones: { width: 1080, height: 1350 } };

/** Solo los hallazgos de la regla del velo (las otras reglas corren igual). */
function velos(html: string) {
  return correrReglas30x(html, CTX).filter(
    (h: { antipattern: string }) => h.antipattern === "slide-velo-sobre-imagen-generada"
  );
}

describe("velo sobre una imagen generada", () => {
  it("marca el degradado negro a sangre encima de una imagen generada", () => {
    const html = `
      <div style="position:relative;width:1080px;height:1350px">
        <img src="/uploads/generated/abc123.jpg" style="position:absolute;inset:0;width:1080px;height:1350px">
        <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 40%,rgba(0,0,0,.85) 100%)"></div>
      </div>`;
    const h = velos(html);
    assert.equal(h.length, 1);
    assert.equal(h[0].severity, "warning", "es una señal, no una prueba: no puede bloquear");
    assert.match(h[0].description, /referenceCrop/, "tiene que decir cómo se arregla");
  });

  it("marca también el negro translúcido plano", () => {
    const html = `
      <img src="/uploads/generated/x.jpg">
      <div style="position:absolute;inset:0;background-color:rgba(0,0,0,0.55)"></div>`;
    assert.equal(velos(html).length, 1);
  });

  it("reconoce el velo escrito con top/left/width/height en vez de inset", () => {
    const html = `
      <img src="/uploads/generated/x.jpg">
      <div style="position:absolute;top:0;left:0;width:100%;height:100%;background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.7))"></div>`;
    assert.equal(velos(html).length, 1);
  });

  // ── Lo que NO se puede marcar ───────────────────────────────────────────────
  // La regla vale por lo que deja pasar: un aviso que salta en toda lámina con una
  // foto se vuelve ruido y se ignora, incluidas las veces que tiene razón.

  it("no dice nada si la imagen NO es generada (una subida a mano es cosa de la diseñadora)", () => {
    const html = `
      <img src="/uploads/foto-subida.jpg">
      <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.85))"></div>`;
    assert.equal(velos(html).length, 0);
  });

  it("no dice nada sin velo: una imagen generada sola está perfecta", () => {
    const html = `
      <img src="/uploads/generated/x.jpg" style="position:absolute;inset:0">
      <h1 style="position:absolute;bottom:120px;left:108px;color:#fff">Titular</h1>`;
    assert.equal(velos(html).length, 0);
  });

  it("no confunde un degradado de COLOR de la paleta con un velo", () => {
    const html = `
      <img src="/uploads/generated/x.jpg">
      <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,212,0,0),rgba(255,212,0,.9))"></div>`;
    assert.equal(velos(html).length, 0, "solo el negro apaga una imagen para tapar algo");
  });

  it("no marca un degradado chico, que no puede estar tapando la imagen entera", () => {
    const html = `
      <img src="/uploads/generated/x.jpg">
      <div style="position:absolute;bottom:0;left:0;width:100%;height:220px;background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.8))"></div>`;
    assert.equal(velos(html).length, 0);
  });

  it("un fondo negro OPACO no es un velo: no deja nada abajo para tapar", () => {
    const html = `
      <img src="/uploads/generated/x.jpg">
      <div style="position:absolute;inset:0;background:#000000"></div>`;
    assert.equal(velos(html).length, 0);
  });
});
