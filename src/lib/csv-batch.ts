/**
 * Parser del CSV de carga nocturna: `URL, Avenger, Diseñadora, Higgsfield`.
 *
 * La regla que manda sobre todo lo demás: **una fila mala NO puede tumbar el lote**.
 * El archivo lo arma una persona en Excel o Google Sheets a las 6 de la tarde y el lote
 * corre a las 20:00 sin nadie mirando; si una URL vino con un espacio de más o alguien
 * escribió el avenger sin tilde, lo correcto es generar las otras 39 filas y reportar
 * esa. Por eso NADA acá tira excepciones por una fila: cada una sale como `ok` o como
 * `invalid` con su motivo, y quien llama decide.
 *
 * Todo el parseo es a mano y sin dependencias — el formato es cuatro columnas planas,
 * y una librería de CSV traería más superficie (streams, encodings, dialectos) que
 * valor para esto.
 */
import { isInstagramUrl, normalizeInstagramUrl } from "./instagram-url";

/** Columnas que entendemos, con los nombres que realmente escribe la gente. */
const HEADER_ALIASES: Record<CsvColumn, readonly string[]> = {
  url: ["url", "urls", "link", "enlace", "referente", "referencia", "post", "reel"],
  avenger: ["avenger", "avengers", "avatar", "mentor", "mentora", "perfil"],
  designer: ["disenadora", "disenador", "disenadoras", "designer", "editora", "editor", "asignada", "responsable"],
  higgsfield: ["higgsfield", "higgs", "ia", "imagenes", "imagen", "hf"],
} as const;

export type CsvColumn = "url" | "avenger" | "designer" | "higgsfield";

/** Valores que cuentan como "sí" en la columna Higgsfield. */
const TRUTHY = new Set(["si", "sí", "s", "yes", "y", "true", "1", "x", "ok", "on"]);
/** Valores que cuentan como "no". Todo lo demás es ambiguo → se trata como NO. */
const FALSY = new Set(["no", "n", "false", "0", "off", "-", ""]);

/**
 * Normaliza para comparar: sin acentos, sin mayúsculas, sin espacios de sobra.
 *
 * Se usa tanto para los encabezados como para los nombres de avenger y diseñadora.
 * Es lo que hace que "Diseñadora", "DISEÑADORA" y "disenadora" sean la misma columna,
 * y que "María José" matchee "maria-jose" — el caso más común de todos, porque nadie
 * escribe los slugs a mano.
 */
export function normalizeKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // tildes y dieresis (marcas combinantes)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Igual que `normalizeKey` pero sin espacios: para comparar contra slugs. */
function slugish(value: string): string {
  return normalizeKey(value).replace(/\s+/g, "-");
}

/**
 * Parte una línea de CSV respetando comillas dobles (`"a,b",c` → `a,b` | `c`).
 *
 * Hace falta de verdad: las notas y los nombres compuestos traen comas, y Excel
 * siempre entrecomilla esos campos. Un `split(",")` pelado partiría la fila al medio.
 */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      // `""` dentro de un campo entrecomillado es una comilla literal.
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Adivina el separador mirando el encabezado.
 *
 * No es opcional: Excel en configuración regional española (la de todas las máquinas
 * acá) exporta CSV con punto y coma, no con coma. Sin esto, ese archivo se leería como
 * una sola columna gigante y el lote entero quedaría inválido.
 */
