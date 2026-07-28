-- Esquema inicial de Open Carrusel en PostgreSQL.
--
-- POR QUÉ EXISTE: hasta ahora la "base de datos" eran archivos JSON con un mutex por
-- proceso sobre un volumen GCS FUSE. Eso obligaba a `min=max=1` en Cloud Run (dos
-- instancias se pisaban), o sea CERO redundancia: si la instancia moría, la app estaba
-- caída. Además GCS FUSE devuelve ESTALE/EIO cada tanto y ya hubo un incidente de store
-- vaciado. Postgres elimina las tres cosas y habilita multi-instancia.
--
-- CRITERIO DEL MODELO — híbrido a propósito:
--
--   * Relacional para lo CALIENTE (carousels, slides, assignments). `carousels.json` pesa
--     2.1 MB y hoy CADA edición de una lámina reescribe el archivo entero; durante una
--     generación eso son decenas de reescrituras de 2.1 MB. Con `slides` en su propia
--     tabla, editar una lámina es un UPDATE de una fila.
--   * Clave→JSONB para lo FRÍO y de baja frecuencia (brand, templates, presets, users,
--     paletas, fondos, prewave, staged-actions). Son chicos, se leen enteros y no se
--     consultan por campos internos: normalizarlos sería trabajo sin retorno.
--
-- Convenciones: identificadores en inglés (siguen a los tipos de src/types), timestamps en
-- `timestamptz` siempre, y `updated_at` mantenido por trigger para que ningún camino de
-- escritura pueda olvidarse de tocarlo.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Trigger de updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Documentos frío: reemplazo directo de los .json chicos
-- ---------------------------------------------------------------------------
-- `key` es el nombre de archivo de antes ("brand.json", "templates.json", …) para que la
-- migración sea 1:1 y `data.ts` conserve su API. `revision` habilita escrituras con
-- optimistic locking sin bloquear filas.
CREATE TABLE IF NOT EXISTS documents (
  key         text PRIMARY KEY,
  payload     jsonb NOT NULL,
  revision    bigint NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS documents_updated_at ON documents;
CREATE TRIGGER documents_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Carruseles y láminas
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carousels (
  id                text PRIMARY KEY,
  name              text NOT NULL,
  aspect_ratio      text NOT NULL,
  style_preset_id   text,
  prewave_job_id    text,
  caption           text,
  -- Campos del dominio que no se consultan por separado (referenceImages, source, flags
  -- del editor…). Se guardan enteros en vez de inventar una columna por cada uno.
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS carousels_updated_at ON carousels;
CREATE TRIGGER carousels_updated_at BEFORE UPDATE ON carousels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- El board busca el carrusel de un job de Prewave; sin esto sería un scan de la tabla.
CREATE INDEX IF NOT EXISTS carousels_prewave_job_id_idx
  ON carousels (prewave_job_id) WHERE prewave_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS slides (
  id            text PRIMARY KEY,
  carousel_id   text NOT NULL REFERENCES carousels(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  html          text NOT NULL,
  notes         text,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS slides_updated_at ON slides;
CREATE TRIGGER slides_updated_at BEFORE UPDATE ON slides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Listar las láminas de un carrusel en orden es LA consulta más frecuente de la app.
CREATE INDEX IF NOT EXISTS slides_carousel_position_idx ON slides (carousel_id, position);

-- Dos láminas del mismo carrusel no pueden compartir posición. DEFERRABLE porque reordenar
-- pasa por estados intermedios inválidos dentro de la misma transacción (mover la 3 a la 1
-- deja dos "1" hasta que se corren las demás); sin diferirlo habría que usar posiciones
-- negativas temporales, que es la clase de truco que después nadie entiende.
ALTER TABLE slides DROP CONSTRAINT IF EXISTS slides_carousel_position_unica;
ALTER TABLE slides ADD CONSTRAINT slides_carousel_position_unica
  UNIQUE (carousel_id, position) DEFERRABLE INITIALLY DEFERRED;

-- Historial de versiones por lámina (el "undo" del editor). Va en su propia tabla porque
-- crece sin techo y no debe pesar en la lectura normal de una lámina.
CREATE TABLE IF NOT EXISTS slide_versions (
  id           bigserial PRIMARY KEY,
  slide_id     text NOT NULL,
  carousel_id  text NOT NULL REFERENCES carousels(id) ON DELETE CASCADE,
  html         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- El undo pide la última versión de una lámina: índice descendente para que sea un lookup.
CREATE INDEX IF NOT EXISTS slide_versions_slide_idx
  ON slide_versions (slide_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Asignaciones (la cola 30x)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignments (
  job_id        text PRIMARY KEY,
  brief_id      text,
  avatar_id     text,
  delivery_id   text,
  event         text NOT NULL DEFAULT 'pull',
  avatar_slug   text NOT NULL DEFAULT '',
  avatar_name   text,
  reference_url text NOT NULL DEFAULT '',
  designer_id   text,
  status        text NOT NULL,
  carousel_id   text,
  result_url    text,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  priority      integer NOT NULL DEFAULT 20,
  -- Checkpoint de generación (sessionId de Claude, pasadas, stalls, preempciones). JSONB
  -- porque es un bloque que se lee y escribe entero y solo lo entiende el runner.
  generation    jsonb,
  -- Campos de archivado/biblioteca que agregó el board, sin columna propia.
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS assignments_updated_at ON assignments;
CREATE TRIGGER assignments_updated_at BEFORE UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- El board filtra por diseñadora y por estado; reconcile() barre por estado.
CREATE INDEX IF NOT EXISTS assignments_designer_idx ON assignments (designer_id);
CREATE INDEX IF NOT EXISTS assignments_status_idx ON assignments (status);

-- ---------------------------------------------------------------------------
-- El CARRIL de trabajos, ahora durable y compartido entre instancias
-- ---------------------------------------------------------------------------
-- Con `min=max=1` el carril podía vivir en `globalThis`. Con 2+ instancias eso daría DOS
-- carriles —o sea dos generaciones simultáneas— y las garantías de prioridad y preempción
-- se disolverían. La cola pasa a ser una tabla y el turno se toma con
-- `FOR UPDATE SKIP LOCKED`, que es el patrón canónico de cola en Postgres.
--
-- Beneficio extra: la cola sobrevive reinicios. Hoy `reconcile()` tiene que barrer los
-- assignments IN_FLIGHT al bootear para reconstruirla; con esto, ya está en la tabla.
CREATE TABLE IF NOT EXISTS job_queue (
  id             text PRIMARY KEY,
  kind           text NOT NULL,              -- 'thirtyx' | 'chat' | 'resize'
  priority       integer NOT NULL,           -- menor = más urgente
  state          text NOT NULL DEFAULT 'queued', -- queued | active | done | failed
  phase          text,                       -- ingesting | generating | rendering | other
  -- Quién lo tomó y hasta cuándo vale su reserva. El lease es lo que evita que un job
  -- quede tomado para siempre si la instancia que lo agarró se muere.
  claimed_by     text,
  claimed_at     timestamptz,
  lease_until    timestamptz,
  -- Señal de preempción: la instancia dueña la observa y cede el carril.
  preempt_signal boolean NOT NULL DEFAULT false,
  preemptions    integer NOT NULL DEFAULT 0,
  sticky_key     text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  enqueued_at    timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS job_queue_updated_at ON job_queue;
CREATE TRIGGER job_queue_updated_at BEFORE UPDATE ON job_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- El orden del carril: prioridad y, a igual prioridad, orden de llegada. Parcial sobre
-- `queued` porque es lo único que se recorre para elegir el próximo.
CREATE INDEX IF NOT EXISTS job_queue_orden_idx
  ON job_queue (priority, enqueued_at) WHERE state = 'queued';

-- Para detectar leases vencidos (una instancia que murió con el job tomado).
CREATE INDEX IF NOT EXISTS job_queue_lease_idx
  ON job_queue (lease_until) WHERE state = 'active';

INSERT INTO schema_migrations (version) VALUES ('001_esquema_inicial')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
