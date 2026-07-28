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
import { ingestReference, buildGenerationMessage, buildContinuationMessage, IngestError } from "./thirtyx";
import { spawnClaudeWithCentralFallback } from "./generate-headless";
import { buildSystemPrompt } from "./chat-system-prompt";
import { getBrand } from "./brand";
import { getCarousel } from "./carousels";
import { getPreset, getPresetByAvatarSlug } from "./style-presets";
import { exportAllSlides } from "./export-slides";
import { warmupRenderer } from "./render";
import { isInstagramUrl } from "./instagram-url";
import { claimJob, completeJob, failJob, uploadCarousel } from "./prewave";
import { getInternalApiToken, isHostedMode } from "./hosted";
import { getPrewaveToken } from "./users";
import { isHiggsfieldConfigured } from "./higgsfield";
import { tokenForLabel, tokenLabel } from "./claude-tokens";
import { generacionCheckpoint, generacionPasada } from "./telemetry";
import {
  PRIORITY,
  PreemptedError,
  CancelledError,
  submit,
  isTracked,
  type JobControl,
} from "./job-queue";
import {
  getAssignment,
  setStatus,
  incrementAttempts,
  listReprocessable,
  saveCheckpoint,
  clearCheckpoint,
  type GenerationCheckpoint,
} from "./assignments";

/**
 * La concurrencia YA NO se decide acá.
 *
 * Antes este archivo tenía su propia cola (`queued[]` + `active` + `pump()`) con
 * DEFAULT_MAX_CONCURRENT = 4, y era el único de los tres caminos de generación que tenía
 * algún tope: /api/chat y el resize no tenían ninguno. Ahora los tres pasan por el carril
 * global de src/lib/job-queue.ts (QUEUE_LANE_SIZE, default 1), que además ordena por
 * prioridad y puede preemptar.
 */

/**
 * Tope duro de pasadas de generación por job. Cada pasada es un turno de Claude
 * (buildGenerationMessage la 1ra, buildContinuationMessage las siguientes). Existe
 * para que un agente que nunca completa no queme presupuesto en un loop infinito.
 */
const MAX_GENERATION_PASSES = 8;

/**
 * Cuántas pasadas SEGUIDAS sin agregar ni una lámina toleramos antes de dar por
 * trabada la generación. Una pasada puede cortarse a la mitad (timeout/kill → exit
 * 143) y aun así haber dejado láminas nuevas: en ese caso reanudamos. Solo si N
 * pasadas seguidas no producen NADA asumimos que no va a avanzar y cortamos.
 */
const MAX_STALLS = 3;

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
interface GenerationOutcome {
  /** Cuántas láminas terminó teniendo el carrusel. */
  produced: number;
  /** Texto del evento `result` del último turno del agente (su resumen/explicación). */
  lastResult: string;
  /** Cola del stderr del último subproceso Claude (errores de CLI: auth, budget, etc.). */
  lastStderr: string;
  /** Exit code del último subproceso: null = lo mató el timeout de 8 min (o una señal). */
  lastExitCode: number | null;
  /**
   * Se cortó por preempción, NO por un fallo. El que llama debe re-encolar el job en vez
   * de tratarlo como incompleto: el checkpoint ya está guardado.
   */
  preempted: boolean;
}

/** Lo que necesita `generateAllSlides` para poder ceder el carril y retomar después. */
interface GenerationContext {
  jobId: string;
  ctl: JobControl;
  /** Checkpoint previo, si este job ya había arrancado antes. */
  resume?: GenerationCheckpoint;
  /** Cuántas veces ya fue preemptado (se persiste en cada checkpoint). */
  preemptions: number;
}

/**
 * Comprime el diagnóstico del agente para adjuntarlo a un fallo de generación. Sin
 * esto, "no produjo láminas" no dice NADA de por qué — y en el server hosteado no
 * tenemos los logs a mano. Lo que el agente dijo al cerrar (401 del proxy interno,
 * límite de uso, python que no corre) casi siempre está en `result` o en el stderr;
 * si no dejó nada y salió con código nulo, casi seguro lo cortó el timeout de 8 min.
 */
function generationDiagnosis(o: Pick<GenerationOutcome, "lastResult" | "lastStderr" | "lastExitCode">): string {
  const result = o.lastResult.trim();
  const stderr = o.lastStderr.trim();
  const parts: string[] = [];
  if (result) parts.push(`El agente terminó diciendo: «${result.slice(-400)}»`);
  if (stderr) parts.push(`stderr: ${stderr.slice(-300)}`);
  if (!parts.length) {
    parts.push(
      o.lastExitCode === null
        ? "el agente no dejó mensaje y salió por señal — casi seguro lo cortó el timeout de 8 min (o el token del worker sin cupo)"
        : `el agente no dejó mensaje (exit=${o.lastExitCode})`
    );
  }
  return ` — ${parts.join(" · ")}`;
}

