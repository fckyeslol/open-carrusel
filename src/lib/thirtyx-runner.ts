/**
 * Runner headless de generación local. Cada diseñadora corre esto en su máquina:
 * la app jala sus trabajos de Prewave (pull, ver /api/thirtyx/sync) y este runner
 * los genera SOLOS, sin intervención y **sin tocar Prewave**.
 *
 *   ingest (baja el referente + crea el carrusel) → generar (mismo subproceso
 *   Claude que /api/chat, vía spawnClaude) → render a PNG → status "done" (listo
 *   para QA).
 *
 * La generación no reclama ni cierra nada en producción: eso pasa solo cuando la
 * diseñadora hace QA y aprieta "Entregar" (POST /api/thirtyx/jobs/[id]/complete).
 *
 * Es un singleton en `globalThis` (sobrevive al HMR de dev) con un límite de
 * concurrencia (cada job levanta Puppeteer + un subproceso Claude).
 */
import path from "path";
import { mkdir, writeFile } from "fs/promises";
import { ingestReference, buildGenerationMessage, buildContinuationMessage } from "./thirtyx";
import { spawnClaude } from "./generate-headless";
import { buildSystemPrompt } from "./chat-system-prompt";
import { getBrand } from "./brand";
import { getCarousel } from "./carousels";
import { getPreset } from "./style-presets";
import { exportAllSlides } from "./export-slides";
import { isInstagramUrl } from "./instagram-url";
import { claimJob, completeJob, failJob } from "./prewave";
import {
  getAssignment,
  setStatus,
  incrementAttempts,
  listReprocessable,
} from "./assignments";

function maxConcurrent(): number {
  const n = parseInt(process.env.THIRTYX_MAX_CONCURRENT || "1", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
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
    const systemPrompt = buildSystemPrompt(brand, freshCarousel, stylePreset, localBase());

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
    //    si Prewave está caído. resultUrl apunta al editor local donde la diseñadora
    //    revisa (worker local-first). ⚠️ Subir los PNG a GCS y adjuntarlos al brief
    //    para el flujo de aprobación/publicación es Fase 7 del plan (contrato por
    //    confirmar en Prewave); todavía no está.
    await setStatus(jobId, "done", { resultUrl: `/exports/${carousel.id}/` });
    await writeback(() => completeJob(jobId, `${localBase()}/carousel/${carousel.id}`));
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
