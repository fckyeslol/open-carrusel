/**
 * Runner headless de generación local: el WORKER que drena la cola `agent_jobs` de
 * Prewave. Cada diseñadora corre esto en su máquina; la app jala sus jobs (pull, ver
 * /api/thirtyx/sync) y este runner los genera SOLOS.
 *
 *   pre-flight (¿hay preset local del avatar?) → claim (PATCH processing) → ingest
 *   (baja el referente + crea el carrusel) → generar (mismo subproceso Claude que
 *   /api/chat, vía spawnClaude) → render a PNG → done + writeback (PATCH done).
 *
 * Toca Prewave en dos puntos, ambos best-effort (no pisan el estado local, que manda
 * para la UI): claim al empezar y writeback (done/failed) al terminar. Los jobs que
 * este install NO puede hacer (avatar sin preset local, o sin avatar resuelto) quedan
 * `blocked` SIN reclamarse ni marcarse failed, para no ensuciar el board.
 *
 * ⚠️ Pendiente (Fase 7 del plan): subir los PNG a GCS y adjuntarlos al brief para el
 * flujo de aprobación/publicación. Hoy el `resultUrl` del writeback apunta al editor
 * local (worker local-first); el contrato de assets falta confirmarlo en Prewave.
 *
 * Es un singleton en `globalThis` (sobrevive al HMR de dev) con un límite de
 * concurrencia (cada job levanta Puppeteer + un subproceso Claude).
 */
