/**
 * Símbolos compartidos por los dos backends del store (filesystem y PostgreSQL).
 *
 * Viven en su propio módulo para romper un ciclo: `data.ts` es el despachante y necesita
 * importar `data-pg.ts`, que a su vez necesita estos dos. Si estuvieran en `data.ts`, el
 * import sería circular.
 */

/**
 * El documento NO existe (nunca se creó). Es el único caso en el que un escritor puede
 * arrancar desde el default sin riesgo de perder datos.
 *
 * Se distingue con su propio tipo para que `updateData` no confunda "no existe" con "no se
 * pudo leer" (corrupto o glitch transitorio del volumen). Confundirlos es lo que vaciaba el
 * store: se persistía el fallback encima de un archivo vivo.
 */
export class DataFileNotFoundError extends Error {
  constructor(filename: string) {
    super(`Data file not found: ${filename}`);
    this.name = "DataFileNotFoundError";
  }
}

/**
 * Sentinela para `mutate`: devolverlo CANCELA la escritura y deja el store tal cual.
 *
 * Sirve para las mutaciones que descubren, ya con el lock tomado, que no hay nada que
 * cambiar (id inexistente, límite alcanzado). Sin esto habría que reescribir el documento
 * entero solo para responder un 404.
 */
export const SKIP_WRITE = Symbol("skip-write");
