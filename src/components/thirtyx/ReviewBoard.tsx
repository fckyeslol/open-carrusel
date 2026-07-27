"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
import { GeneratingCard } from "@/components/thirtyx/GeneratingCard";
import { cn } from "@/lib/utils";

interface Assignment {
  jobId: string;
  avatarSlug: string;
  avatarName: string | null;
  referenceUrl: string;
  status: string;
  carouselId: string | null;
  error: string | null;
  updatedAt: string;
}

/** Cadencia del poll rápido (lectura local — pinta el board). */
const POLL_OK_MS = 8000;
/** Techo del backoff cuando el server responde con error (p. ej. 429). */
const POLL_MAX_MS = 60000;
/** Cadencia del pull pesado de Prewave (encola briefs nuevos), en background. */
const SYNC_MS = 30000;

/**
 * Estados en curso: generándose O esperando su turno en el carril.
 *
 * `queued` y `preempted` son nuevos y tienen que estar acá: con un solo carril global la
 * mayoría de los pedidos está esperando, y si no aparecieran en el board se verían como
 * desaparecidos. La card distingue visualmente "esperando" de "trabajando".
 */
const GENERATING = [
  "received",
  "queued",
  "claiming",
  "ingesting",
  "generating",
  "rendering",
  "preempted",
];

interface QueueItem {
  id: string;
  state: "active" | "queued";
  position: number | null;
  priority: number;
}

/**
 * Espejo de PRIORITY.URGENT de src/lib/job-queue.ts. Se duplica el número porque este es
 * un componente cliente y job-queue.ts es código de servidor (toca process.env y guarda
 * estado en globalThis); importarlo lo arrastraría al bundle.
 */
const PRIORITY_URGENT = 10;

function shortAvatar(name: string | null, slug: string): string {
  return (name || slug || "Sin avatar").replace(/^30X\s*[—–-]\s*/i, "").trim();
}

function refHost(url: string): string {
  return (url || "").replace(/^https?:\/\/(www\.)?/, "").slice(0, 40);
}

