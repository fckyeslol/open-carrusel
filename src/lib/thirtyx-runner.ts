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
import { ingestReference, buildGenerationMessage } from "./thirtyx";
import { spawnClaude } from "./generate-headless";
import { buildSystemPrompt } from "./chat-system-prompt";
import { getBrand } from "./brand";
import { getCarousel } from "./carousels";
import { getPreset } from "./style-presets";
import { exportAllSlides } from "./export-slides";
import { isInstagramUrl } from "./instagram-url";
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
    const brand = await getBrand();
    const freshCarousel = await getCarousel(carousel.id);
    const stylePreset = await getPreset(preset.id);
    const systemPrompt = buildSystemPrompt(brand, freshCarousel, stylePreset, localBase());

    const gen = await spawnClaude({
      message: buildGenerationMessage(referenceCount),
      systemPrompt,
      cwd: process.cwd(),
    });
    if (gen.exitCode && gen.exitCode !== 0) {
      throw new Error(
        `Claude terminó con código ${gen.exitCode}. ${gen.stderr.slice(-400) || ""}`.trim()
      );
    }

    // 3. Render a PNG (verifica que la generación produjo láminas).
    await setStatus(jobId, "rendering");
    const finalCarousel = await getCarousel(carousel.id);
    if (!finalCarousel || finalCarousel.slides.length === 0) {
      throw new Error("La generación no produjo láminas");
    }
    const files = await exportAllSlides(finalCarousel.slides, finalCarousel.aspectRatio);
    const outDir = path.resolve(process.cwd(), "public", "exports", carousel.id);
    await mkdir(outDir, { recursive: true });
    for (const f of files) {
      await writeFile(path.join(outDir, f.name), f.buffer);
    }

    // 4. Listo para QA. NO se toca Prewave: la diseñadora revisa y entrega a mano.
    await setStatus(jobId, "done", { resultUrl: `/exports/${carousel.id}/` });
  } catch (e) {
    const msg = (e as Error).message || "Error desconocido en la generación";
    await setStatus(jobId, "failed", { error: msg });
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
