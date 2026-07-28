/**
 * Conexión a PostgreSQL.
 *
 * Reemplaza los archivos JSON sobre GCS FUSE, que eran la razón por la que Cloud Run estaba
 * pineado a `min=max=1` (dos instancias se pisaban el store) y por lo tanto la razón por la
 * que la app no tenía redundancia.
 *
 * DOS FORMAS DE CONECTAR, según dónde corra:
 *
 *  - **Cloud Run → Cloud SQL**: por socket Unix. Cloud Run monta el socket del conector en
 *    `/cloudsql/<INSTANCE_CONNECTION_NAME>` cuando el servicio se deploya con
 *    `--add-cloudsql-instances`. No hace falta VPC connector ni IP pública. `pg` habla por
 *    socket si el `host` es un directorio.
 *  - **Local / cualquier otro lado**: `DATABASE_URL` normal (`postgres://…`).
 *
 * SOBRE EL TAMAÑO DEL POOL: cada instancia de Cloud Run abre su propio pool, así que el
 * límite real es `max × instancias` contra el `max_connections` de la instancia de Cloud SQL
 * (una db-f1-micro trae 25). Con `max: 5` y hasta 4 instancias son 20 conexiones, que entra
 * con margen. Subir esto sin subir el tier de Cloud SQL es la forma clásica de que la app
 * empiece a fallar con "too many connections" bajo carga.
 */
import { Pool, type PoolClient, type QueryResultRow } from "pg";

/** Tope de conexiones por instancia. Ver la nota sobre max_connections arriba. */
const POOL_MAX = (() => {
  const raw = process.env.PGPOOL_MAX;
  const n = raw ? parseInt(raw, 10) : 5;
  return Number.isFinite(n) && n > 0 ? n : 5;
})();

/** Se cierra una conexión ociosa tras esto; libera cupo cuando la app está quieta. */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * Cuánto se espera una conexión del pool antes de fallar. Corto a propósito: si el pool
 * está agotado, es mejor un error claro y rápido que una request colgada.
 */
const CONNECTION_TIMEOUT_MS = 10_000;

function poolConfig() {
  const instancia = process.env.CLOUD_SQL_CONNECTION_NAME;
  const comun = {
    max: POOL_MAX,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    // Nombre visible en pg_stat_activity: sirve para saber QUÉ está ocupando conexiones.
    application_name: "open-carrusel",
  };

  if (instancia) {
    // Socket Unix del conector de Cloud Run. `pg` detecta que es socket porque el host
    // empieza con "/".
    return {
      ...comun,
      host: `/cloudsql/${instancia}`,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE ?? "opencarrusel",
    };
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Falta configuración de base de datos: definí DATABASE_URL (local) o " +
        "CLOUD_SQL_CONNECTION_NAME + PGUSER/PGPASSWORD (Cloud Run)."
    );
  }
  return { ...comun, connectionString: url };
}

/**
 * El pool vive en `globalThis`, no en el scope del módulo — mismo motivo que los mutexes de
 * data.ts y el carril: Next instancia el mismo módulo varias veces (HMR, grafos distintos
 * por route handler) y un pool por instancia multiplicaría las conexiones hasta agotar
 * `max_connections`.
 */
const g = globalThis as unknown as { __ocPgPool?: Pool };

export function getPool(): Pool {
  if (!g.__ocPgPool) {
    const pool = new Pool(poolConfig());
    // Un error en una conexión OCIOSA llega acá, no al await de una query. Sin este
    // handler, Node lo trata como excepción no capturada y tumba el proceso — que es
    // exactamente lo que no queremos de una app que buscamos hacer más disponible.
    pool.on("error", (err) => {
      console.error(
        JSON.stringify({
          severity: "ERROR",
          evento: "db.pool_error",
          ts: new Date().toISOString(),
          motivo: err.message,
        })
      );
    });
    g.__ocPgPool = pool;
  }
  return g.__ocPgPool;
}

/** Corre una consulta y devuelve las filas. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const res = await getPool().query<T>(sql, params as unknown[]);
  return res.rows;
}

/** Corre una consulta que devuelve como mucho una fila. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = []
): Promise<T | null> {
  const filas = await query<T>(sql, params);
  return filas[0] ?? null;
}

/**
 * Corre `fn` dentro de una transacción, con COMMIT o ROLLBACK automático.
 *
 * Es lo que reemplaza al mutex por archivo de `data.ts`: donde antes se serializaba a mano
 * dentro del proceso, ahora la atomicidad la da la base y vale entre instancias.
 */
export async function transaction<T>(fn: (cliente: PoolClient) => Promise<T>): Promise<T> {
  const cliente = await getPool().connect();
  try {
    await cliente.query("BEGIN");
    const valor = await fn(cliente);
    await cliente.query("COMMIT");
    return valor;
  } catch (e) {
    await cliente.query("ROLLBACK").catch(() => {
      /* la conexión ya puede estar rota; el release de abajo la descarta */
    });
    throw e;
  } finally {
    cliente.release();
  }
}

/**
 * Toma un advisory lock de sesión mientras corre `fn`.
 *
 * Los advisory locks son la pieza que permite tener UN carril global con varias instancias:
 * son locks de Postgres que no cuelgan de ninguna fila, así que sirven para coordinar
 * "solo uno a la vez" a nivel aplicación.
 *
 * `pg_try_advisory_lock` no espera: si otra instancia lo tiene, devuelve false y quien llama
 * decide. Es lo que queremos para el pump del carril — si otra instancia ya está repartiendo
 * turnos, esta no necesita hacerlo también.
 */
export async function withAdvisoryLock<T>(
  clave: number,
  fn: () => Promise<T>
): Promise<T | null> {
  const cliente = await getPool().connect();
  try {
    const res = await cliente.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [clave]
    );
    if (!res.rows[0]?.locked) return null;
    try {
      return await fn();
    } finally {
      await cliente.query("SELECT pg_advisory_unlock($1)", [clave]).catch(() => {
        /* si la conexión murió, el lock se libera solo al cerrarse la sesión */
      });
    }
  } finally {
    cliente.release();
  }
}

/** ¿Está configurada la base? Permite convivir con el modo JSON durante la migración. */
export function dbConfigurada(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.CLOUD_SQL_CONNECTION_NAME);
}

/** Cierra el pool. Para scripts y para el apagado ordenado. */
export async function closePool(): Promise<void> {
  const pool = g.__ocPgPool;
  if (!pool) return;
  g.__ocPgPool = undefined;
  await pool.end().catch(() => {});
}
