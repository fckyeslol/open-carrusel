import * as csstree from "css-tree";

/**
 * Prepara una lámina para convivir con las otras en un documento multi-lámina
 * (el PDF del carrusel, el HTML editable, el SVG).
 *
 * El PNG no pasa por acá: exporta una lámina por documento, así que cada una tiene su
 * página entera para ella. El multi-lámina es el único caso donde las láminas se pisan,
 * y se pisaban de dos maneras, las dos silenciosas:
 *
 * 1. **El documento anidado.** El contrato dice que una lámina es HTML a nivel body, pero
 *    110 de 276 láminas guardadas son un `<!DOCTYPE html>` completo. Su
 *    `html,body{height:1350px;overflow:hidden}` se aplicaba al documento ENTERO y recortaba
 *    todo lo que venía después de la primera lámina: 7 láminas salían como 1 página.
 *
 * 2. **Las clases compartidas.** El agente genera cada lámina por separado y reusa los
 *    mismos nombres (`.s`, `.top`, `.kick`). Con todos los `<style>` en un solo documento,
 *    el `.s{background:#242424}` de la última lámina le ganaba a las anteriores por orden
 *    de cascada y TODAS las páginas terminaban del color de la última. Esto afectaba también
 *    a las láminas que sí respetan el contrato — o sea, a la mayoría.
 *
 * La solución para las dos es la misma: desanidar el documento y acotar su CSS a la página
 * que le toca. Se hace con `css-tree` (ya era dependencia del motor de calidad) y no con
 * regex, porque acá hay que distinguir un selector de un `@font-face`, y una `@media` de un
 * `@keyframes`.
 *
 * Este módulo vive suelto a propósito: `slide-html.ts` lo importa el preview del cliente, y
 * meter un parser de CSS en el bundle del navegador por algo que solo hace el export sería
 * un mal negocio.
 */

/** At-rules cuyo contenido NO son selectores: pasan intactas. */
const AT_RULES_OPACAS = new Set([
  "font-face",
  "keyframes",
  "-webkit-keyframes",
  "-moz-keyframes",
  "property",
  "counter-style",
  "font-feature-values",
  "font-palette-values",
  "page",
  "viewport",
  "charset",
  "import",
  "namespace",
]);

/** At-rules condicionales: hay que entrar a acotar los selectores de adentro. */
const AT_RULES_CONDICIONALES = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "scope",
]);

/**
 * Selectores que en la lámina apuntaban al documento y ahora tienen que apuntar a su página.
 *
 * De acá salen el fondo y el tamaño de la lámina, así que BORRARLOS la deja transparente y
 * sin medidas: hay que reencauzarlos, no descartarlos.
 */
const RAIZ = new Set(["html", "body", ":root"]);

/**
 * Acota un selector a `scope`.
 *
 * - `html`, `body`, `:root`, `html body` → el propio scope
 * - `body .titulo` → `<scope> .titulo` (se come la raíz, no la encadena)
 * - `*` → `<scope>, <scope> *` (el reset tiene que alcanzar también a la página)
 * - cualquier otro → `<scope> <selector>`
 *
 * Subir la especificidad de todos los selectores por igual no cambia quién gana DENTRO de
 * una lámina: el orden relativo se conserva y los estilos inline siguen mandando.
 */
function acotarSelector(selector: csstree.Selector, scope: string): string {
  const hijos = selector.children.toArray();

  // `*` suelto: el reset del principio de casi toda lámina.
  if (hijos.length === 1 && hijos[0].type === "TypeSelector" && hijos[0].name === "*") {
    return `${scope}, ${scope} *`;
  }

  // Se descarta el tramo inicial que apunta al documento (`html`, `body`, `html body`,
  // `:root`) junto con el combinador que lo sigue.
  let desde = 0;
  while (desde < hijos.length) {
    const nodo = hijos[desde];
    const esRaiz =
      (nodo.type === "TypeSelector" && RAIZ.has(nodo.name.toLowerCase())) ||
      (nodo.type === "PseudoClassSelector" && nodo.name.toLowerCase() === "root");
    if (!esRaiz) break;
    desde++;
    if (hijos[desde]?.type === "Combinator" || hijos[desde]?.type === "WhiteSpace") desde++;
  }

  const resto = hijos
    .slice(desde)
    .map((nodo) => csstree.generate(nodo))
    .join("")
    .trim();

  return resto ? `${scope} ${resto}` : scope;
}

