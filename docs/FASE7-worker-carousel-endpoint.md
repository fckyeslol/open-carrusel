# Fase 7 — endpoint de worker para adjuntar las láminas (prewave-saas)

> No pude escribir esto directo: el harness bloquea editar archivos fuera de
> `30x-carruseles`. Aplicá este patch en `prewave-saas` (o abrí una sesión de
> Claude en ese repo y pegale este archivo). Base: `company/main` (lo desplegado).

## Qué resuelve
El worker (Open Carrusel) genera los PNG pero **no puede hostearlos**: `/uploads/sign`
pide permiso `publications:write` que la diseñadora no tiene (403 verificado). Este
endpoint vive en el **worker router de agent-jobs** (que ya acepta el JWT de diseño
con scope `design:work|design:review`), así que la diseñadora sí puede usarlo. Sube
las láminas a GCS y las **siembra en `curated_briefs.publish_media_urls`** (en orden),
que es lo que el compositor/publicación ya consume (`ensureDraftPublication`).

Solo aplica a jobs de **Producción** (con `brief_id`); los legacy de Diseño
(`design_request_id`) no tienen brief donde sembrar la media.

## Patch: `api/src/routers/agent-jobs.ts`

### 1. Import (junto a los otros imports)
```ts
import { storeUpload, isGcsConfigured } from "../lib/storage";
```

### 2. Nuevo endpoint (agregar dentro del `agentJobsWorkerRouter`, después del `PATCH /:id`)
```ts
const MAX_SLIDES = 10;
const SLIDE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// POST /agent-jobs/:id/carousel — Open Carrusel (worker local) sube las láminas
// PNG ya renderizadas. Se guardan en GCS y se siembran como media de publicación
// del brief ligado (publish_media_urls, EN ORDEN); luego se cierra el job
// (done + result_url). Multipart: un campo `file` por lámina, con filename
// slide-0001.png, slide-0002.png, … (se ordena por nombre, natural/numérico).
// Auth: la del worker router (JWT de diseño scopeado a SUS jobs, o X-API-Key ops).
agentJobsWorkerRouter.post("/:id/carousel", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id requerido" }, 400);

  // Sin GCS no hay dónde hostear: no sembramos URLs locales inservibles en un brief.
  if (!isGcsConfigured()) {
    return c.json({ error: "Almacenamiento de media no configurado (GCS)" }, 503);
  }

  // Ownership: misma semántica que el PATCH (no tocar un job ajeno).
  const scope = c.get("agentJobsScope");
  if (!scope.all) {
    const access = await checkJobScope(id, scope);
    if (access === "not_found") return c.json({ error: "Job no encontrado" }, 404);
    if (access === "denied") return c.json({ error: "Este trabajo no es tuyo" }, 403);
  }

  const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, id)).limit(1);
  if (!job) return c.json({ error: "Job no encontrado" }, 404);
  if (!job.briefId) {
    return c.json({ error: "Solo los jobs de Producción (con brief) pueden adjuntar láminas" }, 422);
  }

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ error: "multipart inválido" }, 400);
  }
  const raw = form.file;
  const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
  if (files.length === 0) return c.json({ error: "faltan las láminas (campo 'file')" }, 422);
  if (files.length > MAX_SLIDES) return c.json({ error: `demasiadas láminas (máx ${MAX_SLIDES})` }, 422);
  files.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

  const urls: string[] = [];
  try {
    for (const f of files) {
      if (!SLIDE_CONTENT_TYPES.has(f.type)) {
        return c.json({ error: `tipo no soportado: ${f.type || "desconocido"}` }, 422);
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const stored = await storeUpload(bytes, { fileName: f.name || "slide.png", contentType: f.type });
      urls.push(stored.url);
    }
  } catch (e) {
    console.error("[agent-jobs/carousel] upload failed:", e);
    return c.json({ error: e instanceof Error ? e.message : "no se pudieron subir las láminas" }, 502);
  }

  const now = new Date();
  // Sembrar la media del brief (mismo shape que preload.ts): publish_media_urls =
  // N imágenes en orden; el compositor/publicación las toma como el carrusel.
  await db
    .update(curatedBriefs)
    .set({
      publishMediaUrls: urls,
      publishMediaStatus: "ready",
      publishMediaSource: "original",
      updatedAt: now,
    })
    .where(eq(curatedBriefs.id, job.briefId));

  const [updated] = await db
    .update(agentJobs)
    .set({ status: "done", resultUrl: urls[0] ?? null, updatedAt: now })
    .where(eq(agentJobs.id, id))
    .returning();

  return c.json({ ok: true, urls, job: serializeAgentJob(updated) });
});
```

## Notas de contrato (verificadas en el código desplegado)
- `storeUpload(bytes, {fileName, contentType})` → `{url, key}`; sube a GCS si
  `config.uploads.gcsBucket` está seteado (en prod lo está: los assets publicados
  viven en `storage.googleapis.com/prewave-media/...`).
- `publish_media_source` es `varchar(12)`; `brief-mapper` lo tipa como
  `"corregido" | "original"`. Usar `"original"` (el 30x ES el contenido original).
- `publish_media_status`: `"ready"` deja la media lista para el draft de publicación
  (`ensureDraftPublication` lee `brief.publishMediaUrls`).
- No hay migración de schema: `publish_media_urls/status/source` ya existen.

## Lado del worker (Open Carrusel — este repo, `src/lib/thirtyx-runner.ts`)
Una vez desplegado el endpoint, reemplazar el `completeJob(jobId, localUrl)` por la
subida de los PNG exportados:

```ts
// tras exportar los PNG (files) — en vez de completeJob con URL local:
await writeback(() => uploadCarousel(jobId, files)); // POST multipart a /agent-jobs/:id/carousel
```

Agregar en `src/lib/prewave.ts` un `uploadCarousel(jobId, files)` que arma un
FormData con cada PNG como `file` y filename `slide-0001.png`… y hace
`PATCH`→ no, `POST /agent-jobs/:id/carousel` con el Bearer de la diseñadora. El
endpoint ya marca `done`, así que se saca el `completeJob` para jobs con brief.
Mantener `failJob` en el catch. (No commitear el lado worker hasta que el endpoint
esté desplegado, o hacerlo con fallback a `completeJob` si responde 404.)
```
