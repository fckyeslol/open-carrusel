/**
 * Store de datos, con DOS backends y un despachante.
 *
 *   - **PostgreSQL** cuando hay base configurada (`DATABASE_URL` o
 *     `CLOUD_SQL_CONNECTION_NAME`). Es el modo hosteado. Su atomicidad vale ENTRE
 *     instancias, que es lo que permite levantar el `min=max=1` de Cloud Run y tener
 *     redundancia de verdad.
 *   - **Filesystem** cuando no la hay. Es el modo local de las diseñadoras, que corren la
 *     app con `git clone` + `npm run abrir` en Windows, sin Docker ni Postgres. Ese camino
 *     NO se puede romper, así que el código de archivos se conserva entero acá abajo.
 *
 * Los dos exponen exactamente la misma API, así que los 10 módulos que la consumen (brand,
 * templates, style-presets, users, palettes, backgrounds, prewave, staged-actions,
 * higgsfield, manual-entries) no saben cuál está activo ni les importa.
 *
 * El costo honesto de esta decisión es mantener dos implementaciones. La alternativa era
 * exigirle un Postgres a cada diseñadora, que rompía el modelo de distribución.
 */
import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { setTimeout as delay } from "timers/promises";
import path from "path";
import { Mutex } from "async-mutex";
import { DataFileNotFoundError, SKIP_WRITE } from "./data-shared";

export { DataFileNotFoundError, SKIP_WRITE };

/**
 * ¿Hay Postgres configurado? Se lee del env acá en vez de importar `dbConfigurada()` de
 * `db.ts` a propósito: importarlo arrastraría `pg` al grafo de módulos SIEMPRE, incluso en
 * modo local donde no se usa. Es la misma comprobación, sin la dependencia.
 */
function hayPostgres(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.CLOUD_SQL_CONNECTION_NAME);
}

/**
 * Carga el backend de Postgres SOLO si hace falta.
 *
 * El import es dinámico por dos razones. La primera es rendimiento honesto: en la máquina
 * de una diseñadora, `pg` nunca se carga. La segunda la descubrí rompiendo los tests
 * existentes — un import estático mete a `pg` en el grafo de CUALQUIER módulo que toque el
 * store, y `pg` hace `require('./client')` sin extensión, lo que revienta bajo el hook de
 * resolución de los tests. Node cachea el módulo, así que el costo por llamada es nulo
 * después de la primera.
 */
async function pg() {
  return import("./data-pg");
}

const DATA_DIR = path.resolve(process.cwd(), "data");

/**
 * El registro de mutexes vive en `globalThis`, NO en el scope del módulo.
 *
 * En Next.js el mismo módulo se instancia varias veces (HMR en dev, y grafos de
 * módulos distintos entre route handlers, server components y el runner singleton).
 * Un `Map` local a cada instancia daría un mutex distinto por instancia, así que
 * dos escritores del mismo archivo NO se serializarían y se pisarían. Anclándolo a
 * `globalThis` hay un solo mutex por archivo en todo el proceso.
 */
const g = globalThis as unknown as { __dataMutexes?: Map<string, Mutex> };
const mutexes = (g.__dataMutexes ??= new Map<string, Mutex>());

/** Contador monotónico para nombres de archivo temporal únicos por proceso. */
let tmpCounter = 0;

/**
 * Reintentos de lectura ante errores TRANSITORIOS del SO. En Windows, `readFile`
 * corriendo justo mientras `atomicWrite` hace el `rename` sobre el mismo path
 * puede dar EBUSY/EPERM/ENOENT momentáneo (el destino está brevemente tomado o
 * ausente durante el swap). Un puñado de reintentos con backoff corto sortea esa
 * ventana sin que la lectura falle.
 */
const READ_RETRIES = 8;
const READ_BACKOFF_MS = 40;

/** Códigos de error de lectura que son transitorios (vale reintentar). */
const TRANSIENT_READ_CODES = new Set([
  "EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE", "ENOENT",
  // GCS FUSE (Cloud Run): el handle del volumen montado se vuelve stale y la
  // lectura falla con ESTALE/EIO — o con code "UNKNOWN" cuando Node no mapea el
  // errno (ej. "Unknown system error -116, read"). Reintentar los sortea.
  "ESTALE", "EIO", "UNKNOWN",
]);
/** errnos crudos transitorios de GCS FUSE (Node los reporta como code "UNKNOWN"). */
const TRANSIENT_READ_ERRNOS = new Set([-116, -5]); // ESTALE, EIO

function getMutex(filename: string): Mutex {
  let mutex = mutexes.get(filename);
  if (!mutex) {
    mutex = new Mutex();
    mutexes.set(filename, mutex);
  }
  return mutex;
}

