# Base de datos

Migración del store de archivos JSON a PostgreSQL. **Está a medias**: la base y el store de
documentos funcionan; carruseles, pedidos y el carril todavía no. Este documento dice qué
hay, qué falta y cómo seguir.

## Por qué

La "base de datos" son archivos JSON con un mutex **por proceso** sobre un volumen GCS FUSE.
Tres consecuencias:

1. Cloud Run está pineado a `min=max=1` — dos instancias se pisarían el archivo. Cero
   redundancia: si la instancia muere, la app está caída.
2. GCS FUSE devuelve `ESTALE`/`EIO` cada tanto. `data.ts` los sortea con 8 reintentos, pero
   es un parche, y ya hubo un incidente de store vaciado.
3. `carousels.json` pesa 2.1 MB y **cada** edición de una lámina reescribe el archivo entero.
   Durante una generación eso son decenas de reescrituras completas.

## Estado

| Pieza | Estado |
|---|---|
| Esquema (`001_esquema_inicial.sql`) | listo, idempotente, verificado contra PG 16 |
| Pool y helpers (`src/lib/db.ts`) | listo (socket de Cloud SQL o `DATABASE_URL`) |
| Store de documentos (`src/lib/data-pg.ts`) | listo y con tests |
| `carousels` / `slides` relacional | **falta** — hoy caen al JSONB de `documents` |
| `assignments` relacional | **falta** — ídem |
| Script de migración JSON → PG | **falta** |
| Carril distribuido (`job_queue`) | tabla creada, **código falta** |
| Infra Cloud SQL + `min=max=1` | **falta** |

## La guarda que impide un accidente

`data.ts` salta a Postgres en cuanto ve `DATABASE_URL` o `CLOUD_SQL_CONNECTION_NAME`. Como
`carousels.ts` y `assignments.ts` leen por `readDataSafe` —que ante un documento inexistente
devuelve el fallback **vacío**— configurar la base sin migrar los datos mostraría cero
carruseles y cero pedidos, indistinguible de haberlo perdido todo, y la primera escritura
persistiría ese vacío.

Por eso `data-pg.ts` exige una marca `datos_migrados` en `schema_migrations` y **falla fuerte
con instrucciones** si no está. El script de migración es el que debe escribirla, al final y
solo si verificó los conteos.

## Levantar una base local

```powershell
docker run -d --name oc-pg `
  -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=oc -e POSTGRES_DB=opencarrusel `
  -p 55432:5432 postgres:16-alpine

docker exec -i oc-pg psql -U oc -d opencarrusel -v ON_ERROR_STOP=1 < db/001_esquema_inicial.sql
```

Correr los tests contra ella (sin esta variable se saltean solos, que es lo que necesita la
máquina de una diseñadora):

```powershell
$env:TEST_DATABASE_URL = "postgres://oc:dev@localhost:55432/opencarrusel"
npm test
```

## Los dos backends

`data.ts` es un despachante:

- **PostgreSQL** si hay base configurada → modo hosteado.
- **Filesystem** si no → modo local. Las diseñadoras corren la app con `git clone` +
  `npm run abrir` en Windows, sin Docker ni Postgres. **Ese camino no se puede romper.**

El costo es mantener dos implementaciones. La alternativa era exigirle un Postgres a cada
diseñadora, que rompía el modelo de distribución.

El backend de Postgres se carga con `import()` dinámico, no estático. Además de no cargar
`pg` en modo local, evita una rotura concreta: un import estático mete `pg` en el grafo de
cualquier módulo que toque el store, y `pg` hace `require('./client')` sin extensión, lo que
revienta bajo el hook de resolución de los tests.

## Cómo seguir, en orden

1. **`carousels`/`slides` relacional.** El contrato ya está definido por los tests de
   `carousels.test.mts`: hacer que la versión Postgres los pase es la definición de "listo".
   Es el que más rinde — elimina la reescritura de 2.1 MB por lámina.
2. **`assignments` relacional.** Más chico, misma mecánica.
3. **Script de migración.** Idempotente, que compare conteos antes y después y **recién ahí**
   escriba la marca `datos_migrados`.
4. **Carril distribuido.** El que no se puede saltear antes de multi-instancia: con dos
   instancias, el carril de `globalThis` de `job-queue.ts` daría **dos** carriles, y las
   garantías de prioridad y preempción se disuelven. La tabla `job_queue` ya está: el turno
   se toma con `SELECT ... FOR UPDATE SKIP LOCKED` y el carril global con el advisory lock de
   `withAdvisoryLock()`. Ojo con el `lease_until`: es lo que recupera un job si la instancia
   que lo tomó se muere.
5. **Infra.** Crear Cloud SQL, migrar los datos de producción, deployar con
   `--add-cloudsql-instances`, verificar, y **recién entonces** levantar `min=max=1`.

## Notas del esquema

- **Modelo híbrido**: relacional para lo caliente, clave→JSONB para lo frío (brand,
  templates, presets, users…). Esos son chicos, se leen enteros y no se consultan por campos
  internos: normalizarlos sería trabajo sin retorno.
- `slides` tiene un único `(carousel_id, position)` **DEFERRABLE**: reordenar pasa por
  estados intermedios inválidos dentro de la misma transacción, y sin diferirlo habría que
  usar posiciones negativas temporales.
- El pool usa `max: 5` por instancia. El límite real es `max × instancias` contra el
  `max_connections` de Cloud SQL (una `db-f1-micro` trae 25). Subir uno sin mirar el otro es
  la forma clásica de empezar a ver "too many connections".
