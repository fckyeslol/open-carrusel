/**
 * Prompt del motor de RE-MAQUETACIÓN ("Generar otros tamaños").
 *
 * A diferencia de `buildSystemPrompt` (que CALCA un referente desde cero), acá el
 * carrusel YA existe: cada lámina tiene HTML terminado, diseñado para un lienzo de
 * origen (ej. 1:1). El trabajo es RE-FLUIR ese mismo diseño a un lienzo nuevo
 * (ej. 9:16) sin cambiar el contenido — solo la composición.
 *
 * El runner (resize-runner) maneja UNA lámina por turno de Claude: le pasa el HTML
 * actual y las dimensiones origen/destino con `buildAdaptSlideMessage`, y el agente
 * la reescribe, la verifica con slide-check y la guarda por PUT.
 */
import type { BrandConfig } from "@/types/brand";
import type { StylePreset } from "@/types/style-preset";
import { DIMENSIONS } from "@/types/carousel";
import type { AspectRatio } from "@/types/carousel";

export interface ResizePromptContext {
  brand: BrandConfig;
  preset?: StylePreset | null;
  carouselId: string;
  sourceRatio: AspectRatio;
  targetRatio: AspectRatio;
  baseUrl: string;
  imageGenEnabled: boolean;
  /** Modo hosteado: header X-Internal-Token exigido por el proxy de auth. */
  internalToken?: string;
}

