/**
 * Revisa láminas: las renderiza a PNG y lista sus defectos.
 *
 * Es el comando que cierra el loop de generación. Hasta ahora el agente escribía
 * HTML y seguía de largo sin ver nunca el resultado; con esto renderiza, mira y
 * corrige antes de pasar a la lámina siguiente.
 *
 * Uso:
 *   node scripts/slide-check.mjs <carouselId>            # todas las láminas
 *   node scripts/slide-check.mjs <carouselId> <slideId>  # una sola
 *   node scripts/slide-check.mjs <carouselId> --json     # salida cruda
 *
 * Requiere el dev server levantado (igual que el resto del flujo del agente).
 */

const [, , carouselId, segundo] = process.argv;
const soloJson = process.argv.includes("--json");
const slideId = segundo && !segundo.startsWith("--") ? segundo : null;

const BASE = process.env.OC_BASE_URL || "http://localhost:3000";

if (!carouselId) {
  console.error("Falta el carouselId.\n  node scripts/slide-check.mjs <carouselId> [slideId]");
  process.exit(1);
}

const ICONO = { error: "✗", warning: "!", advisory: "~", info: "·" };

async function pedirJson(url, opciones) {
  const res = await fetch(url, opciones);
  const texto = await res.text();
  let cuerpo;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    throw new Error(`Respuesta no-JSON de ${url} (${res.status}): ${texto.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(cuerpo.error || `HTTP ${res.status}`);
  return cuerpo;
}

function imprimirLamina(r) {
  const { lamina, png, errorRender, aprobado, hallazgos, adn } = r;
  const titulo = `Lámina ${lamina.orden}/${lamina.de}  (${lamina.id})`;
  console.log(`\n${"─".repeat(62)}\n${titulo}`);

  if (png) console.log(`PNG   ${png}`);
  else console.log(`PNG   no se pudo renderizar — ${errorRender}`);

  if (adn) {
    console.log(`ADN   ${adn.avatar || adn.preset} · ${adn.fuentes.join(", ")}`);
  } else {
    console.log(
      `ADN   sin preset — el detector corre en modo genérico y va a juzgar por gusto,\n` +
        `      no contra la identidad del avatar. Asigná stylePresetId al carrusel.`
    );
  }

  if (!hallazgos.length) {
    console.log(`\n✓ Sin defectos detectables.`);
  } else {
    console.log("");
    for (const h of hallazgos) {
      const veces = h.ocurrencias > 1 ? ` ×${h.ocurrencias}` : "";
      console.log(`${ICONO[h.severity] || "·"} [${h.antipattern}]${veces} ${h.name}`);
      console.log(`  ${h.description}`);
      if (h.ejemplos?.length) console.log(`  → ${h.ejemplos.join("  |  ")}`);
    }
  }

  console.log(
    `\n${aprobado ? "PASA" : "BLOQUEA"} — ${r.bloqueantes} bloqueante(s), ` +
      `${r.advertencias} advertencia(s), ${r.derivas} deriva(s) del ADN`
  );

  // El detector es evidencia de defectos, nunca prueba de que la lámina está bien.
  // Un resultado limpio con un PNG sin mirar no es una lámina revisada.
  if (png && r.referencia) {
    console.log(`\nLeé LAS DOS con Read y comparalas lado a lado:`);
    console.log(`  referente  ${r.referencia}`);
    console.log(`  tu lámina  ${png}`);
    console.log(
      `\nMirá en este orden: masa y posición de los bloques → materialidad ` +
        `(grano, dobleces, contraste) → escala relativa → color.\n` +
        `La pregunta no es "¿está bien?" sino "¿se parece?".`
    );
  } else if (png) {
    console.log(`\nAhora leé el PNG con Read: ${png}`);
  }
}

try {
  const carrusel = await pedirJson(`${BASE}/api/carousels/${carouselId}`);
  const objetivo = slideId
    ? carrusel.slides.filter((s) => s.id === slideId)
    : carrusel.slides;

  if (!objetivo.length) {
    console.error(slideId ? `No existe la lámina ${slideId}.` : "El carrusel no tiene láminas.");
    process.exit(1);
  }

  const resultados = [];
  for (const s of objetivo) {
    resultados.push(
      await pedirJson(`${BASE}/api/carousels/${carouselId}/slides/${s.id}/review`, {
        method: "POST",
      })
    );
  }

  if (soloJson) {
    console.log(JSON.stringify(resultados, null, 2));
  } else {
    resultados.forEach(imprimirLamina);
    const bloqueadas = resultados.filter((r) => !r.aprobado).length;
    if (resultados.length > 1) {
      console.log(
        `\n${"═".repeat(62)}\n${resultados.length} lámina(s) · ${bloqueadas} con bloqueantes`
      );
    }
  }

  // Exit 2 con bloqueantes, al estilo del detector de impeccable: sirve para CI y
  // para que el agente distinga "revisé y está limpio" de "revisé y hay que arreglar".
  //
  // exitCode en vez de process.exit(): cortar el proceso con un handle de fetch
  // todavía abierto hace que libuv aborte en Windows y escupa un assert que
  // parece un error del chequeo.
  process.exitCode = resultados.some((r) => !r.aprobado) ? 2 : 0;
} catch (error) {
  console.error(`\nFalló la revisión: ${error.message}`);
  if (String(error.message).includes("fetch failed")) {
    console.error(`¿Está levantado el dev server en ${BASE}?  npm run dev`);
  }
  process.exitCode = 1;
}
