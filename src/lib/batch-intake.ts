/**
 * De un CSV subido a un lote listo para correr de noche.
 *
 * Es el pegamento entre el parser (`csv-batch.ts`, que no sabe nada de la app) y los
 * stores: resuelve cada fila contra los avatares instalados y las diseñadoras
 * registradas, y deja creadas las asignaciones que el runner va a generar.
 *
 * La política de errores es la del lote entero, y está concentrada acá:
 *
 *  - fila sin URL válida, sin avenger, o repetida  → se descarta con motivo
 *  - avenger que no matchea ningún avatar local    → se descarta con motivo
 *  - diseñadora que no matchea ninguna usuaria     → SE GENERA IGUAL, sin dueña
 *
 * La asimetría es deliberada. Sin avatar no hay ADN con qué generar: la fila es
 * imposible. Sin diseñadora la fila es perfectamente generable — solo queda sin
 * asignar — y perder un carrusel por un nombre mal escrito sería peor que el problema
 * que resuelve.
 */
import {
  parseBatchCsv,
  resolveAvenger,
  resolveDesigner,
  stripAvatarPrefix,
  type AvatarCandidate,
  type DesignerCandidate,
} from "./csv-batch";
import { listAvatarPresets } from "./style-presets";
import { listUsers } from "./users";
import { createCsvAssignments } from "./assignments";
import { createBatch, type Batch, type BatchSkip } from "./batches";
import { nextNightWindow } from "./batch-scheduler";
import { generateId } from "./utils";

/** Una fila lista para generarse, ya resuelta. */
export interface ResolvedRow {
  line: number;
  referenceUrl: string;
  avatarSlug: string;
  avatarName: string;
  /** Texto crudo de la diseñadora, para mostrarlo aunque no se haya podido resolver. */
  designerRaw: string;
  designerId: string | null;
  designerName: string | null;
  higgsfield: boolean;
}

export interface BatchPreview {
  rows: ResolvedRow[];
  skipped: BatchSkip[];
  /** Filas que se generan pero quedaron sin dueña (nombre no reconocido). */
  unassigned: number;
  /** Cuántas usan Higgsfield. Se muestra porque tiene costo por imagen. */
  withHiggsfield: number;
  /** El archivo no traía encabezado y se asumió el orden de columnas. */
  assumedOrder: boolean;
  /** Columnas obligatorias que no se encontraron en el encabezado. */
  missingColumns: string[];
}

/** Avatares utilizables: solo los `ready` pueden generar. */
async function loadAvatars(): Promise<AvatarCandidate[]> {
  const presets = await listAvatarPresets();
  return presets
    .filter((p) => Boolean(p.avatarSlug))
    .map((p) => ({
      slug: p.avatarSlug!,
      name: p.name,
      ready: !p.avatarStatus || p.avatarStatus === "ready",
    }));
}

async function loadDesigners(): Promise<DesignerCandidate[]> {
  return (await listUsers()).map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
  }));
}

/**
 * Parsea y resuelve el CSV SIN escribir nada. Es lo que alimenta la vista previa: la
 * diseñadora ve exactamente qué se va a generar y qué se descartó antes de confirmar.
 */
export async function previewCsv(text: string): Promise<BatchPreview> {
  const parsed = parseBatchCsv(text);
  const avatars = await loadAvatars();
  const designers = await loadDesigners();

  const rows: ResolvedRow[] = [];
  const skipped: BatchSkip[] = parsed.invalid.map((i) => ({
    line: i.line,
    raw: i.raw,
    reason: i.reason,
  }));

  for (const row of parsed.rows) {
    const avatar = resolveAvenger(row.avengerRaw, avatars);
    if (!avatar) {
      skipped.push({
        line: row.line,
        raw: row.referenceUrl,
        reason: `No hay un avatar instalado que se llame "${row.avengerRaw}".`,
      });
      continue;
    }
    if (!avatar.ready) {
      skipped.push({
        line: row.line,
        raw: row.referenceUrl,
        reason: `El avatar "${stripAvatarPrefix(avatar.name)}" no está listo (le falta el ADN o sus formatos).`,
      });
      continue;
    }

    // Diseñadora no reconocida NO descarta la fila: se genera sin dueña.
    const designer = resolveDesigner(row.designerRaw, designers);

    rows.push({
      line: row.line,
      referenceUrl: row.referenceUrl,
      avatarSlug: avatar.slug,
      avatarName: stripAvatarPrefix(avatar.name),
      designerRaw: row.designerRaw,
      designerId: designer?.id ?? null,
      designerName: designer?.displayName ?? null,
      higgsfield: row.higgsfield,
    });
  }

  return {
    rows,
    skipped: skipped.sort((a, b) => a.line - b.line),
    unassigned: rows.filter((r) => !r.designerId).length,
    withHiggsfield: rows.filter((r) => r.higgsfield).length,
    assumedOrder: parsed.assumedOrder,
    missingColumns: parsed.missingColumns,
  };
}

export interface IntakeOptions {
  filename: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
  /** Correr apenas se sube en vez de esperar la ventana nocturna. */
  runNow?: boolean;
}

export interface IntakeResult {
  batch: Batch;
  preview: BatchPreview;
}

/**
 * Crea el lote y sus asignaciones. Devuelve el lote ya programado.
 *
 * Las asignaciones se crean ANTES de que exista la hora de arranque para que un
 * reinicio entre la subida y la noche no pierda nada: quedan en disco en `queued`, y
 * tanto el reconcile del arranque como el scheduler las encuentran.
 */
export async function intakeCsv(text: string, opts: IntakeOptions): Promise<IntakeResult> {
  const preview = await previewCsv(text);

  // `runNow` programa en el pasado inmediato: el mismo camino que la ventana nocturna,
  // sin una segunda vía de despacho que pueda divergir de la del scheduler.
  const scheduledFor = opts.runNow ? new Date() : nextNightWindow();

  const batch = await createBatch({
    filename: opts.filename,
    uploadedBy: opts.uploadedBy,
    uploadedByName: opts.uploadedByName,
    scheduledFor: scheduledFor.toISOString(),
    rowCount: preview.rows.length,
    skipped: preview.skipped,
  });

  // UNA escritura para todo el lote, no una por fila: el store hosteado vive en un
  // bucket GCS que limita las mutaciones por objeto (ver createCsvAssignments).
  await createCsvAssignments(
    preview.rows.map((row) => ({
      jobId: `csv-${batch.id.slice(0, 8)}-${generateId().slice(0, 8)}`,
      batchId: batch.id,
      avatarSlug: row.avatarSlug,
      avatarName: row.avatarName,
      referenceUrl: row.referenceUrl,
      // Sin diseñadora reconocida, la dueña es QUIEN SUBIÓ el CSV.
      //
      // No es cosmético: en modo hosteado el tablero filtra por `designerId`, así que
      // dejarlo en null generaría el carrusel y lo haría invisible para todas — el peor
      // de los dos mundos (se gastó la generación y nadie la encuentra). Atribuirlo a la
      // que subió el archivo mantiene el scope intacto y garantiza que el trabajo tenga
      // siempre a alguien que lo vea. El nombre no reconocido igual se reporta en la
      // vista previa para que puedan corregir el typo.
      designerId: row.designerId ?? opts.uploadedBy,
      higgsfield: row.higgsfield,
    }))
  );

  return { batch, preview };
}