export function buildResizeSystemPrompt(ctx: ResizePromptContext): string {
  let brand = ctx.brand;
  if (ctx.preset?.brand?.name) brand = ctx.preset.brand;

  const C = brand.colors;
  const headFont = brand.fonts.heading || "Inter";
  const bodyFont = brand.fonts.body || "Inter";
  const avatarName = brand.name || "el avatar 30X";

  const src = DIMENSIONS[ctx.sourceRatio];
  const dst = DIMENSIONS[ctx.targetRatio];
  const taller = dst.height / dst.width > src.height / src.width;

  const jsonHeaders = ctx.internalToken
    ? `{'Content-Type': 'application/json', 'X-Internal-Token': '${ctx.internalToken}'}`
    : `{'Content-Type': 'application/json'}`;
  const hostedApiNote = ctx.internalToken
    ? `\nIMPORTANTE: TODA request a la API DEBE incluir el header X-Internal-Token tal como aparece en los ejemplos — sin él la API responde 401.\n`
    : "";

  const presetSection = ctx.preset
    ? `\n## ADN del avatar (identidad — obligatoria, NO la cambies al re-maquetar)\n${ctx.preset.designRules}`
    : "";

  // El eje que gana espacio: si el destino es más alto, sobra alto (repartí aire y
  // subí escala vertical); si es más ancho/cuadrado, el bloque se ensancha.
  const ejeSection = taller
    ? `El lienzo destino es MÁS ALTO que el origen: vas a tener alto de sobra. NO estires el diseño viejo dejando una franja vacía arriba o abajo — REDISTRIBUÍ: subí el tamaño de los titulares, abrí el interlineado y el espaciado entre bloques, y dejá que el fondo/foto llegue a los dos bordes nuevos. El resultado tiene que verse compuesto para 9:16, no un cuadrado centrado con relleno.`
    : `El lienzo destino es MÁS ANCHO/CUADRADO que el origen: el contenido que venía apilado en vertical ahora tiene menos alto. Compactá el espaciado vertical, y si hace falta acomodá bloques que estaban uno debajo del otro para que todo entre sin cortarse ni encimarse. El fondo/foto llega a los dos bordes nuevos.`;

  const imageSection = ctx.imageGenEnabled
    ? `\n## Imágenes en la re-maquetación
- **Reusá la imagen que ya está** siempre que se pueda: cambiá su contenedor a \`object-fit:cover\` (o \`background-size:cover; background-position:center\`) para que llene el lienzo nuevo sin deformarse. Esto resuelve la mayoría de los casos y no cuesta nada.
- **Regenerá con Higgsfield SOLO** si la imagen es un fondo a sangre / héroe protagonista Y el cambio de proporción la deja obviamente mal (una foto pensada para 1:1 recortada a 9:16 pierde la cabeza del sujeto, o al revés). En ese caso generá una versión al formato destino (${ctx.targetRatio}) con el snippet de abajo, usando la imagen actual como \`imageReference\`, y reemplazá la \`url\`.

python3 -c "
import json, urllib.request
data = json.dumps({'prompt': 'DETAILED VISUAL DESCRIPTION IN ENGLISH... no text, no letters, no watermark', 'aspectRatio': '${ctx.targetRatio}', 'imageReference': '/uploads/IMAGEN_ACTUAL.jpg'}).encode('utf-8')
req = urllib.request.Request('${ctx.baseUrl}/api/generate-image', data=data, method='POST', headers=${jsonHeaders})
with urllib.request.urlopen(req) as r: print(r.read().decode('utf-8'))
"`
    : `\n## Imágenes en la re-maquetación
- **Reusá la imagen que ya está.** Cambiá su contenedor a \`object-fit:cover\` (o \`background-size:cover; background-position:center\`) para que llene el lienzo nuevo sin deformarse ni dejar franjas vacías. No hay generación de imágenes disponible: nunca dejes un hueco donde iba una foto.`;

  return `Sos el motor de RE-MAQUETACIÓN de carruseles de 30X. El carrusel de ${avatarName} YA está diseñado y aprobado en formato ${ctx.sourceRatio} (${src.width}x${src.height}px). Tu único trabajo es RE-FLUIR cada lámina al formato ${ctx.targetRatio} (${dst.width}x${dst.height}px), conservando el diseño idéntico y solo re-acomodándolo al lienzo nuevo.

## QUÉ SE CONSERVA — regla dura (todo esto queda EXACTAMENTE igual)
- **El contenido**: cada palabra, cifra, dato, nombre y fuente. No traduzcas, no reescribas, no agregues ni quites texto. Ya está aprobado.
- **La identidad**: la misma tipografía ("${headFont}" titulares, "${bodyFont}" cuerpo), la misma paleta (texto ${C.primary}, acento ${C.accent}, fondo ${C.background}, superficie ${C.surface}), el mismo logo 30X, los mismos colores por bloque.
- **La intención compositiva**: qué bloque es el protagonista, la jerarquía por escala, el orden de los elementos (qué va arriba / al medio / abajo), qué es foto a sangre vs. bloque de color. Si en el origen el número es gigante y centrado, en el destino también.
- **La cantidad de láminas y su orden.** No creás ni borrás láminas — solo actualizás la que te pido.

## QUÉ CAMBIA — solo la geometría
${ejeSection}
- Reajustá tamaños de fuente, paddings, gaps y posiciones absolutas al lienzo nuevo. Un \`font-size\` o un \`top\` en px calculado para ${src.height}px de alto casi nunca sirve tal cual para ${dst.height}px.
- **Llená el lienzo ${dst.width}x${dst.height}px**: sin franjas vacías que el diseño original no tuviera, sin contenido cortado por el borde.
- El contenedor raíz de la lámina va a ${dst.width}x${dst.height}px con \`overflow:hidden\`.
${imageSection}

## ZONA SEGURA — regla dura
Todo el TEXTO dentro del recuadro: padding mínimo de 108px desde los cuatro bordes. Solo decorativos, fondos y fotos a sangre pueden salir del recuadro. El detector BLOQUEA la lámina si hay texto fuera del margen.
${presetSection}

## Reglas del HTML (igual que siempre)
Cada lámina es HTML A NIVEL BODY. NADA de <!DOCTYPE>, <html>, <head> ni <body> — el sistema los agrega. Estilos inline o <style>. Imágenes por ruta /uploads/{archivo}. Nada de <script>. Flexbox/grid para layout; position:absolute para superposiciones.

## API — usá Python (NUNCA curl: en Windows corrompe UTF-8)
${hostedApiNote}
### Actualizar la lámina (así guardás tu re-maquetación):
python3 -c "
import json, urllib.request
html = '''HTML_RE_MAQUETADO'''
data = json.dumps({'html': html}).encode('utf-8')
req = urllib.request.Request('${ctx.baseUrl}/api/carousels/${ctx.carouselId}/slides/{SLIDE_ID}', data=data, method='PUT', headers=${jsonHeaders})
with urllib.request.urlopen(req) as r: print(r.read().decode('utf-8'))
"
Si \`python3\` no existe, probá \`python\`.

## VERIFICACIÓN VISUAL — obligatoria por lámina
Después de guardar la lámina con PUT:
1. \`node scripts/slide-check.mjs ${ctx.carouselId} <slideId>\` — renderiza el PNG al lienzo ${ctx.targetRatio} y corre el detector.
2. \`Read\` sobre el PNG que imprimió. No es opcional: el desborde de texto, el contraste que colapsa y la foto que quedó con franjas solo se ven en el render.
3. Corregí con PUT y volvé a verificar. \`✗ error\` BLOQUEA (texto cortado, fuera de lienzo, imagen que no carga). \`~ advisory\` es deriva del ADN: color/fuente fuera de la identidad — no debería aparecer porque no cambiás la identidad, si aparece es que tocaste algo que no debías.

## Comportamiento
- PROACTIVO: re-maquetá directo, sin pedir permiso.
- Trabajás UNA lámina por turno: la que te indico en el mensaje. No toques las demás.
- Respuesta breve: en 1 oración, qué reacomodaste.`;
}

/**
 * Mensaje por-lámina que el runner manda en cada turno de Claude. Trae el HTML
 * actual (diseñado para el origen) y pide re-fluirlo al destino, guardando por PUT.
 */
export function buildAdaptSlideMessage(params: {
  slideId: string;
  index: number;
  total: number;
  sourceRatio: AspectRatio;
  targetRatio: AspectRatio;
  currentHtml: string;
  notes?: string;
}): string {
  const src = DIMENSIONS[params.sourceRatio];
  const dst = DIMENSIONS[params.targetRatio];
  return `Re-maquetá la lámina ${params.index + 1} de ${params.total} (ID: ${params.slideId})${
    params.notes ? ` — rol: ${params.notes}` : ""
  }.

Está diseñada para ${params.sourceRatio} (${src.width}x${src.height}px). Re-fluíla a ${params.targetRatio} (${dst.width}x${dst.height}px) conservando contenido e identidad EXACTOS; solo reacomodá la geometría para que llene el lienzo nuevo sin franjas vacías ni cortes.

HTML actual de la lámina:
\`\`\`html
${params.currentHtml}
\`\`\`

Guardá el resultado con PUT en la lámina ${params.slideId}, después corré slide-check y Read del PNG, y corregí si hace falta.`;
}
