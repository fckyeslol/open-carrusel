"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/thirtyx/SectionLabel";
import { cn } from "@/lib/utils";

/** Fila resuelta tal como la devuelve POST /api/thirtyx/batches?preview=1. */
interface ResolvedRow {
  line: number;
  referenceUrl: string;
  avatarSlug: string;
  avatarName: string;
  designerRaw: string;
  designerId: string | null;
  designerName: string | null;
  higgsfield: boolean;
}

interface Skip {
  line: number;
  raw: string;
  reason: string;
}

interface Preview {
  rows: ResolvedRow[];
  skipped: Skip[];
  unassigned: number;
  withHiggsfield: number;
  assumedOrder: boolean;
  missingColumns: string[];
}

/** Cuántas filas se listan antes de resumir el resto. */
const PREVIEW_LIMIT = 8;

const PLANTILLA = "URL,Avenger,Diseñadora,Higgsfield\n";

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/$/, "");
}

export interface BatchUploadProps {
  /** Se llama al crear un lote, para que la lista de abajo se refresque. */
  onCreated?: () => void;
}

/**
 * Carga del CSV del lote nocturno (URL · Avenger · Diseñadora · Higgsfield).
 *
 * Son dos pasos a propósito: primero VISTA PREVIA (no escribe nada) y recién después
 * confirmar. El archivo lo arma alguien en Excel y se genera de madrugada sin nadie
 * mirando; ver acá que "Avenger" quedó mal escrito cuesta 10 segundos, descubrirlo a la
 * mañana siguiente cuesta la noche entera.
 */
