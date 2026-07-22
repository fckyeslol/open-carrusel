"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/thirtyx/SectionLabel";
import { cn } from "@/lib/utils";

/** Asignación tal como la expone POST /api/thirtyx/sync. */
interface Assignment {
  jobId: string;
  avatarSlug: string;
  avatarName: string | null;
  referenceUrl: string;
  status: string;
  carouselId: string | null;
  resultUrl: string | null;
  error: string | null;
  receivedAt: string;
  updatedAt: string;
}

type Tone = "muted" | "active" | "ready" | "done" | "error" | "warn";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  needs_reference: { label: "Sin referente", tone: "warn" },
  received: { label: "En cola", tone: "muted" },
  ingesting: { label: "Bajando referente", tone: "active" },
  generating: { label: "Generando", tone: "active" },
  rendering: { label: "Renderizando", tone: "active" },
  done: { label: "Listo para QA", tone: "ready" },
  delivered: { label: "Entregado", tone: "done" },
  failed: { label: "Falló", tone: "error" },
};

const TONE_CLASS: Record<Tone, string> = {
  muted: "border-border text-muted-foreground",
  active: "border-accent/40 text-accent-strong",
  ready: "border-amber-500/40 text-amber-600",
  done: "border-emerald-500/40 text-emerald-600",
  error: "border-destructive/40 text-destructive",
  warn: "border-sky-500/40 text-sky-600",
};

/** Cada cuánto le pregunta a Prewave por trabajos nuevos (pull con tu usuario). */
const POLL_MS = 8000;

/** "30X — Andrés Bilbao" → "Andrés Bilbao": el prefijo se repite en todos. */
function shortAvatarName(name: string): string {
  return name.replace(/^30X\s*[—–-]\s*/i, "").trim() || name;
}

function isActive(status: string): boolean {
  return STATUS[status]?.tone === "active";
}

/** Agrupa por avenger, preservando el orden por más reciente dentro de cada grupo. */
function groupByAvenger(items: Assignment[]): { key: string; label: string; items: Assignment[] }[] {
  const map = new Map<string, { key: string; label: string; items: Assignment[] }>();
  for (const a of items) {
    const key = a.avatarSlug || "sin-avatar";
    const label = a.avatarName ? shortAvatarName(a.avatarName) : a.avatarSlug || "Sin avatar";
    if (!map.has(key)) map.set(key, { key, label, items: [] });
    map.get(key)!.items.push(a);
  }
  return [...map.values()];
}

function StatusBadge({ status }: { status: string }) {
  const info = STATUS[status] ?? { label: status, tone: "muted" as Tone };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        TONE_CLASS[info.tone]
      )}
    >
      {info.tone === "active" && (
        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {info.label}
    </span>
  );
}

/**
 * Campo para pegar un referente de IG a mano en jobs `needs_reference` (producción
 * manual de Prewave, que llega sin URL). Al enviar, encola el job para generación.
 */
function NeedsReferenceForm({ onSubmit }: { onSubmit: (url: string) => Promise<string | null> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !url.trim()) return;
    setBusy(true);
    setErr(null);
    const error = await onSubmit(url.trim());
    if (error) {
      setErr(error);
      setBusy(false);
    }
    // en éxito, el sync repinta la tarjeta y este form se desmonta
  };

  return (
    <div className="mt-3">
      <p className="mb-2 text-xs text-muted-foreground">
        Producción propia sin referente. Pegá un post o reel de Instagram para generarlo.
      </p>
      <div className="flex gap-2">
        <input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="instagram.com/p/…"
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-accent/60 disabled:opacity-60"
        />
        <Button size="sm" variant="outline" onClick={submit} disabled={busy || !url.trim()}>
          {busy ? "Encolando…" : "Generar"}
        </Button>
      </div>
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
    </div>
  );
}