function detectDelimiter(headerLine: string): string {
  const counts = [",", ";", "\t"].map((d) => ({ d, n: splitLine(headerLine, d).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 1 ? counts[0].d : ",";
}

/** Mapea cada columna a su índice en el encabezado. `null` = no está en el archivo. */
function mapHeader(cells: string[]): Record<CsvColumn, number | null> {
  const map: Record<CsvColumn, number | null> = {
    url: null,
    avenger: null,
    designer: null,
    higgsfield: null,
  };
  cells.forEach((cell, i) => {
    const key = normalizeKey(cell).replace(/\s+/g, "");
    for (const [col, aliases] of Object.entries(HEADER_ALIASES) as [CsvColumn, readonly string[]][]) {
      if (map[col] === null && aliases.includes(key)) map[col] = i;
    }
  });
  return map;
}

/** ¿Esta primera línea es un encabezado, o ya es una fila de datos? */
function looksLikeHeader(cells: string[]): boolean {
  const mapped = mapHeader(cells);
  // Con URL + Avenger reconocidos alcanza; y una fila de datos real tendría una URL
  // de Instagram en alguna celda, no la palabra "url".
  return (
    (mapped.url !== null || mapped.avenger !== null) && !cells.some((c) => isInstagramUrl(c))
  );
}

export interface ParsedRow {
  /** Número de línea en el archivo (1-based, contando el encabezado) — para el reporte. */
  line: number;
  referenceUrl: string;
  /** Texto crudo del avenger, tal cual lo escribieron. Se resuelve a slug después. */
  avengerRaw: string;
  /** Texto crudo de la diseñadora. Se resuelve a usuaria después. */
  designerRaw: string;
  /** Si esta fila usa Higgsfield. Vacío/ambiguo = false (no llamamos a la API). */
  higgsfield: boolean;
}

export interface InvalidRow {
  line: number;
  /** La fila cruda, para que la usuaria la reconozca en su planilla. */
  raw: string;
  reason: string;
}

export interface ParsedCsv {
  rows: ParsedRow[];
  invalid: InvalidRow[];
  /** Columnas que esperábamos y no aparecieron en el encabezado. */
  missingColumns: CsvColumn[];
  /** El archivo no traía encabezado y se asumió el orden URL, Avenger, Diseñadora, Higgsfield. */
  assumedOrder: boolean;
}

/**
 * Interpreta la celda de Higgsfield.
 *
 * Ante la duda devuelve `false` a propósito. Higgsfield cuesta plata por imagen: si
 * alguien escribió algo raro, el error barato es NO gastar. La fila igual se genera —
 * solo que sin imágenes de IA.
 */
export function parseHiggsfield(cell: string): boolean {
  const v = normalizeKey(cell);
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return false;
}

/** Filas de más que ignoramos, para no aceptar un pegado accidental de 10.000 líneas. */
const MAX_ROWS = 500;

/**
 * Parsea el CSV completo. Nunca tira: todo lo que no se entiende sale en `invalid`.
 */
export function parseBatchCsv(text: string): ParsedCsv {
  // El BOM de Excel (U+FEFF) se pega al primer encabezado y rompe el match de "url".
  const clean = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n");

  // Índice de la primera línea con contenido: saltea las vacías del principio.
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) {
    return { rows: [], invalid: [], missingColumns: ["url", "avenger"], assumedOrder: false };
  }

  const delimiter = detectDelimiter(lines[firstIdx]);
  const firstCells = splitLine(lines[firstIdx], delimiter);
  const hasHeader = looksLikeHeader(firstCells);

  // Sin encabezado asumimos el orden que pidió la usuaria. Es lo que pasa cuando pegan
  // las filas sueltas sin la primera línea.
  const cols: Record<CsvColumn, number | null> = hasHeader
    ? mapHeader(firstCells)
    : { url: 0, avenger: 1, designer: 2, higgsfield: 3 };

  const missingColumns = (["url", "avenger"] as CsvColumn[]).filter((c) => cols[c] === null);

  const rows: ParsedRow[] = [];
  const invalid: InvalidRow[] = [];
  const seen = new Set<string>();

  for (let i = hasHeader ? firstIdx + 1 : firstIdx; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    if (rows.length + invalid.length >= MAX_ROWS) {
      invalid.push({
        line: i + 1,
        raw: raw.slice(0, 200),
        reason: `El archivo supera las ${MAX_ROWS} filas; el resto se ignoró.`,
      });
      break;
    }

    const cells = splitLine(raw, delimiter);
    const at = (col: CsvColumn): string => {
      const idx = cols[col];
      return idx === null ? "" : (cells[idx] ?? "").trim();
    };

    const referenceUrl = at("url");
    if (!referenceUrl) {
      invalid.push({ line: i + 1, raw: raw.slice(0, 200), reason: "Fila sin URL." });
      continue;
    }
    if (!isInstagramUrl(referenceUrl)) {
      invalid.push({
        line: i + 1,
        raw: raw.slice(0, 200),
        reason: `No parece un post o reel de Instagram: ${referenceUrl.slice(0, 80)}`,
      });
      continue;
    }
    const avengerRaw = at("avenger");
    if (!avengerRaw) {
      invalid.push({ line: i + 1, raw: raw.slice(0, 200), reason: "Fila sin avenger." });
      continue;
    }

    // Duplicados dentro del MISMO archivo: generar dos veces el mismo referente
    // gastaría el doble de presupuesto para tener dos carruseles iguales.
    //
    // Se compara la forma CANÓNICA (…/p/<code>/), no el texto crudo: la misma lámina
    // pegada desde la app y desde el navegador llega con `?igsh=…`, `/reel/` vs `/p/`
    // y query de tracking. Y va DESPUÉS de validar: si no, una fila mala quemaría el
    // cupo de su URL y la fila buena de más abajo se descartaría como "repetida".
    const key = normalizeInstagramUrl(referenceUrl) ?? referenceUrl.toLowerCase();
    if (seen.has(key)) {
      invalid.push({
        line: i + 1,
        raw: raw.slice(0, 200),
        reason: "URL repetida en el archivo (se genera una sola vez).",
      });
      continue;
    }
    seen.add(key);

    rows.push({
      line: i + 1,
      referenceUrl,
      avengerRaw,
      designerRaw: at("designer"),
      higgsfield: parseHiggsfield(at("higgsfield")),
    });
  }

  return { rows, invalid, missingColumns, assumedOrder: !hasHeader };
}

/** Un avatar disponible en esta instalación, para resolver la columna Avenger. */
export interface AvatarCandidate {
  slug: string;
  name: string;
  ready: boolean;
}

/** Una diseñadora registrada, para resolver la columna Diseñadora. */
export interface DesignerCandidate {
  id: string;
  username: string;
  displayName: string;
}

/**
 * Resuelve el texto del avenger contra los avatares instalados.
 *
 * Acepta el slug ("maria-jose"), el nombre del preset ("30X — María José Echeverry") y
 * el nombre a secas con o sin tildes ("maria jose"). Se prueba de lo más estricto a lo
 * más laxo, y el último recurso —prefijo— pide 4 caracteres para que "a" no matchee
 * con el primer avatar de la lista.
 */
export function resolveAvenger(
  input: string,
  avatars: readonly AvatarCandidate[]
): AvatarCandidate | null {
  const wanted = normalizeKey(input);
  const wantedSlug = slugish(input);
  if (!wanted) return null;

  const bySlug = avatars.find((a) => slugish(a.slug) === wantedSlug);
  if (bySlug) return bySlug;

  const byName = avatars.find((a) => normalizeKey(stripAvatarPrefix(a.name)) === wanted);
  if (byName) return byName;

  // El nombre del preset trae el prefijo "30X —"; comparar el nombre completo también.
  const byFullName = avatars.find((a) => normalizeKey(a.name) === wanted);
  if (byFullName) return byFullName;

  if (wanted.length >= 4) {
    const byPrefix = avatars.filter((a) => {
      const n = normalizeKey(stripAvatarPrefix(a.name));
      return n.startsWith(wanted) || wanted.startsWith(n) || slugish(a.slug).startsWith(wantedSlug);
    });
    // Solo si es INEQUÍVOCO: dos "María" candidatas ⇒ no adivinamos.
    if (byPrefix.length === 1) return byPrefix[0];
  }
  return null;
}

/** "30X — Andrés Bilbao" → "Andrés Bilbao". */
export function stripAvatarPrefix(name: string): string {
  return name.replace(/^30X\s*[—–-]\s*/i, "").trim() || name;
}

/**
 * Resuelve la diseñadora. Devolver `null` NO es un error: la fila se genera igual y el
 * carrusel queda sin dueña (decisión explícita — ver la ruta de subida). Un typo en un
 * nombre no puede costar un carrusel.
 */
export function resolveDesigner(
  input: string,
  designers: readonly DesignerCandidate[]
): DesignerCandidate | null {
  const wanted = normalizeKey(input);
  if (!wanted) return null;

  const byUsername = designers.find((d) => normalizeKey(d.username) === wanted);
  if (byUsername) return byUsername;

  const byDisplay = designers.find((d) => normalizeKey(d.displayName) === wanted);
  if (byDisplay) return byDisplay;

  // Nombre de pila solo ("cinthya" para "Cinthya Ramírez"), si es inequívoco.
  const byFirst = designers.filter((d) => {
    const full = normalizeKey(d.displayName);
    return full.startsWith(`${wanted} `) || full === wanted || normalizeKey(d.username).startsWith(wanted);
  });
  return byFirst.length === 1 ? byFirst[0] : null;
}
