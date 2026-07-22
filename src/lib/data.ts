import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { setTimeout as delay } from "timers/promises";
import path from "path";
import { Mutex } from "async-mutex";

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
const READ_RETRIES = 5;
const READ_BACKOFF_MS = 25;

/** Códigos de error de lectura que son transitorios (vale reintentar). */
const TRANSIENT_READ_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE", "ENOENT"]);

function getMutex(filename: string): Mutex {
  let mutex = mutexes.get(filename);
  if (!mutex) {
    mutex = new Mutex();
    mutexes.set(filename, mutex);
  }
  return mutex;
}

/**
 * El archivo de datos NO existe (nunca se creó). Es el único caso en el que un
 * escritor puede arrancar desde el default sin riesgo de perder datos. Se
 * distingue con su propio tipo para que `updateData` no confunda "no existe" con
 * "no se pudo leer" (corrupto o glitch transitorio) — confundirlos es lo que
 * vaciaba el store al persistir el fallback encima de un archivo vivo.
 */
export class DataFileNotFoundError extends Error {
  constructor(filename: string) {
    super(`Data file not found: ${filename}`);
    this.name = "DataFileNotFoundError";
  }
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
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_READ_CODES.has(code) || attempt === READ_RETRIES) break;
      await delay(READ_BACKOFF_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function readData<T>(filename: string): Promise<T> {
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
  try {
    return await readData<T>(filename);
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
  mutate: (current: T) => T
): Promise<T> {
  const mutex = getMutex(filename);
  return mutex.runExclusive(async () => {
    let current: T;
    try {
      current = await readData<T>(filename);
    } catch (err) {
      if (err instanceof DataFileNotFoundError) {
        current = fallback; // archivo nuevo: arrancar desde el default es seguro
      } else {
        throw err; // corrupto o glitch transitorio: preservar el archivo, no pisarlo
      }
    }
    const next = mutate(current);
    await atomicWrite(path.join(DATA_DIR, filename), next);
    return next;
  });
}
