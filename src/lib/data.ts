import { readFile, writeFile, rename, mkdir } from "fs/promises";
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

export async function readData<T>(filename: string): Promise<T> {
  const filePath = path.join(DATA_DIR, filename);
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Data file not found: ${filename}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Data file corrupted: ${filename} — ${err.message}`);
    }
    throw err;
  }
}

export async function writeData<T>(filename: string, data: T): Promise<void> {
  const mutex = getMutex(filename);
  await mutex.runExclusive(async () => {
    await atomicWrite(path.join(DATA_DIR, filename), data);
  });
}

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
    } catch {
      current = fallback;
    }
    const next = mutate(current);
    await atomicWrite(path.join(DATA_DIR, filename), next);
    return next;
  });
}