import path from "path";
import { mkdir, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { ingestReference, buildGenerationMessage, buildContinuationMessage } from "./thirtyx";
import { spawnClaude } from "./generate-headless";
import { buildSystemPrompt } from "./chat-system-prompt";
import { getBrand } from "./brand";
import { getCarousel } from "./carousels";
import { getPreset, getPresetByAvatarSlug } from "./style-presets";
import { exportAllSlides } from "./export-slides";
import { isInstagramUrl } from "./instagram-url";
import { claimJob, completeJob, failJob, uploadCarousel } from "./prewave";
import { getInternalApiToken, isHostedMode } from "./hosted";
import { isHiggsfieldConfigured } from "./higgsfield";
import {
  getAssignment,
  setStatus,
  incrementAttempts,
  listReprocessable,
} from "./assignments";

/**
 * Cuántos jobs se generan a la vez. Cada uno levanta Puppeteer + un subproceso
 * Claude, así que el tope real lo pone la RAM/CPU de la máquina. Default 4;
 * subilo con THIRTYX_MAX_CONCURRENT si la máquina aguanta. Se limita a
 * MAX_CONCURRENT_CAP para no quemar la máquina por un valor absurdo en el env.
 */
const DEFAULT_MAX_CONCURRENT = 4;
const MAX_CONCURRENT_CAP = 8;

function maxConcurrent(): number {
  const raw = process.env.THIRTYX_MAX_CONCURRENT;
  const n = raw ? parseInt(raw, 10) : DEFAULT_MAX_CONCURRENT;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CONCURRENT;
  return Math.min(n, MAX_CONCURRENT_CAP);
}

/**
 * Tope duro de pasadas de generación por job. Cada pasada es un turno de Claude
 * (buildGenerationMessage la 1ra, buildContinuationMessage las siguientes). Existe
 * para que un agente que nunca completa no queme presupuesto en un loop infinito.
 */
const MAX_GENERATION_PASSES = 8;

/**
 * Corre la generación hasta que el carrusel tenga las `referenceCount` láminas.
 *
 * El agente headless a veces genera una lámina (o unas pocas) y CIERRA su turno
 * antes de completar el carrusel. En vez de renderizar lo que haya, reanudamos la
 * MISMA sesión de Claude (--resume) con un mensaje de continuación hasta llegar al
 * conteo del referente. Reanudar conserva el contexto caro (las imágenes de
 * referencia ya leídas con visión, las láminas ya creadas), así que la pasada
 * siguiente solo escribe lo que falta.
 *
 * Corta antes del tope si dos pasadas seguidas no agregan ni una lámina (el agente
 * está trabado): mejor fallar con un mensaje claro que girar en falso.
 */
async function generateAllSlides(
  carouselId: string,
  referenceCount: number,
  systemPrompt: string
): Promise<number> {
  let sessionId: string | undefined;
  let stalls = 0;

  for (let pass = 0; pass < MAX_GENERATION_PASSES; pass++) {
    const before = (await getCarousel(carouselId))?.slides.length ?? 0;
    if (before >= referenceCount) return before;

    const message =
      pass === 0
        ? buildGenerationMessage(referenceCount)
        : buildContinuationMessage(before, referenceCount);

    const gen = await spawnClaude({
      message,
      systemPrompt,
      sessionId,
      cwd: process.cwd(),
      env: runnerSpawnEnv(),
    });
    if (gen.exitCode && gen.exitCode !== 0) {
      throw new Error(
        `Claude terminó con código ${gen.exitCode}. ${gen.stderr.slice(-400) || ""}`.trim()
      );
    }
    // La sesión permite reanudar la conversación en la próxima pasada.
    if (gen.sessionId) sessionId = gen.sessionId;

    const after = (await getCarousel(carouselId))?.slides.length ?? 0;
    if (after >= referenceCount) return after;

    // Sin progreso: no reanudes eternamente si el agente no avanza.
    if (after <= before) {
      stalls += 1;
      if (stalls >= 2) break;
    } else {
      stalls = 0;
    }
  }

  return (await getCarousel(carouselId))?.slides.length ?? 0;
}

/** Base loopback donde el curl de Claude escribe las láminas (mismo server local). */
function localBase(): string {
  return `http://127.0.0.1:${process.env.PORT || "3000"}`;
}

/**
 * Modo hosteado: los jobs de la cola no tienen usuaria logueada, así que el
 * runner usa un token de worker dedicado (CLAUDE_RUNNER_OAUTH_TOKEN — un
 * `claude setup-token` de la cuenta que quieras que pague la cola). Sin él,
 * hereda la auth local del server (modo local: comportamiento de siempre).
 */
function runnerSpawnEnv(): Record<string, string> | undefined {
  const token = process.env.CLAUDE_RUNNER_OAUTH_TOKEN;
  if (!token) return undefined;
  // Config dir propio del worker: mismas razones que en /api/chat — que unas
  // credenciales globales del server nunca pisen el token del worker. Base
  // configurable (CLAUDE_CONFIG_BASE) para apuntar a disco local en Cloud Run.
  const configBase =
    process.env.CLAUDE_CONFIG_BASE || path.resolve(process.cwd(), "data", "claude-config");
  const configDir = path.join(configBase, "_runner");
  mkdirSync(configDir, { recursive: true });
  return { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: configDir };
}

/** Token interno para que el subproceso pase el proxy de auth (modo hosteado). */
function runnerInternalToken(): string | undefined {
  return isHostedMode() ? getInternalApiToken() : undefined;
}

interface Runner {
  queued: string[];
  active: Set<string>;
  seen: Set<string>;
  enqueue: (jobId: string, opts?: { force?: boolean }) => void;
  reconcile: () => Promise<void>;
}

async function processAssignment(jobId: string): Promise<void> {
  const a = await getAssignment(jobId);
  if (!a) return;
  if (a.status === "done" || a.status === "delivered") return; // ya generado / entregado

  // PRE-FLIGHT (antes de reclamar y sin tocar Prewave): ¿podemos generar ESTE job
  // en esta máquina? Si el avatar no tiene un preset local `ready` (falta su ADN, o
  // el job vino sin avatar resuelto), lo dejamos `blocked` — NO lo reclamamos ni lo
  // marcamos failed en Prewave, así no ensuciamos el board por un install incompleto:
  // sigue `pending` para otra diseñadora que sí tenga ese avatar.
  const blockReason = await preflightBlockReason(a.avatarSlug);
  if (blockReason) {
    await setStatus(jobId, "blocked", { error: blockReason });
    return;
  }

  try {
    await incrementAttempts(jobId);

    // Reclama el job en Prewave (pending → processing) para que otro worker no lo
    // tome. Best-effort: si el PATCH falla (403 de ownership, red), seguimos con la
    // generación local igual — el claim es una optimización, no un bloqueo. Ver
    // docs/PLAN-MIGRACION-CARRUSELES.md §3/§6.5.
    await writeback(() => claimJob(jobId));

    if (!isInstagramUrl(a.referenceUrl)) {
      throw new Error(`El referente no es una URL de Instagram válida: ${a.referenceUrl || "(vacío)"}`);
    }

    // 1. Ingesta: baja el referente y crea el carrusel con el ADN del avatar.
    await setStatus(jobId, "ingesting");
    const { carousel, preset, referenceCount } = await ingestReference({
      referenceUrl: a.referenceUrl,
      avatarSlug: a.avatarSlug,
      name: a.avatarName ? `${a.avatarName} — job ${jobId.slice(0, 8)}` : undefined,
      prewaveJobId: jobId,
      source: "queue",
    });
    await setStatus(jobId, "generating", { carouselId: carousel.id });

    // 2. Generación headless: mismo subproceso Claude que el chat, sin navegador.
    //    Se generan TODAS las láminas — el loop reanuda a Claude si corta antes de
    //    completar el conteo del referente, para que el QA nunca vea un carrusel a medias.
    const brand = await getBrand();
    const freshCarousel = await getCarousel(carousel.id);
    const stylePreset = await getPreset(preset.id);
    const systemPrompt = buildSystemPrompt(
      brand,
      freshCarousel,
      stylePreset,
      localBase(),
      // Mismo criterio que /api/chat: si hay credenciales de Higgsfield, el agente
      // regenera las imágenes del referente con IA también en el flujo headless.
      await isHiggsfieldConfigured(),
      runnerInternalToken()
    );

    const produced = await generateAllSlides(carousel.id, referenceCount, systemPrompt);

    // 3. Render a PNG (verifica que la generación produjo TODAS las láminas).
    await setStatus(jobId, "rendering");
    const finalCarousel = await getCarousel(carousel.id);
    if (!finalCarousel || finalCarousel.slides.length === 0) {
      throw new Error("La generación no produjo láminas");
    }
    if (produced < referenceCount) {
      throw new Error(
        `La generación quedó incompleta: ${produced} de ${referenceCount} láminas. Reintentá el job.`
      );
    }
    const files = await exportAllSlides(finalCarousel.slides, finalCarousel.aspectRatio);
    const outDir = path.resolve(process.cwd(), "public", "exports", carousel.id);
    await mkdir(outDir, { recursive: true });
    for (const f of files) {
      await writeFile(path.join(outDir, f.name), f.buffer);
    }

    // 4. Listo para QA + writeback a Prewave (→ done). El estado local es la fuente
    //    de verdad de la UI; el writeback es best-effort para no perder el resultado
    //    si Prewave está caído.
    await setStatus(jobId, "done", { resultUrl: `/exports/${carousel.id}/` });
    //    Fase 7: subir los PNG al endpoint de worker (sube a GCS + siembra las N
    //    láminas en el brief para publicación). Best-effort: si el endpoint no está
    //    (404) o el job no tiene brief (422), no pasa nada acá.
    //    "Ver 30x" (result_url del job) lo setea el endpoint a una GALERÍA pública
    //    con TODAS las láminas (accesible desde cualquier lado). Solo si el endpoint
    //    no está (404) o el job no tiene brief (422) caemos al editor LOCAL (todas
    //    las láminas también, pero solo en la máquina de la diseñadora).
    const editorUrl = `http://localhost:${process.env.PORT || "3000"}/carousel/${carousel.id}`;
    await writeback(async () => {
      try {
        await uploadCarousel(jobId, files);
        // OK: el endpoint dejó result_url apuntando a la galería pública. No pisar.
      } catch {
        await completeJob(jobId, editorUrl);
      }
    });
  } catch (e) {
    const msg = (e as Error).message || "Error desconocido en la generación";
    await setStatus(jobId, "failed", { error: msg });
    await writeback(() => failJob(jobId, msg));
  }
}

/**
 * Ejecuta un write a Prewave sin dejar que su fallo tumbe el pipeline local. El
 * estado local (data/thirtyx-assignments.json) manda para la UI; el writeback es
 * un side-effect: si el PATCH revienta (403, red, token vencido) lo tragamos acá
 * a propósito para no convertir una generación OK en un "failed", ni un fallo real
 * en un crash. Se reintenta naturalmente en el próximo ciclo/acción.
 */
async function writeback(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort: el estado local ya refleja la realidad; Prewave se reconcilia luego
  }
}

