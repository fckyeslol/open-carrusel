/**
 * Implementación en PostgreSQL de la API de documentos de `data.ts`.
 *
 * Cada "archivo" de antes (`brand.json`, `templates.json`, …) es una fila de la tabla
 * `documents` con su payload en JSONB. Mantener la MISMA firma que la versión de
 * filesystem es deliberado: los 10 módulos que la usan (brand, templates, style-presets,
 * users, palettes, backgrounds, prewave, staged-actions, higgsfield, manual-entries) no se
 * tocan, y la migración se reduce a cambiar de backend.
 *
 * LO QUE CAMBIA RESPECTO DEL FILESYSTEM, y es el punto de todo esto:
 *
 *   El mutex por archivo de `data.ts` serializaba escritores DENTRO de un proceso. Por eso
 *   Cloud Run tenía que estar en `min=max=1`: con dos instancias, dos procesos con mutexes
 *   distintos se pisaban. Acá la atomicidad la da `SELECT ... FOR UPDATE` dentro de una
 *   transacción, que vale ENTRE instancias. Eso es lo que habilita la redundancia.
 *
 * También desaparecen tres problemas propios del volumen GCS FUSE: los ESTALE/EIO
 * transitorios (con sus 8 reintentos), los `.tmp` huérfanos de escrituras atómicas cortadas
 * a la mitad, y el riesgo de persistir un default encima de datos vivos.
 */
import { query, queryOne, transaction } from "./db";
import { DataFileNotFoundError, SKIP_WRITE } from "./data-shared";

interface FilaDocumento {
  payload: unknown;
}

/** Lee un documento. Lanza `DataFileNotFoundError` si no existe (igual que la versión FS). */
export async function readDataPg<T>(key: string): Promise<T> {
  const fila = await queryOne<FilaDocumento>(
    "SELECT payload FROM documents WHERE key = $1",
    [key]
  );
  if (!fila) throw new DataFileNotFoundError(key);
  return fila.payload as T;
}

/** Escribe (o crea) un documento entero. */
export async function writeDataPg<T>(key: string, data: T): Promise<void> {
  await query(
    `INSERT INTO documents (key, payload) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE
       SET payload = EXCLUDED.payload, revision = documents.revision + 1`,
    [key, JSON.stringify(data)]
  );
}

/**
 * Lectura tolerante: ante cualquier error devuelve el fallback.
 *
 * Igual que en la versión de filesystem, esto es SOLO para lecturas: nunca escribe, así que
 * caer al default es inofensivo. Para leer-modificar-escribir está `updateDataPg`.
 */
export async function readDataSafePg<T>(key: string, fallback: T): Promise<T> {
  try {
    return await readDataPg<T>(key);
  } catch {
    return fallback;
  }
}

/**
 * Lee, transforma y escribe de forma ATÓMICA entre instancias.
 *
 * `SELECT ... FOR UPDATE` toma un lock de fila que dura hasta el COMMIT, así que dos
 * escritores concurrentes —del mismo proceso o de instancias distintas— se serializan de
 * verdad. Es el reemplazo directo del mutex en memoria, que solo valía dentro del proceso.
 *
 * Cuando la fila no existe todavía se arranca desde `fallback`, igual que antes con un
 * archivo inexistente. La diferencia importante con el filesystem: acá NO hay una tercera
 * categoría de "no se pudo leer por un glitch del volumen". O la fila está, o no está. El
 * bug que vaciaba el store —persistir el default encima de datos vivos tras una lectura
 * fallida— deja de ser posible por construcción.
 */
export async function updateDataPg<T>(
  key: string,
  fallback: T,
  mutate: (current: T) => T | typeof SKIP_WRITE
): Promise<T> {
  return transaction(async (cliente) => {
    const res = await cliente.query<FilaDocumento>(
      "SELECT payload FROM documents WHERE key = $1 FOR UPDATE",
      [key]
    );
    const actual = (res.rows[0]?.payload as T | undefined) ?? fallback;

    const siguiente = mutate(actual);
    if (siguiente === SKIP_WRITE) return actual;

    await cliente.query(
      `INSERT INTO documents (key, payload) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE
         SET payload = EXCLUDED.payload, revision = documents.revision + 1`,
      [key, JSON.stringify(siguiente)]
    );
    return siguiente;
  });
}

/** Todas las claves guardadas. Para el script de migración y para diagnóstico. */
export async function listKeysPg(): Promise<string[]> {
  const filas = await query<{ key: string }>("SELECT key FROM documents ORDER BY key");
  return filas.map((f) => f.key);
}