export function BatchUpload({ onCreated }: BatchUploadProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [filename, setFilename] = useState("lote.csv");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showAllSkips, setShowAllSkips] = useState(false);

  const reset = useCallback(() => {
    setCsv(null);
    setPreview(null);
    setError(null);
    setOk(null);
    setShowAllSkips(false);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  /** Sube el texto a la vista previa. No escribe nada en el server. */
  const loadPreview = useCallback(async (text: string, name: string) => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch("/api/thirtyx/batches?preview=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, filename: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo leer el archivo");
      setCsv(text);
      setFilename(name);
      setPreview(data.preview);
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      if (!/\.csv$|\.txt$/i.test(file.name)) {
        setError("Subí un archivo .csv (exportalo desde Excel o Google Sheets).");
        return;
      }
      await loadPreview(await file.text(), file.name);
    },
    [loadPreview]
  );

  /** Confirma: crea el lote y lo programa (o lo corre ya). */
  const confirm = useCallback(
    async (runNow: boolean) => {
      if (!csv) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/thirtyx/batches${runNow ? "?run=now" : ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv, filename }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "No se pudo programar el lote");
        const cuando = runNow
          ? "Arrancando ahora."
          : `Programado para ${new Date(data.batch.scheduledFor).toLocaleString("es", {
              weekday: "long",
              hour: "2-digit",
              minute: "2-digit",
            })}.`;
        setOk(`${data.preview.rows.length} carruseles en cola. ${cuando}`);
        setCsv(null);
        setPreview(null);
        if (fileRef.current) fileRef.current.value = "";
        onCreated?.();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [csv, filename, onCreated]
  );

  const visibleSkips = preview
    ? showAllSkips
      ? preview.skipped
      : preview.skipped.slice(0, PREVIEW_LIMIT)
    : [];

  return (
    <section className="mt-10">
      <SectionLabel index="02" aside="se genera de noche">
        Lote por CSV
      </SectionLabel>

      <div className="rounded-xl border border-border bg-surface p-6 sm:p-7">
        <p className="max-w-[58ch] text-sm leading-relaxed text-muted-foreground">
          Subí un CSV con las columnas{" "}
          <code className="rounded bg-foreground/5 px-1 py-0.5 text-[12px]">URL</code>,{" "}
          <code className="rounded bg-foreground/5 px-1 py-0.5 text-[12px]">Avenger</code>,{" "}
          <code className="rounded bg-foreground/5 px-1 py-0.5 text-[12px]">Diseñadora</code> y{" "}
          <code className="rounded bg-foreground/5 px-1 py-0.5 text-[12px]">Higgsfield</code> (Sí/No).
          Se generan solos, uno por uno, sin preguntar nada. Si una URL falla, sigue con la
          siguiente.
        </p>

        {/* ── Zona de carga ────────────────────────────────────────────── */}
        {!preview && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            className={cn(
              "mt-5 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
              dragging ? "border-accent bg-accent/5" : "border-border"
            )}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              id="batch-csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <p className="text-sm text-muted-foreground">
              Arrastrá el CSV acá, o
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? "Leyendo…" : "Elegir archivo"}
            </Button>
            <p className="mt-4 text-xs text-muted-foreground">
              <a
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(PLANTILLA)}`}
                download="plantilla-lote.csv"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Descargar plantilla
              </a>
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {ok && (
          <p className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700">
            {ok}
          </p>
        )}

        {/* ── Vista previa ─────────────────────────────────────────────── */}
        {preview && (
          <div className="mt-6">
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-border pb-3">
              <span className="text-2xl font-bold tabular-nums leading-none">
                {preview.rows.length}
              </span>
              <span className="text-sm text-muted-foreground">
                {preview.rows.length === 1 ? "carrusel a generar" : "carruseles a generar"}
              </span>
              {preview.withHiggsfield > 0 && (
                <span className="text-xs text-muted-foreground">
                  · {preview.withHiggsfield} con Higgsfield
                </span>
              )}
              {preview.skipped.length > 0 && (
                <span className="text-xs text-amber-600">
                  · {preview.skipped.length} descartadas
                </span>
              )}
              {preview.unassigned > 0 && (
                <span className="text-xs text-amber-600">
                  · {preview.unassigned} con diseñadora no reconocida
                </span>
              )}
            </div>

            {preview.assumedOrder && (
              <p className="mt-3 text-xs text-amber-600">
                El archivo no tenía encabezado: se asumió el orden URL, Avenger, Diseñadora,
                Higgsfield.
              </p>
            )}
            {preview.missingColumns.length > 0 && (
              <p className="mt-3 text-xs text-amber-600">
                No se encontró la columna {preview.missingColumns.join(" ni ")} en el
                encabezado.
              </p>
            )}
            {preview.unassigned > 0 && (
              <p className="mt-3 text-xs text-amber-600">
                {preview.unassigned}{" "}
                {preview.unassigned === 1 ? "fila tiene" : "filas tienen"} una diseñadora
                que no está registrada: {preview.unassigned === 1 ? "se genera" : "se generan"}{" "}
                igual y {preview.unassigned === 1 ? "queda" : "quedan"} a tu nombre. Corregí
                el nombre en el CSV si querés reasignar{preview.unassigned === 1 ? "la" : "las"}.
              </p>
            )}

            {/* Filas que se van a generar */}
            {preview.rows.length > 0 && (
              <ul className="mt-4 divide-y divide-border/60">
                {preview.rows.slice(0, PREVIEW_LIMIT).map((row) => (
                  <li key={row.line} className="flex items-baseline gap-3 py-2 text-sm">
                    <span className="w-8 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {row.line}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {shortUrl(row.referenceUrl)}
                    </span>
                    <span className="shrink-0 font-medium">{row.avatarName}</span>
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        row.designerId ? "text-muted-foreground" : "text-amber-600"
                      )}
                    >
                      {row.designerName ?? (row.designerRaw ? `${row.designerRaw}?` : "sin asignar")}
                    </span>
                    <span
                      className={cn(
                        "w-6 shrink-0 text-right text-xs font-medium",
                        row.higgsfield ? "text-accent-strong" : "text-muted-foreground/50"
                      )}
                      title={row.higgsfield ? "Usa Higgsfield" : "Sin Higgsfield"}
                    >
                      {row.higgsfield ? "IA" : "—"}
                    </span>
                  </li>
                ))}
                {preview.rows.length > PREVIEW_LIMIT && (
                  <li className="py-2 text-xs text-muted-foreground">
                    y {preview.rows.length - PREVIEW_LIMIT} más…
                  </li>
                )}
              </ul>
            )}

            {/* Filas descartadas, con el motivo */}
            {preview.skipped.length > 0 && (
              <div className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">
                  No se van a generar
                </p>
                <ul className="mt-2 space-y-1.5">
                  {visibleSkips.map((s) => (
                    <li key={`${s.line}-${s.reason}`} className="text-xs text-amber-800">
                      <span className="font-mono tabular-nums">línea {s.line}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
                {preview.skipped.length > PREVIEW_LIMIT && (
                  <button
                    type="button"
                    onClick={() => setShowAllSkips((v) => !v)}
                    className="mt-2 cursor-pointer text-xs underline underline-offset-2 hover:text-amber-900"
                  >
                    {showAllSkips
                      ? "Ver menos"
                      : `Ver las ${preview.skipped.length - PREVIEW_LIMIT} restantes`}
                  </button>
                )}
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button onClick={() => confirm(false)} disabled={busy || preview.rows.length === 0}>
                {busy ? "Programando…" : "Programar para esta noche"}
              </Button>
              <Button
                variant="outline"
                onClick={() => confirm(true)}
                disabled={busy || preview.rows.length === 0}
              >
                Correr ahora
              </Button>
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