/**
 * ¿Por qué NO se puede generar este job en esta máquina? Devuelve el motivo (para
 * dejarlo `blocked`) o null si se puede. Se corre ANTES de reclamar, así los jobs
 * que este install no puede hacer (avatar sin ADN local, o job de origen Diseño sin
 * avatar resuelto) no se reclaman ni se marcan failed en Prewave: quedan pending.
 */
async function preflightBlockReason(avatarSlug: string): Promise<string | null> {
  if (!avatarSlug) {
    return "El job no trae avatar (origen Diseño sin resolver). Asigná el avatar en Prewave o generalo pegando la URL a mano.";
  }
  const preset = await getPresetByAvatarSlug(avatarSlug);
  if (!preset) {
    return `No hay un preset local para el avatar "${avatarSlug}". Importá su ADN (node scripts/import-avatars.mjs) en esta máquina.`;
  }
  if (preset.avatarStatus && preset.avatarStatus !== "ready") {
    return `El avatar "${avatarSlug}" no está listo (status=${preset.avatarStatus}): falta completar su ADN o sus formatos.`;
  }
  return null;
}

function createRunner(): Runner {
  const runner: Runner = {
    queued: [],
    active: new Set<string>(),
    seen: new Set<string>(),
    enqueue(jobId, opts) {
      if (!opts?.force && runner.seen.has(jobId)) return;
      runner.seen.add(jobId);
      runner.queued.push(jobId);
      pump();
    },
    async reconcile() {
      const pending = await listReprocessable();
      for (const a of pending) runner.enqueue(a.jobId);
    },
  };

  function pump() {
    while (runner.active.size < maxConcurrent() && runner.queued.length > 0) {
      const jobId = runner.queued.shift()!;
      runner.active.add(jobId);
      void processAssignment(jobId).finally(() => {
        runner.active.delete(jobId);
        runner.seen.delete(jobId);
        pump();
      });
    }
  }

  return runner;
}

const g = globalThis as unknown as { __thirtyxRunner?: Runner };

/** Devuelve el runner singleton (uno por proceso). */
export function getRunner(): Runner {
  if (!g.__thirtyxRunner) g.__thirtyxRunner = createRunner();
  return g.__thirtyxRunner;
}
