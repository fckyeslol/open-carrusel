#!/usr/bin/env node
/**
 * ¿Cuánto de lo que hay en una lámina se puede TOMAR y EDITAR?
 *
 *   node scripts/probe-editor.mjs          (npm run probe:editor)
 *
 * `check:editor` prueba el runtime contra láminas sintéticas: responde "¿funciona
 * la mecánica?". Esto responde la otra pregunta, la que las diseñadoras hacen:
 * "¿cuántas de MIS láminas tienen algo que no puedo tocar?". Corre el runtime real
 * en Chromium sobre `data/carousels.json` y cuenta.
 *
 * Existe porque el problema #1 del reporte de las diseñadoras ("las cajas de texto
 * no siempre son editables") era invisible para todos los checks que había: cada
 * arreglo se sentía correcto y nadie podía decir cuánto había mejorado. Con esto la
 * respuesta es un número comparable entre commits:
 *
 *   texto no editable      44/276  →  15/276 (PR #13)  →  8/276
 *   velo inalcanzable      77/276  →  ?
 *
 * El corpus es el de la máquina donde corre, así que el número absoluto solo se
 * compara consigo mismo. Sirve como antes/después de un cambio, no como métrica
 * entre máquinas.
 */
import { readFile } from "fs/promises";
import path from "path";
import puppeteer from "puppeteer";

const ROOT = process.cwd();
const W = 1080;
const H = 1350;

/** Saca EDITOR_RUNTIME del fuente TS (mismo criterio que check-editor.mjs). */
async function loadRuntime() {
  const src = await readFile(path.join(ROOT, "src/lib/slide-editor.ts"), "utf8");
  const start = src.indexOf("export const EDITOR_RUNTIME = String.raw`");
  if (start < 0) throw new Error("No se encontró EDITOR_RUNTIME en slide-editor.ts");
  const from = src.indexOf("`", start) + 1;
  const end = src.indexOf("\n`;", from);
  return src.slice(from, end).replace(/\$\{GF_ITAL_WGHT\}/g, "wght@400");
}

/**
 * Las láminas guardadas vienen en dos formas: a nivel body (lo que pide el system
 * prompt) y documento completo (110 de 276 salieron así igual). Para la sonda basta
 * con desanidar y arrastrar los <style> del head.
 */
function bodyOf(html) {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let out = m ? m[1] : html;
  const styles = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)].map((s) => s[0]).join("\n");
  if (m && styles) out = styles + out;
  return out.replace(/<script[\s\S]*?<\/script>/gi, "");
}

const runtime = await loadRuntime();
const data = JSON.parse(await readFile(path.join(ROOT, "data/carousels.json"), "utf8"));
const carousels = data.carousels || data;

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const T = { slides: 0, slTexto: 0, texto: 0, slVelo: 0, velos: 0 };
const ejTexto = [], ejVelo = [];