export function AssignmentQueue() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const busyRef = useRef<Set<string>>(new Set());

  // PULL: pregunta a Prewave por trabajos nuevos, encola los nuevos y trae el estado.
  const sync = useCallback(async () => {
    try {
      const res = await fetch("/api/thirtyx/sync", { method: "POST" });
      const data = await res.json();
      if (res.status === 401) {
        setNotConfigured(true);
        setAssignments(data.assignments || []);
        return;
      }
      setNotConfigured(false);
      if (!res.ok) {
        setError(data.error || "No se pudo sincronizar con Prewave");
        if (data.assignments) setAssignments(data.assignments);
        return;
      }
      setError(null);
      setAssignments(data.assignments || []);
    } catch {
      setError("Error de red al sincronizar");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    sync();
    const id = setInterval(sync, POLL_MS);
    return () => clearInterval(id);
  }, [sync]);

  const retry = useCallback(
    async (jobId: string) => {
      if (busyRef.current.has(jobId)) return;
      busyRef.current.add(jobId);
      try {
        await fetch(`/api/thirtyx/assignments/${jobId}/retry`, { method: "POST" });
        await sync();
      } finally {
        busyRef.current.delete(jobId);
      }
    },
    [sync]
  );

  // Asigna un referente a mano a un job `needs_reference` y lo encola.
  // Devuelve un mensaje de error para que el form lo muestre, o null si salió bien.
  const submitReference = useCallback(
    async (jobId: string, referenceUrl: string): Promise<string | null> => {
      try {
        const res = await fetch(`/api/thirtyx/assignments/${jobId}/reference`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ referenceUrl }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return data.error || "No se pudo asignar el referente";
        await sync();
        return null;
      } catch {
        return "Error de red al asignar el referente";
      }
    },
    [sync]
  );

  const activeCount = assignments.filter((a) => isActive(a.status)).length;
  const groups = groupByAvenger(assignments);

  return (
    <section className="mt-12">
      <SectionLabel
        index="02"
        aside={
          assignments.length > 0
            ? activeCount > 0
              ? `${activeCount} generando · ${assignments.length} total`
              : `${assignments.length} en total`
            : undefined
        }
      >
        Tus carruseles (Prewave)
      </SectionLabel>

      {error && (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {notConfigured ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Conectá tu token de Prewave (botón <strong>Conectar Prewave</strong> arriba) para que
            traigamos tus trabajos asignados y se generen solos.
          </p>
        </div>
      ) : loaded && assignments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No hay trabajos asignados todavía. Cuando Prewave te asigne carruseles aparecen acá y
            se generan solos — no hay que actualizar nada.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="mb-2 flex items-baseline justify-between border-b border-foreground/10 pb-1.5">
                <h3 className="text-sm font-semibold tracking-tight">{group.label}</h3>
                <span className="text-[11px] text-muted-foreground">
                  {group.items.length} {group.items.length === 1 ? "carrusel" : "carruseles"}
                </span>
              </div>

              <ul className="grid gap-3 sm:grid-cols-2">
                {group.items.map((a) => (
                  <li
                    key={a.jobId}
                    className={cn(
                      "rounded-xl border bg-surface p-4 transition-colors",
                      isActive(a.status) ? "border-accent/40" : "border-border"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      {a.referenceUrl ? (
                        <a
                          href={a.referenceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-accent-strong hover:underline"
                        >
                          {a.referenceUrl.replace(/^https?:\/\/(www\.)?/, "")}
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-[11px] italic text-muted-foreground">
                          Producción propia
                        </span>
                      )}
                      <StatusBadge status={a.status} />
                    </div>

                    {a.status === "needs_reference" && (
                      <NeedsReferenceForm
                        onSubmit={(url) => submitReference(a.jobId, url)}
                      />
                    )}

                    {a.status === "failed" && (
                      <div className="mt-3">
                        {a.error && (
                          <p className="mb-2 line-clamp-3 text-xs text-destructive">{a.error}</p>
                        )}
                        <Button size="sm" variant="outline" onClick={() => retry(a.jobId)}>
                          Reintentar
                        </Button>
                      </div>
                    )}

                    {(a.status === "done" || a.status === "delivered") && a.carouselId && (
                      <div className="mt-3 flex items-center gap-3">
                        <Link
                          href={`/carousel/${a.carouselId}`}
                          className="text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
                        >
                          Abrir para QA →
                        </Link>
                        <span className="ml-auto text-[11px] text-muted-foreground">
                          Entregá desde Prewave
                        </span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