async function generateAllSlides(
  carouselId: string,
  referenceCount: number,
  systemPrompt: string,
  ctx: GenerationContext
): Promise<GenerationOutcome> {
  // Retomar desde el checkpoint: la sesión de Claude, la cuenta y los contadores.
  let sessionId = ctx.resume?.claudeSessionId;
  // Token central que viene usando ESTE carrusel (para --resume entre pasadas y
  // como preferencia del fallback). Cambia solo si una cuenta llega a su límite.
  let currentToken = ctx.resume?.claudeTokenLabel
    ? tokenForLabel(ctx.resume.claudeTokenLabel)
    : undefined;
  let stalls = ctx.resume?.stalls ?? 0;
  let passesDone = ctx.resume?.passesDone ?? 0;
  let lastResult = "";
  let lastStderr = "";
  let lastExitCode: number | null = null;
  const outcome = async (preempted = false): Promise<GenerationOutcome> => ({
    produced: (await getCarousel(carouselId))?.slides.length ?? 0,
    lastResult,
    lastStderr,
    lastExitCode,
    preempted,
  });

  /** Persiste el avance para que una preempción o un reinicio no cuesten empezar de cero. */
  const checkpoint = async () => {
    await saveCheckpoint(ctx.jobId, {
      carouselId,
      claudeSessionId: sessionId,
      claudeTokenLabel: currentToken ? tokenLabel(currentToken) : undefined,
      passesDone,
      stalls,
      preemptions: ctx.preemptions,
    });
    generacionCheckpoint(ctx.jobId, carouselId, passesDone, stalls, ctx.preemptions);
  };

  ctx.ctl.setPhase("generating");

  for (; passesDone < MAX_GENERATION_PASSES; passesDone++) {
    const before = (await getCarousel(carouselId))?.slides.length ?? 0;
    if (before >= referenceCount) return outcome();

    // Ceder ANTES de arrancar una pasada nueva es la salida más barata: no se pierde
    // ningún turno a medias.
    if (ctx.ctl.shouldYield()) {
      await checkpoint();
      return outcome(true);
    }

    const message =
      passesDone === 0
        ? buildGenerationMessage(referenceCount)
        : buildContinuationMessage(before, referenceCount);

    const gen = await spawnClaudeWithCentralFallback(
      {
        message,
        systemPrompt,
        sessionId,
        cwd: process.cwd(),
        // El carril aborta esta señal para preemptar: mata el subproceso Claude.
        signal: ctx.ctl.signal,
      },
      "runner",
      currentToken
    );
    // Guardá el diagnóstico del turno ANTES de decidir cortar/seguir.
    if (gen.resultText) lastResult = gen.resultText;
    if (gen.stderr) lastStderr = gen.stderr;
    lastExitCode = gen.exitCode;
    // Fijá la cuenta que efectivamente se usó (puede haber rotado por límite) para
    // que la próxima pasada reanude en la MISMA cuenta.
    if (gen.tokenUsed) currentToken = gen.tokenUsed;
    // La sesión permite reanudar la conversación en la próxima pasada.
    if (gen.sessionId) sessionId = gen.sessionId;

    // PREEMPCIÓN: cortamos nosotros. Las láminas que el agente ya escribió están en
    // disco y el sessionId permite retomar con --resume, así que se guarda y se sale.
    //
    // ⚠️ NO se toca `stalls` acá. Si una preempción contara como pasada trabada, tres
    // preempciones matarían el job con "la generación quedó incompleta" — el bug más
    // fácil de introducir en todo esto.
    if (gen.preempted) {
      await checkpoint();
      return outcome(true);
    }

    // Todas las cuentas de Claude al límite: reintentar NO ayuda (están rate-
    // limiteadas), así que este SÍ corta — con mensaje accionable.
    if (gen.exhaustedAll) {
      throw new Error(
        `Todas las cuentas de Claude llegaron a su límite de uso. Esperá a que resetee la ventana o agregá otra cuenta (CLAUDE_TEAM_OAUTH_TOKEN_2).${generationDiagnosis(
          { lastResult, lastStderr, lastExitCode }
        )}`.trim()
      );
    }

    const after = (await getCarousel(carouselId))?.slides.length ?? 0;
    // Una línea por pasada: con esto se ve si el agente avanza, se traba o lo cortan, sin
    // tener que inferirlo del resultado final.
    generacionPasada(ctx.jobId, passesDone, before, after, gen.exitCode, false);
    if (after >= referenceCount) {
      passesDone++;
      return outcome();
    }

    // IMPORTANTE: una pasada puede terminar con exit ≠ 0 (timeout/kill → 143, o un
    // error transitorio) y aun así haber dejado láminas nuevas. NO fallamos acá:
    // reanudamos con un mensaje de continuación (el agente lee lo ya hecho y sigue).
    // Solo si MAX_STALLS pasadas SEGUIDAS no agregan ni una lámina cortamos — así un
    // fallo duro (auth/budget/config) no gira en falso las 8 pasadas.
    if (after <= before) {
      stalls += 1;
      if (stalls >= MAX_STALLS) break;
    } else {
      stalls = 0;
    }
    // Guardar en cada pasada: si el proceso muere acá, se retoma sin perder contexto.
    await checkpoint();
  }

  return outcome();
}