for (const c of carousels) {
  for (const s of c.slides || []) {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden;position:relative}
</style></head><body>${bodyOf(s.html || "")}<script>${runtime}<\/script></body></html>`;
    try {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 35));
    } catch {
      continue;
    }
    T.slides++;

    const res = await page.evaluate(
      (Wv, Hv) => {
        const INLINE = {BR:1,SPAN:1,STRONG:1,EM:1,B:1,I:1,A:1,U:1,S:1,SMALL:1,SUB:1,
                        SUP:1,MARK:1,FONT:1,WBR:1,ABBR:1,CODE:1,DEL:1,INS:1};
        // Mismo rootEl() del runtime: el contenedor de la lámina no es un objeto.
        const rootEl = (() => {
          for (const k of document.body.children)
            if (!k.hasAttribute("data-oc-ui") && !k.hasAttribute("data-oc-tex") &&
                !["SCRIPT", "STYLE", "LINK"].includes(k.tagName)) return k;
          return document.body;
        })();
        const vis = (el) => {
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          return r.width > 4 && r.height > 4 && r.left < Wv && r.top < Hv &&
                 r.right > 0 && r.bottom > 0 && cs.visibility !== "hidden" &&
                 cs.display !== "none" && parseFloat(cs.opacity) > 0.05;
        };
        const tooBig = (el) => {
          const r = el.getBoundingClientRect();
          return r.width * r.height > Wv * Hv * 0.8;
        };
        const looksText = (el) => {
          if (!el || el.tagName === "IMG" || el.ownerSVGElement) return false;
          if (el.tagName.toLowerCase() === "svg") return false;
          if ((el.textContent || "").trim().length === 0) return false;
          for (const k of el.children) {
            if (INLINE[k.tagName]) continue;
            if ((k.textContent || "").trim().length === 0) continue;  // hijo atómico
            return false;
          }
          return true;
        };
        const ev = (el, type, x, y, d = 1) =>
          el?.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, detail: d }));
        const clickAt = (x, y) => {
          const el = document.elementFromPoint(x, y);
          ev(el, "mousedown", x, y); ev(el, "mouseup", x, y); ev(el, "click", x, y);
        };
        const dblAt = (x, y) => {
          clickAt(x, y);
          ev(document.elementFromPoint(x, y), "dblclick", x, y, 2);
        };
        const clear = () => { window.postMessage({ oc: "deselect" }, "*"); clickAt(1, 1); };

        const all = [...document.body.querySelectorAll("*")].filter(
          (el) => el !== rootEl && !el.hasAttribute("data-oc-ui") && !el.closest("[data-oc-ui]")
        );
        const texto = [], velos = [];

        for (const el of all) {
          if (!vis(el)) continue;
          const r = el.getBoundingClientRect();
          const cx = Math.min(Wv - 2, Math.max(2, r.left + r.width / 2));
          const cy = Math.min(Hv - 2, Math.max(2, r.top + r.height / 2));
          const cs = getComputedStyle(el);

          // ── ¿el texto entra en edición con doble clic? ──
          if (looksText(el)) {
            clear();
            dblAt(cx, cy);
            const ce = document.querySelector('[contenteditable="true"]');
            const propio = ce && (ce === el || ce.contains(el) || el.contains(ce));
            if (!propio)
              texto.push({ tag: el.tagName.toLowerCase(), svg: !!el.closest("svg"),
                lock: !!el.closest("[data-oc-lock]"),
                t: (el.textContent || "").trim().slice(0, 36) });
            continue;
          }

          // ── ¿el velo a lámina completa se puede tomar? ──
          const pinta = (cs.backgroundImage && cs.backgroundImage !== "none") ||
            (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|^transparent$/.test(cs.backgroundColor));
          const esVelo = tooBig(el) && pinta && el.tagName !== "IMG" &&
            !el.ownerSVGElement && el.tagName.toLowerCase() !== "svg" &&
            (el.textContent || "").trim().length === 0;
          if (!esVelo) continue;
          // Un velo cubre casi toda la lámina, así que su centro casi siempre cae
          // encima de un texto — y ahí gana el texto, que es lo correcto. Se prueban
          // varios puntos: la pregunta es "¿la diseñadora puede tomarlo EN ALGÚN
          // lado?", no "¿puede tomarlo justo en el centro?".
          const puntos = [
            [cx, cy],
            [r.left + r.width * 0.5, r.top + r.height * 0.08],
            [r.left + r.width * 0.08, r.top + r.height * 0.5],
            [r.left + r.width * 0.92, r.top + r.height * 0.5],
            [r.left + r.width * 0.5, r.top + r.height * 0.92],
          ];
          let ok = false;
          for (const [px, py] of puntos) {
            const x = Math.min(Wv - 2, Math.max(2, px));
            const y = Math.min(Hv - 2, Math.max(2, py));
            clear();
            clickAt(x, y);
            const b = document.querySelector(".oc-box");
            if (!b) continue;
            const br = b.getBoundingClientRect();
            if (Math.abs(r.left - br.left) < 2 && Math.abs(r.top - br.top) < 2 &&
                Math.abs(r.width - br.width) < 2 && Math.abs(r.height - br.height) < 2) {
              ok = true; break;
            }
          }
          if (!ok) velos.push({ tag: el.tagName.toLowerCase(),
            bg: cs.backgroundImage !== "none" ? "degradado" : cs.backgroundColor });
        }
        return { texto, velos };
      },
      W, H
    );

    if (res.texto.length) {
      T.slTexto++; T.texto += res.texto.length;
      if (ejTexto.length < 8) ejTexto.push({ c: c.name, ...res.texto[0] });
    }
    if (res.velos.length) {
      T.slVelo++; T.velos += res.velos.length;
      if (ejVelo.length < 5) ejVelo.push({ c: c.name, ...res.velos[0] });
    }
  }
}
await browser.close();

const pct = (n) => `${((n / Math.max(1, T.slides)) * 100).toFixed(0)}%`;
console.log(`\nCorpus: ${T.slides} láminas de ${carousels.length} carruseles\n`);
console.log(`Texto que no entra en edición con doble clic`);
console.log(`  láminas   ${String(T.slTexto).padStart(4)}/${T.slides}  (${pct(T.slTexto)})`);
console.log(`  objetos   ${String(T.texto).padStart(4)}`);
console.log(`\nVelo a lámina completa que no se puede tomar`);
console.log(`  láminas   ${String(T.slVelo).padStart(4)}/${T.slides}  (${pct(T.slVelo)})`);
console.log(`  objetos   ${String(T.velos).padStart(4)}`);
if (ejTexto.length) {
  console.log(`\nEjemplos — texto:`);
  for (const e of ejTexto) console.log(`  [${e.tag}] svg=${e.svg} lock=${e.lock} "${e.t}"`);
}
if (ejVelo.length) {
  console.log(`\nEjemplos — velo:`);
  for (const e of ejVelo) console.log(`  [${e.tag}] ${e.bg}  (${e.c})`);
}
console.log("");
