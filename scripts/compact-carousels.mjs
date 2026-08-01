/**
 * Compacta el historial de deshacer de las láminas ya guardadas.
 *
 * Cada versión de deshacer es una copia COMPLETA del HTML de la lámina. Con el tope
 * viejo de 30, el historial llegó a ser el 75% de `carousels.json` (20.9 MB de 28 MB), y
 * como cada lectura del store parsea el archivo entero, ese peso se paga en CADA request.
 * Este script recorta lo ya guardado; el tope nuevo (MAX_VERSIONS) evita que vuelva a
 * crecer.
 *
 * Uso (requiere el server levantado, igual que repalette-carousels.mjs):
 *   node scripts/compact-carousels.mjs                      # dry-run: solo reporta
 *   node scripts/compact-carousels.mjs --apply              # escribe, con respaldo
 *   node scripts/compact-carousels.mjs --conservar 3 --apply
 *
 * Contra producción:
 *   OC_BASE_URL=https://carruseles.30x.com INTERNAL_API_TOKEN=... node scripts/compact-carousels.mjs
 *
 * NO edita el JSON por su cuenta a propósito. Los datos están vivos —el store se escribe
 * más de 1600 veces por día— así que bajar el archivo, recortarlo y subirlo pisaría todo
 * lo que se hubiera escrito en el medio. El endpoint hace el recorte dentro del mismo
 * mutex que usa cualquier otra escritura de la app.
 */
const BASE = process.env.OC_BASE_URL || "http://localhost:3000";
const RUTA = "/api/maintenance/compact-history";

const aplicar = process.argv.includes("--apply");
const conservar = (() => {
  const i = process.argv.indexOf("--conservar");
  if (i < 0) return undefined;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`--conservar necesita un entero >= 0, recibí "${process.argv[i + 1]}"`);
    process.exit(1);
  }
  return n;
})();

const CABECERAS = {
  "Content-Type": "application/json",
  ...(process.env.INTERNAL_API_TOKEN
    ? { "X-Internal-Token": process.env.INTERNAL_API_TOKEN }
    : {}),
};

const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

const res = await fetch(`${BASE}${RUTA}`, {
  method: "POST",
  headers: CABECERAS,
  body: JSON.stringify({ conservar, aplicar }),
});

if (!res.ok) {
  const detalle = await res.text();
  console.error(`✗ ${res.status} ${res.statusText}\n${detalle}`);
  if (res.status === 403) {
    console.error("\n¿Falta INTERNAL_API_TOKEN en el entorno?");
  }
  process.exit(1);
}

const r = await res.json();
const ahorro = r.bytesAntes - r.bytesDespues;
const pct = r.bytesAntes > 0 ? ((r.bytesDespues / r.bytesAntes) * 100).toFixed(0) : "0";

console.log(`${r.aplicado ? "APLICADO" : "DRY-RUN (no se escribió nada)"}`);
console.log(`  conservando:  ${r.conservar} versiones por lámina`);
console.log(`  láminas:      ${r.laminasRecortadas} recortadas de ${r.laminas}`);
console.log(`  versiones:    ${r.versionesDescartadas} descartadas`);
console.log(`  archivo:      ${mb(r.bytesAntes)} → ${mb(r.bytesDespues)}  (${pct}%, -${mb(ahorro)})`);
if (r.respaldo) console.log(`  respaldo:     ${r.respaldo}`);
if (!r.aplicado) console.log(`\nPara escribirlo: agregá --apply`);