export function ReviewBoard() {
  const router = useRouter();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [displayName, setDisplayName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const busyRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((b) => setDisplayName(b?.user?.displayName || ""))
      .catch(() => {});
  }, []);

  // Estado del carril: quién está corriendo y en qué puesto espera el resto. Va junto al
  // poll rápido porque es lo que convierte "En cola" en "En cola — puesto 2".
  const loadQueue = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/queue");
      if (!res.ok) return;
      const data: { items?: QueueItem[] } = await res.json();
      setQueue(data.items || []);
    } catch {
      // Sin el carril las cards siguen mostrando su etapa; solo se pierde el puesto.
    }
  }, []);

  // Lectura RÁPIDA: solo la base local (GET /mine), sin tocar Prewave. Gatea el
  // primer render y refresca el estado en vivo. Devuelve true si respondió OK.
  const loadMine = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/thirtyx/mine");
      // El 429 de Cloud Run ("no available instance") no es JSON: parseá con red.
      let data: { error?: string; assignments?: Assignment[] } = {};
      try {
        data = await res.json();
      } catch {
        /* cuerpo no-JSON (p. ej. página de error del proxy) */
      }
      if (!res.ok) {
        setError(
          data.error ||
            (res.status === 429
              ? "El servidor está ocupado; reintentando…"
              : "No se pudieron cargar tus pedidos")
        );
        return false;
      }
      setError(null);
      setAssignments(data.assignments || []);
      return true;
    } catch {
      setError("Error de red al cargar");
      return false;
    } finally {
      setLoaded(true);
    }
  }, []);

  // Pull PESADO de Prewave (design-queue + enqueue-30x de briefs nuevos). Corre en
  // background y NO gatea el render: si trae asignaciones, refresca; si falla, se
  // ignora en silencio (el poll rápido sigue mostrando lo local). Devuelve true si OK.
  const syncPrewave = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/thirtyx/sync-mine", { method: "POST" });
      let data: { assignments?: Assignment[] } = {};
      try {
        data = await res.json();
      } catch {
        /* cuerpo no-JSON */
      }
      if (res.ok && data.assignments) setAssignments(data.assignments);
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  // Dos ritmos independientes, ambos con setTimeout recursivo (nunca apilan requests):
  //   • loadMine cada POLL_OK_MS: barato, pinta y refresca. Backoff en error.
  //   • syncPrewave cada SYNC_MS: caro, en background, encola briefs nuevos.
  useEffect(() => {
    let cancelled = false;
    let fastTimer: ReturnType<typeof setTimeout> | null = null;
    let slowTimer: ReturnType<typeof setTimeout> | null = null;
    let delay = POLL_OK_MS;

    const fastTick = async () => {
      const ok = await loadMine();
      await loadQueue();
      if (cancelled) return;
      delay = ok ? POLL_OK_MS : Math.min(delay * 2, POLL_MAX_MS);
      fastTimer = setTimeout(fastTick, delay);
    };

    const slowTick = async () => {
      await syncPrewave();
      if (cancelled) return;
      slowTimer = setTimeout(slowTick, SYNC_MS);
    };

    fastTick(); // pinta el board lo antes posible
    slowTick(); // primer pull de Prewave en background, y se re-agenda solo

    return () => {
      cancelled = true;
      if (fastTimer) clearTimeout(fastTimer);
      if (slowTimer) clearTimeout(slowTimer);
    };
  }, [loadMine, loadQueue, syncPrewave]);

  // Priorizar: manda este pedido al frente de la fila. Si algo está corriendo y cumple
  // las condiciones de preempción (fase interrumpible, pasó el quantum mínimo, no llegó al
  // tope), le cede el turno guardando checkpoint y lo retoma después.
  const prioritize = useCallback(
    async (jobId: string) => {
      if (busyRef.current.has(jobId)) return;
      busyRef.current.add(jobId);
      try {
        const res = await fetch(`/api/queue/${jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: "urgente" }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || "No se pudo priorizar el pedido");
        }
        await loadQueue();
      } finally {
        busyRef.current.delete(jobId);
      }
    },
    [loadQueue]
  );

  const approve = useCallback(
    async (jobId: string) => {
      if (busyRef.current.has(jobId)) return;
      busyRef.current.add(jobId);
      setError(null);
      try {
        const res = await fetch(`/api/thirtyx/assignments/${jobId}/approve`, { method: "POST" });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || "No se pudo aprobar el pedido");
        }
        await loadMine();
      } finally {
        busyRef.current.delete(jobId);
      }
    },
    [loadMine]
  );

  const retry = useCallback(
    async (jobId: string) => {
      if (busyRef.current.has(jobId)) return;
      busyRef.current.add(jobId);
      try {
        await fetch(`/api/thirtyx/assignments/${jobId}/retry`, { method: "POST" });
        await loadMine();
      } finally {
        busyRef.current.delete(jobId);
      }
    },
    [loadMine]
  );

  // Regenerar desde 0 un pedido que ya está por revisar: descarta el borrador actual
  // y encola una generación limpia (ingestReference crea un carrusel nuevo). Es
  // destructivo sobre el borrador que la diseñadora está revisando, así que confirma.
  const regenerate = useCallback(
    async (jobId: string) => {
      const ok = window.confirm(
        "Esto descarta el borrador actual y genera el carrusel de nuevo desde 0. ¿Seguir?"
      );
      if (!ok) return;
      await retry(jobId);
    },
    [retry]
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }, [router]);

  const queueById = new Map(queue.map((q) => [q.id, q]));

  const porRevisar = assignments.filter((a) => a.status === "pending_review");
  const generando = assignments.filter((a) => GENERATING.includes(a.status));
  const entregado = assignments.filter((a) => a.status === "delivered" || a.status === "done");
  const problemas = assignments.filter((a) => a.status === "blocked" || a.status === "failed");

  return (
    <main className="min-h-screen bg-muted/20">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/90 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/30x/logo-dark.svg" alt="30x" className="h-6 w-auto" />
          <span className="text-sm font-semibold tracking-tight">Open Carrusel</span>
        </div>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link href="/30x" className="transition-colors hover:text-foreground">
            Generar manual
          </Link>
          <Link href="/cuenta" className="transition-colors hover:text-foreground">
            Mi cuenta
          </Link>
          <button onClick={logout} className="transition-colors hover:text-destructive">
            Salir
          </button>
        </nav>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {displayName ? `Tus pedidos, ${displayName}` : "Tus pedidos"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Los carruseles que la IA generó de tus asignaciones de Prewave. Revisalos y aprobalos.
            </p>
          </div>
          <div className="flex items-center gap-4 text-[13px] text-muted-foreground">
            <span><strong className="text-foreground">{porRevisar.length}</strong> por revisar</span>
            <span><strong className="text-foreground">{generando.length}</strong> generando</span>
            <span><strong className="text-foreground">{entregado.length}</strong> entregados</span>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="grid gap-5 md:grid-cols-[2fr_1fr]">
          {/* Columna principal: Por revisar */}
          <Column
            title="Por revisar"
            count={porRevisar.length}
            accent
            empty={
              loaded
                ? generando.length > 0
                  ? "Todavía nada por revisar — hay pedidos generándose."
                  : "No hay nada por revisar por ahora."
                : "Cargando…"
            }
          >
            {porRevisar.map((a) => (
              <li key={a.jobId} className="rounded-xl border border-amber-500/30 bg-background p-4 shadow-sm">
                <div className="flex gap-3">
                  <AssignmentThumb carouselId={a.carouselId} isActive={false} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{shortAvatar(a.avatarName, a.avatarSlug)}</p>
                    <a
                      href={a.referenceUrl || "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-accent-strong hover:underline"
                    >
                      {refHost(a.referenceUrl)}
                    </a>
                  </div>
                </div>
                {a.carouselId && (
                  <div className="mt-3 flex items-center gap-2">
                    <Link
                      href={`/carousel/${a.carouselId}`}
                      className="text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
                    >
                      Abrir para revisar →
                    </Link>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      onClick={() => regenerate(a.jobId)}
                    >
                      Regenerar desde 0
                    </Button>
                    <Button size="sm" onClick={() => approve(a.jobId)}>
                      Aprobar y entregar
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </Column>

          {/* Columna lateral: estado (generando / entregados / con problemas) */}
          <div className="space-y-5">
            {generando.length > 0 && (
              <Column title="Generando" count={generando.length}>
                {generando.map((a) => {
                  const q = queueById.get(a.jobId);
                  const esperando = q?.state === "queued";
                  return (
                    <li key={a.jobId}>
                      <GeneratingCard
                        carouselId={a.carouselId}
                        title={shortAvatar(a.avatarName, a.avatarSlug)}
                        status={a.status}
                        queuePosition={q?.position ?? null}
                      />
                      {/* Priorizar solo tiene sentido si está ESPERANDO y no es ya urgente:
                          sobre el que ya corre no aceleraría nada. */}
                      {esperando && q!.priority > PRIORITY_URGENT && (
                        <div className="mt-1 flex justify-end">
                          <button
                            onClick={() => prioritize(a.jobId)}
                            className="text-[11px] font-medium text-accent-strong underline-offset-2 hover:underline"
                          >
                            Priorizar ↑
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </Column>
            )}

            {entregado.length > 0 && (
              <Column title="Entregados" count={entregado.length}>
                {entregado.map((a) => (
                  <li key={a.jobId} className="flex items-center gap-3 rounded-lg border border-emerald-500/25 bg-background p-3">
                    <AssignmentThumb carouselId={a.carouselId} isActive={false} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{shortAvatar(a.avatarName, a.avatarSlug)}</p>
                      {a.carouselId && (
                        <Link href={`/carousel/${a.carouselId}`} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
                          Ver entregado →
                        </Link>
                      )}
                    </div>
                    <span className="text-[11px] font-medium text-emerald-600">✓ Entregado</span>
                  </li>
                ))}
              </Column>
            )}

            {problemas.length > 0 && (
              <Column title="Con problemas" count={problemas.length}>
                {problemas.map((a) => (
                  <li key={a.jobId} className="rounded-lg border border-border bg-background p-3">
                    <p className="truncate text-xs font-medium">{shortAvatar(a.avatarName, a.avatarSlug)}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                      {a.status === "blocked" ? (a.error || "Sin avatar cargado") : (a.error || "Falló la generación")}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7 text-[11px]"
                      onClick={() => retry(a.jobId)}
                    >
                      Reintentar
                    </Button>
                  </li>
                ))}
              </Column>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function Column({
  title,
  count,
  accent,
  empty,
  children,
}: {
  title: string;
  count: number;
  accent?: boolean;
  empty?: string;
  children: React.ReactNode;
}) {
  const isEmpty = Array.isArray(children) && children.length === 0;
  return (
    <section className={cn("rounded-2xl p-1", accent ? "bg-amber-500/5" : "bg-transparent")}>
      <div className="mb-2 flex items-center justify-between px-3 pt-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      {isEmpty && empty ? (
        <p className="px-3 pb-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-3 px-1 pb-1">{children}</ul>
      )}
    </section>
  );
}