/** Base loopback donde el curl de Claude escribe las láminas (mismo server local). */
function localBase(): string {
  return `http://127.0.0.1:${process.env.PORT || "3000"}`;
}

/**
 * Modo hosteado: los jobs de la cola no tienen usuaria logueada, así que el runner
 * usa las cuentas centrales de Claude (CLAUDE_TEAM_OAUTH_TOKEN[_N]). El token y la
 * carpeta de config aislada los inyecta `spawnClaudeWithCentralFallback`, que además
 * rota a otra cuenta si la primera llega a su límite. Sin ninguna cuenta central
 * configurada, el subproceso hereda la auth local del server (modo local de siempre).
 */

/** Token interno para que el subproceso pase el proxy de auth (modo hosteado). */
function runnerInternalToken(): string | undefined {
  return isHostedMode() ? getInternalApiToken() : undefined;
}

/**
 * El runner ya no lleva su propia cola: `queued`/`active`/`seen` se fueron al carril
 * (job-queue.ts), que es el único que sabe qué está corriendo y qué espera. Tener dos
 * registros del mismo hecho era una fuente garantizada de desincronización.
 */
interface Runner {
  enqueue: (jobId: string, opts?: { force?: boolean }) => void;
  reconcile: () => Promise<void>;
}

async function processAssignment(jobId: string, ctl: JobControl): Promise<void> {
  const a = await getAssignment(jobId);
  if (!a) return;
  // pending_review espera aprobación humana y archived lo sacó la diseñadora del
  // tablero — ninguno se reprocesa (procesarlos los devolvería al tablero solos).
  if (
    a.status === "done" ||
    a.status === "delivered" ||
    a.status === "pending_review" ||
    a.status === "archived"
  ) {
    return;
  }

  // Modo hosteado: este job se reclama/escribe con el token de SU diseñadora
  // (scope por persona), no con el global. En local: undefined → token global.
  const designerToken =
    isHostedMode() && a.designerId ? (await getPrewaveToken(a.designerId)) ?? undefined : undefined;

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

    // ¿Este job venía a medias? El checkpoint es la señal: si trae carouselId, ya se
    // reclamó y ya se ingirió, así que repetir esas dos etapas crearía un carrusel
    // duplicado y gastaría otra pasada por el proxy de Instagram.
    const resume = a.generation;

    // Precalienta el servicio de render en paralelo con la ingesta, así el cold start
    // (~5-10s con min-instances=0) no lo paga la primera lámina. Best-effort.
    void warmupRenderer();

    let carouselId: string;
    let referenceCount: number;
    let presetId: string;

    if (resume) {
      const existing = await getCarousel(resume.carouselId);
      if (!existing) {
        // El carrusel del checkpoint no está (borrado a mano): el checkpoint es basura.
        await clearCheckpoint(jobId);
        throw new Error(
          `El carrusel ${resume.carouselId} del checkpoint ya no existe. Reintentá el job para arrancar de cero.`
        );
      }
      carouselId = existing.id;
      referenceCount = existing.referenceImages.length;
      presetId = existing.stylePresetId ?? "";
    } else {
      // Reclama el job en Prewave (pending → processing) para que otro worker no lo
      // tome. Best-effort: si el PATCH falla (403 de ownership, red), seguimos con la
      // generación local igual — el claim es una optimización, no un bloqueo. Ver
      // docs/PLAN-MIGRACION-CARRUSELES.md §3/§6.5.
      await writeback(() => claimJob(jobId, designerToken));

      if (!isInstagramUrl(a.referenceUrl)) {
        throw new Error(`El referente no es una URL de Instagram válida: ${a.referenceUrl || "(vacío)"}`);
      }

      // 1. Ingesta: baja el referente y crea el carrusel con el ADN del avatar.
      //    NO es preemptible: dura ~60s y cortarla dejaría un carrusel a medio crear.
      ctl.setPhase("ingesting");
      await setStatus(jobId, "ingesting");
      const ingested = await ingestReference({
        referenceUrl: a.referenceUrl,
        avatarSlug: a.avatarSlug,
        name: a.avatarName ? `${a.avatarName} — job ${jobId.slice(0, 8)}` : undefined,
        prewaveJobId: jobId,
        source: "queue",
      });
      carouselId = ingested.carousel.id;
      referenceCount = ingested.referenceCount;
      presetId = ingested.preset.id;
      // Checkpoint en cuanto existe el carrusel: desde acá, retomar no repite la ingesta.
      await saveCheckpoint(jobId, { carouselId });
    }

    await setStatus(jobId, "generating", { carouselId });

    // 2. Generación headless: mismo subproceso Claude que el chat, sin navegador.
    //    Se generan TODAS las láminas — el loop reanuda a Claude si corta antes de
    //    completar el conteo del referente, para que el QA nunca vea un carrusel a medias.
    const brand = await getBrand();
    const freshCarousel = await getCarousel(carouselId);
    const stylePreset = presetId ? await getPreset(presetId) : undefined;
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

    const gen = await generateAllSlides(carouselId, referenceCount, systemPrompt, {
      jobId,
      ctl,
      resume,
      preemptions: (resume?.preemptions ?? 0) + (ctl.shouldYield() ? 1 : 0),
    });

    // PREEMPTADO: no es un fallo ni una generación incompleta. El checkpoint ya quedó
    // guardado, así que se marca `preempted` y se re-encola para retomar donde iba.
    // Sin este early-return, el chequeo de "quedó incompleta" de abajo marcaría failed
    // un job perfectamente sano que solo cedió su turno.
    if (gen.preempted) {
      await saveCheckpoint(jobId, {
        carouselId,
        preemptions: (resume?.preemptions ?? 0) + 1,
      });
      await setStatus(jobId, "preempted");
      throw new PreemptedError(jobId);
    }

    // 3. Render a PNG (verifica que la generación produjo TODAS las láminas).
    ctl.setPhase("rendering");
    await setStatus(jobId, "rendering");
    const finalCarousel = await getCarousel(carouselId);
    if (!finalCarousel || finalCarousel.slides.length === 0) {
      throw new Error(`La generación no produjo láminas.${generationDiagnosis(gen)}`);
    }
    if (gen.produced < referenceCount) {
      throw new Error(
        `La generación quedó incompleta: ${gen.produced} de ${referenceCount} láminas. Reintentá el job.${generationDiagnosis(gen)}`
      );
    }
    const files = await exportAllSlides(
      finalCarousel.slides,
      finalCarousel.aspectRatio,
      undefined,
      { signal: ctl.signal }
    );
    const outDir = path.resolve(process.cwd(), "public", "exports", carouselId);
    await mkdir(outDir, { recursive: true });
    for (const f of files) {
      await writeFile(path.join(outDir, f.name), f.buffer);
    }

    // 4. Listo para QA + writeback a Prewave (→ done). El estado local es la fuente
    //    de verdad de la UI; el writeback es best-effort para no perder el resultado
    //    si Prewave está caído.
    //    El checkpoint se borra: el job terminó y no hay nada que retomar.
    await clearCheckpoint(jobId);
    const resultPath = `/exports/${carouselId}/`;
    if (isHostedMode()) {
      // Híbrido: el borrador queda EN REVISIÓN. La diseñadora lo aprueba desde su
      // bandeja y ahí recién se hace el writeback a Prewave con SU token
      // (POST /api/thirtyx/assignments/[jobId]/approve). NO se toca Prewave acá.
      await setStatus(jobId, "pending_review", { resultUrl: resultPath });
    } else {
      // Modo local: writeback automático al terminar (comportamiento de siempre).
      // uploadCarousel sube los PNG al endpoint de worker (GCS + siembra el brief) y
      // cierra el job; si no está (404) o el job no tiene brief (422), cae a completeJob.
      await setStatus(jobId, "done", { resultUrl: resultPath });
      const editorUrl = `http://localhost:${process.env.PORT || "3000"}/carousel/${carouselId}`;
      await writeback(async () => {
        try {
          await uploadCarousel(jobId, files);
        } catch {
          await completeJob(jobId, editorUrl);
        }
      });
    }
  } catch (e) {
    // Preempción: NO es un fallo. Ya se guardó el checkpoint y ya quedó en `preempted`;
    // se propaga para que el carril lo re-encole y retome donde iba.
    if (e instanceof PreemptedError) throw e;

    // Cancelación a mano: tampoco es un fallo de generación. Queda `failed` con un
    // mensaje honesto (que alguien lo canceló), no con un diagnóstico inventado.
    if (e instanceof CancelledError) {
      await setStatus(jobId, "failed", { error: "Cancelado a mano desde la cola." });
      return;
    }

    // Un fallo de la etapa "preset" (avatar sin ADN local o no listo) NO es un fallo
    // real de generación: es la MISMA condición que atrapa el preflight, solo que
    // apareció tarde por una carrera transitoria — import-avatars reescribió
    // style-presets.json entre el preflight y la ingesta (import/rename), o una lectura
    // ESTALE/-116 del volumen GCS FUSE hizo que readDataSafe devolviera presets vacíos.
    // Tratalo como el preflight: dejalo `blocked` (retriable, se auto-recupera en el
    // próximo sync cuando el preset esté) y NO lo marques failed ni lo escribas en
    // Prewave, para no ensuciar el board ni forzar un "Reintentar" a mano.
    if (e instanceof IngestError && e.stage === "preset") {
      await setStatus(jobId, "blocked", { error: (e as Error).message });
      return;
    }
    const msg = (e as Error).message || "Error desconocido en la generación";
    await setStatus(jobId, "failed", { error: msg });
    await writeback(() => failJob(jobId, msg, designerToken));
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

/**
 * Cuántas veces se re-encola un job preemptado antes de rendirse.
 *
 * El carril ya limita las preempciones por job (MAX_PREEMPTIONS), así que esto es solo un
 * cinturón de seguridad contra un bucle de re-encolado si algo sale mal en la coordinación.
 */
const MAX_REQUEUES = 8;

/**
 * Corre un job en el carril, re-encolándolo si lo preemptan.
 *
 * Este loop es la traducción de "preempción" a algo útil: cuando el carril le quita el
 * turno, `processAssignment` ya dejó el checkpoint guardado, así que volver a encolarlo
 * hace que retome donde iba (misma sesión de Claude, mismas láminas) en cuanto haya lugar.
 */
async function runWithRequeue(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_REQUEUES; attempt++) {
    const a = await getAssignment(jobId);
    if (!a) return;

    try {
      await setStatus(jobId, "queued");
      await submit((ctl) => processAssignment(jobId, ctl), {
        id: jobId,
        priority: a.priority ?? PRIORITY.NORMAL,
        label: a.avatarName ? `${a.avatarName} (cola)` : `job ${jobId.slice(0, 8)}`,
        preemptions: a.generation?.preemptions ?? 0,
      });
      return;
    } catch (e) {
      // Preemptado: volver a la fila y retomar desde el checkpoint.
      if (e instanceof PreemptedError) continue;
      // Cancelado a mano: processAssignment ya dejó el estado; no re-encolar.
      if (e instanceof CancelledError) return;
      // Duplicado (ya estaba en la cola) o error inesperado del carril: no reintentar.
      return;
    }
  }
  await setStatus(jobId, "failed", {
    error: `El job cedió su turno ${MAX_REQUEUES} veces sin poder terminar. Subile la prioridad para que corra sin interrupciones.`,
  });
}

function createRunner(): Runner {
  const runner: Runner = {
    enqueue(jobId, opts) {
      // El carril es ahora el dueño del "¿ya está encolado?": preguntarle a él evita que
      // este runner y el carril tengan dos ideas distintas de qué está en vuelo.
      if (!opts?.force && isTracked(jobId)) return;
      void runWithRequeue(jobId);
    },
    async reconcile() {
      const pending = await listReprocessable();
      for (const a of pending) runner.enqueue(a.jobId);
    },
  };

  return runner;
}

const g = globalThis as unknown as { __thirtyxRunner?: Runner };

/** Devuelve el runner singleton (uno por proceso). */
export function getRunner(): Runner {
  if (!g.__thirtyxRunner) g.__thirtyxRunner = createRunner();
  return g.__thirtyxRunner;
}