/**
 * Escritura atómica: escribe en un temporal ÚNICO y luego renombra sobre el destino.
 *
 * El temporal lleva pid + contador para que dos escritores concurrentes (aunque
 * escapen del mutex por instancias duplicadas del módulo) nunca compartan el mismo
 * `.tmp`. Un nombre fijo provocaba una carrera en Windows: A renombraba tmp→final
 * (consumiendo el tmp) y el rename de B fallaba con ENOENT. Con tmp único, lo peor
 * que pasa es un last-write-wins inofensivo sobre el destino.
 */
async function atomicWrite(filePath: string, data: unknown): Promise<void> {
  await ensureDataDir();
  const tmpPath = `${filePath}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}

export async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

/** Lee el archivo reintentando ante errores transitorios del SO (ver arriba). */
async function readFileWithRetry(filePath: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    try {
      return await readFile(filePath, "utf-8");
    } catch (err) {
      lastErr = err;
      const e = err as NodeJS.ErrnoException;
      const transient =
        (e.code != null && TRANSIENT_READ_CODES.has(e.code)) ||
        (typeof e.errno === "number" && TRANSIENT_READ_ERRNOS.has(e.errno));
      if (!transient || attempt === READ_RETRIES) break;
      await delay(READ_BACKOFF_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function readData<T>(filename: string): Promise<T> {
  if (hayPostgres()) return (await pg()).readDataPg<T>(filename);
  return readDataFs<T>(filename);
}

async function readDataFs<T>(filename: string): Promise<T> {
  const filePath = path.join(DATA_DIR, filename);
  let raw: string;
  try {
    raw = await readFileWithRetry(filePath);
  } catch (err) {
    // ENOENT que sobrevivió a los reintentos = el archivo realmente no existe.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DataFileNotFoundError(filename);
    }
    // Error transitorio/permiso que persistió: NO es "no existe". Que reviente
    // para que `updateData` aborte en vez de pisar datos vivos con el default.
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Data file corrupted: ${filename} — ${(err as Error).message}`);
  }
}

export async function writeData<T>(filename: string, data: T): Promise<void> {
  if (hayPostgres()) return (await pg()).writeDataPg<T>(filename, data);
  const mutex = getMutex(filename);
  await mutex.runExclusive(async () => {
    await atomicWrite(path.join(DATA_DIR, filename), data);
  });
}

/**
 * Lectura de solo-lectura: nunca escribe, así que caer al `fallback` ante
 * cualquier error es inofensivo (se auto-cura en la próxima lectura). NO uses esto
 * para leer-modificar-escribir: para eso está `updateData`, que sí distingue los
 * errores para no persistir un default encima de datos vivos.
 */
export async function readDataSafe<T>(filename: string, fallback: T): Promise<T> {
  if (hayPostgres()) return (await pg()).readDataSafePg<T>(filename, fallback);
  try {
    return await readDataFs<T>(filename);
  } catch {
    return fallback;
  }
}

/**
 * Lee, transforma y escribe dentro del mismo lock.
 *
 * `readDataSafe` + `writeData` por separado dejan una ventana entre la lectura y
 * la escritura: dos pedidos simultáneos parten de la misma base y el segundo pisa
 * el cambio del primero, que igual respondió OK. Esta versión mantiene el mutex
 * tomado durante todo el ciclo, así que las mutaciones se serializan de verdad.
 *
 * CRÍTICO: solo arranca desde `fallback` cuando el archivo NO existe. Si la lectura
 * falla por corrupción o por un error transitorio del SO, ABORTA sin escribir — de
 * lo contrario `mutate(fallback)` persistiría un store vacío encima de datos vivos
 * (el bug que vaciaba la cola por un glitch de lectura de milisegundos).
 */
export async function updateData<T>(
  filename: string,
  fallback: T,
  mutate: (current: T) => T | typeof SKIP_WRITE
): Promise<T> {
  if (hayPostgres()) return (await pg()).updateDataPg<T>(filename, fallback, mutate);
  const mutex = getMutex(filename);
  return mutex.runExclusive(async () => {
    let current: T;
    try {
      current = await readDataFs<T>(filename);
    } catch (err) {
      if (err instanceof DataFileNotFoundError) {
        current = fallback; // archivo nuevo: arrancar desde el default es seguro
      } else {
        throw err; // corrupto o glitch transitorio: preservar el archivo, no pisarlo
      }
    }
    const next = mutate(current);
    if (next === SKIP_WRITE) return current;
    await atomicWrite(path.join(DATA_DIR, filename), next);
    return next;
  });
}