/** Reescribe el prelude de una regla acotando cada selector de la lista. */
function acotarPrelude(regla: csstree.Rule, scope: string): void {
  const prelude = regla.prelude;
  if (prelude.type !== "SelectorList") return; // prelude crudo (Raw): se deja como está

  const acotados = prelude.children
    .toArray()
    .filter((n): n is csstree.Selector => n.type === "Selector")
    .map((sel) => acotarSelector(sel, scope));

  if (acotados.length === 0) return;

  // Se reemplaza el prelude por uno nuevo parseado del texto acotado: más simple y seguro
  // que manipular la lista de nodos hijo por hijo.
  const nuevo = csstree.parse(acotados.join(", "), { context: "selectorList" });
  regla.prelude = nuevo as csstree.SelectorList;
}

/** Recorre una lista de reglas acotando las de estilo y entrando a las condicionales. */
function acotarBloque(lista: csstree.List<csstree.CssNode> | null, scope: string): void {
  lista?.forEach((nodo) => {
    if (nodo.type === "Rule") {
      acotarPrelude(nodo, scope);
      return;
    }
    if (nodo.type === "Atrule") {
      const nombre = nodo.name.toLowerCase().replace(/^-\w+-/, "");
      if (AT_RULES_OPACAS.has(nombre) || AT_RULES_OPACAS.has(nodo.name.toLowerCase())) return;
      if (AT_RULES_CONDICIONALES.has(nombre) && nodo.block) {
        acotarBloque(nodo.block.children, scope);
      }
    }
  });
}

/**
 * Acota una hoja de estilos a `scope`. Si el CSS no se puede parsear se devuelve tal cual:
 * una lámina con el CSS sin acotar sale peor que perfecta, pero mejor que un export que
 * explota en la cara de la diseñadora. El `check:export` es el que tiene que cazar esto.
 */
export function scopeCss(css: string, scope: string): string {
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(css);
  } catch {
    return css;
  }
  if (ast.type !== "StyleSheet") return css;
  acotarBloque(ast.children, scope);
  return csstree.generate(ast);
}

/** ¿La lámina se guardó como documento completo en vez de HTML a nivel body? */
export function esDocumentoCompleto(html: string): boolean {
  return /<!DOCTYPE\s+html|<html[\s>]/i.test(html);
}

/**
 * Devuelve el HTML de la lámina listo para meterse en un documento multi-lámina:
 * desanidado (si venía como documento completo) y con todo su CSS acotado a `scope`.
 *
 * `scope` es un selector CSS, típicamente `#oc-p3`, que apunta al div de esa página.
 */
export function toPageBody(slideHtml: string, scope: string): string {
  let head = "";
  let cuerpo = slideHtml;

  if (esDocumentoCompleto(slideHtml)) {
    const conBody = slideHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const conHead = slideHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (conBody) {
      cuerpo = conBody[1];
      head = conHead?.[1] ?? "";
    } else {
      // `<html>` sin `<body>` explícito: se saca lo que haya dentro de <html>.
      cuerpo = slideHtml
        .replace(/<!DOCTYPE[^>]*>/i, "")
        .replace(/<\/?html[^>]*>/gi, "")
        .replace(/<head[\s\S]*?<\/head>/i, "");
      head = conHead?.[1] ?? "";
    }
  }

  // Del head solo sobreviven los estilos. El `<link>` a Google Fonts se descarta a
  // propósito: el documento multi-lámina inlinea las fuentes en base64 (igual que el PNG),
  // y una hoja remota que llega tarde puede pisarlas.
  const estilosDelHead = [...head.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n");

  // Los `<style>` que viven en el cuerpo se acotan en su lugar.
  const cuerpoAcotado = cuerpo.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/gi,
    (_todo, attrs: string, css: string) => `<style${attrs}>${scopeCss(css, scope)}</style>`
  );

  const bloqueHead = estilosDelHead.trim()
    ? `<style>${scopeCss(estilosDelHead, scope)}</style>\n`
    : "";

  return `${bloqueHead}${cuerpoAcotado}`;
}
