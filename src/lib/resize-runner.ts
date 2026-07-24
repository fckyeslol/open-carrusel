/**
 * Runner de RE-MAQUETACIÓN ("Generar otros tamaños").
 *
 * Dado un carrusel terminado en un formato, crea HERMANOS en los otros formatos y
 * re-fluye cada lámina al lienzo nuevo con IA — el MISMO subproceso Claude que la
 * generación (spawnClaude), sin navegador. A diferencia del runner de la cola, acá
 * el trabajo es determinista: UNA lámina por turno de Claude, manejada desde Node,
 * así el progreso es exacto (láminas hechas / total) y no depende de que el agente
 * "sepa" cuándo terminó.
 *
 * Estado en memoria (singleton en globalThis, sobrevive al HMR): la UI lo consulta
 * por GET /api/carousels/[id]/resize para mostrar progreso y los links a los hermanos.
 */
import path from "path";
import { mkdirSync } from "fs";
import type { AspectRatio, Carousel } from "@/types/carousel";
import { getCarousel, createResizedSibling } from "./carousels";
import { spawnClaude } from "./generate-headless";
import { getBrand } from "./brand";
import { getPreset, getPresetByAvatarSlug } from "./style-presets";
import { isHiggsfieldConfigured } from "./higgsfield";
import { getCentralClaudeToken, getInternalApiToken, isHostedMode } from "./hosted";
import { buildResizeSystemPrompt, buildAdaptSlideMessage } from "./resize-prompt";

export type ResizeStatus = "pending" | "running" | "done" | "failed";

export interface ResizeSiblingState {
  ratio: AspectRatio;
  carouselId: string;
  status: ResizeStatus;
  total: number;
  completed: number;
  error?: string;
}

export interface ResizeJobState {
  sourceId: string;
  startedAt: string;
  siblings: ResizeSiblingState[];
}

interface Registry {
  jobs: Map<string, ResizeJobState>;
}

const g = globalThis as unknown as { __resizeRegistry?: Registry };

function registry(): Registry {
  if (!g.__resizeRegistry) g.__resizeRegistry = { jobs: new Map() };
  return g.__resizeRegistry;
}

/** Base loopback donde el Python de Claude escribe las láminas (mismo server local). */
function localBase(): string {
  return `http://127.0.0.1:${process.env.PORT || "3000"}`;
}

/** Token interno para pasar el proxy de auth (solo modo hosteado). */
function internalToken(): string | undefined {
  return isHostedMode() ? getInternalApiToken() : undefined;
}

/**
 * Modo hosteado: el subproceso usa un token de worker dedicado para que el consumo
 * salga de ese seat. Sin él, hereda la auth local del server (comportamiento normal).
 * Mismo criterio que thirtyx-runner.
 */
function spawnEnv(): Record<string, string> | undefined {
  const token = getCentralClaudeToken();
  if (!token) return undefined;
  const configDir = path.resolve(process.cwd(), "data", "claude-config", "_runner");
  mkdirSync(configDir, { recursive: true });
  return { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: configDir };
}

async function resolvePreset(carousel: Carousel) {
  if (carousel.stylePresetId) {
    const p = await getPreset(carousel.stylePresetId);
    if (p) return p;
  }
  if (carousel.avatarSlug) return getPresetByAvatarSlug(carousel.avatarSlug);
  return null;
}

/**
 * Re-fluye TODAS las láminas de un hermano, una por turno de Claude. Reanuda la
 * misma sesión (--resume) entre láminas para conservar contexto de identidad y
 * abaratar por cache. Node maneja el loop → progreso exacto.
 */
async function adaptSibling(
  state: ResizeSiblingState,
  source: Carousel
): Promise<void> {
  state.status = "running";

  const brand = await getBrand();
  const preset = await resolvePreset(source);
  const imageGenEnabled = await isHiggsfieldConfigured();

  const systemPrompt = buildResizeSystemPrompt({
    brand,
    preset,
    carouselId: state.carouselId,
    sourceRatio: source.aspectRatio,
    targetRatio: state.ratio,
    baseUrl: localBase(),
    imageGenEnabled,
    internalToken: internalToken(),
  });

  // Las láminas del hermano son copias con IDs nuevos, en el mismo orden que el origen.
  const sibling = await getCarousel(state.carouselId);
  if (!sibling) throw new Error("El carrusel hermano desapareció antes de re-maquetar");
  const slides = [...sibling.slides].sort((a, b) => a.order - b.order);

  let sessionId: string | undefined;
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const message = buildAdaptSlideMessage({
      slideId: slide.id,
      index: i,
      total: slides.length,
      sourceRatio: source.aspectRatio,
      targetRatio: state.ratio,
      currentHtml: slide.html,
      notes: slide.notes,
    });

    const gen = await spawnClaude({
      message,
      systemPrompt,
      sessionId,
      cwd: process.cwd(),
      env: spawnEnv(),
    });
    if (gen.exitCode && gen.exitCode !== 0) {
      throw new Error(
        `Claude terminó con código ${gen.exitCode} en la lámina ${i + 1}. ${
          gen.stderr.slice(-300) || ""
        }`.trim()
      );
    }
    if (gen.sessionId) sessionId = gen.sessionId;
    state.completed = i + 1;
  }

  state.status = "done";
}

/**
 * Arranca la re-maquetación: crea los hermanos SINCRÓNICAMENTE (para devolver sus
 * IDs ya mismo) y dispara el re-flow con IA en background, un hermano a la vez para
 * no correr dos subprocesos Claude + Puppeteer en paralelo.
 */
export async function startResize(
  sourceId: string,
  ratios: AspectRatio[]
): Promise<ResizeJobState> {
  const source = await getCarousel(sourceId);
  if (!source) throw new Error("Carrusel no encontrado");
  if (source.slides.length === 0) throw new Error("El carrusel no tiene láminas para re-maquetar");

  const siblings: ResizeSiblingState[] = [];
  for (const ratio of ratios) {
    const created = await createResizedSibling(sourceId, ratio);
    if (!created) continue;
    siblings.push({
      ratio,
      carouselId: created.id,
      status: "pending",
      total: created.slides.length,
      completed: 0,
    });
  }

  const job: ResizeJobState = {
    sourceId,
    startedAt: new Date().toISOString(),
    siblings,
  };
  registry().jobs.set(sourceId, job);

  // Background: no lo esperamos. Cada hermano falla aislado (uno roto no tumba al otro).
  void (async () => {
    for (const state of siblings) {
      try {
        await adaptSibling(state, source);
      } catch (e) {
        state.status = "failed";
        state.error = (e as Error).message || "Error en la re-maquetación";
      }
    }
  })();

  return job;
}

/** Estado actual de la re-maquetación de un carrusel (para el polling de la UI). */
export function getResizeState(sourceId: string): ResizeJobState | null {
  return registry().jobs.get(sourceId) ?? null;
}
