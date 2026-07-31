"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, FolderOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
import { BoardHeader } from "@/components/thirtyx/BoardHeader";
import { GeneratingCard } from "@/components/thirtyx/GeneratingCard";
import { refHost, shortAvatar } from "@/lib/library-folders";
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

/**
 * Cuántos entregados se muestran en el tablero.
 *
 * "Entregados" solo crece: es la única columna que nunca se vacía sola, así que a las pocas
 * semanas era una fila infinita empujando "Generando" y "Con problemas" fuera de la
 * pantalla. El tablero es el trabajo de HOY; el historial completo vive en la Biblioteca,
 * y el botón de la columna lleva ahí.
 */
const ENTREGADOS_VISIBLES = 3;

export function ReviewBoard() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [displayName, setDisplayName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  /** jobIds que ya conté como revisados HOY. Es lo que pinta el botón ya marcado. */
  const [reviewedToday, setReviewedToday] = useState<string[]>([]);
  const busyRef = useRef<Set<string>>(new Set());
  /**
   * Marcar "Revisado" usa su PROPIO candado, no `busyRef`.
   *
   * Con el candado compartido, apretar "Revisado" y enseguida "Aprobar y entregar" hacía
   * que el segundo click se descartara en silencio mientras el primero estaba en vuelo.
   * Las dos operaciones son independientes y marcar es idempotente, así que no hay razón
   * para que una bloquee a la otra.
   */
  const markingRef = useRef<Set<string>>(new Set());

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
      let data: { error?: string; assignments?: Assignment[]; reviewedToday?: string[] } = {};
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
      setReviewedToday(data.reviewedToday || []);
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

  // "Revisado": suma al contador del día y NADA más. No cambia el estado del pedido, no
  // toca Prewave y la card se queda donde está — sirve para el que se mira, se corrige y
  // todavía no está para entregar, que es la mayor parte del trabajo de una jornada.
  //
  // Se pinta optimista porque el server es idempotente: si el POST falla, revertir deja
  // el botón exactamente como estaba antes del click.
  const markReviewed = useCallback(async (jobId: string) => {
    if (markingRef.current.has(jobId)) return;
    markingRef.current.add(jobId);
    setReviewedToday((prev) => (prev.includes(jobId) ? prev : [...prev, jobId]));
    try {
      const res = await fetch(`/api/thirtyx/assignments/${jobId}/reviewed`, { method: "POST" });
      const d: { error?: string; reviewedToday?: string[] } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setReviewedToday((prev) => prev.filter((id) => id !== jobId));
        setError(d.error || "No se pudo marcar como revisado");
        return;
      }
      if (d.reviewedToday) setReviewedToday(d.reviewedToday);
    } catch {
      setReviewedToday((prev) => prev.filter((id) => id !== jobId));
      setError("Error de red al marcar como revisado");
    } finally {
      markingRef.current.delete(jobId);
    }
  }, []);

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

  // Eliminar del tablero. No borra nada: el pedido pasa a la Biblioteca (/biblioteca) y
  // desde ahí se puede restaurar. Confirma porque la card desaparece de la vista.
  //
  // `generating` cambia el mensaje, no el endpoint: sobre algo en vuelo el DELETE además
  // lo saca del carril, y eso hay que decirlo antes de que la diseñadora acepte —
  // descartar una generación a medias tira trabajo ya pagado.
  const discard = useCallback(
    async (jobId: string, generating = false) => {
      if (busyRef.current.has(jobId)) return;
      const ok = window.confirm(
        generating
          ? "Se corta la generación en curso y el pedido queda guardado en la Biblioteca, de donde lo podés restaurar y reintentar. ¿Cancelar?"
          : "El pedido sale del tablero y queda guardado en la Biblioteca, de donde lo podés restaurar. ¿Eliminar?"
      );
      if (!ok) return;
      busyRef.current.add(jobId);
      setError(null);
      try {
        const res = await fetch(`/api/thirtyx/assignments/${jobId}`, { method: "DELETE" });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || "No se pudo eliminar el pedido");
        }
        await loadMine();
        // El carril cambió: el que se canceló liberó su lugar y los puestos se corren.
        if (generating) await loadQueue();
      } finally {
        busyRef.current.delete(jobId);
      }
    },
    [loadMine, loadQueue]
  );

  const queueById = new Map(queue.map((q) => [q.id, q]));
  const reviewedSet = new Set(reviewedToday);

  const porRevisar = assignments.filter((a) => a.status === "pending_review");
  const generando = assignments.filter((a) => GENERATING.includes(a.status));
  const entregado = assignments.filter((a) => a.status === "delivered" || a.status === "done");
  const problemas = assignments.filter((a) => a.status === "blocked" || a.status === "failed");

  return (
    <main className="min-h-screen bg-muted/20">
      <BoardHeader active="tablero" />

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
            {/* El contador del día se separa del resto: los otros tres describen el estado
                del tablero AHORA, este es trabajo acumulado y se reinicia a medianoche. */}
            <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1 text-emerald-700">
              <Check className="h-3.5 w-3.5" />
              <strong>{reviewedToday.length}</strong> revisados hoy
            </span>
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
                {/* La fila de acciones va siempre: "Eliminar" tiene que estar incluso si
                    el pedido quedó sin carrusel (nada que abrir ni aprobar). */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {a.carouselId && (
                    <Link
                      href={`/carousel/${a.carouselId}`}
                      className="text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
                    >
                      Abrir para revisar →
                    </Link>
                  )}
                  <ReviewedToggle
                    marked={reviewedSet.has(a.jobId)}
                    onMark={() => markReviewed(a.jobId)}
                  />
                  <button
                    onClick={() => discard(a.jobId)}
                    title="Sacar del tablero y guardarlo en la Biblioteca"
                    className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Eliminar
                  </button>
                  {a.carouselId && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => regenerate(a.jobId)}>
                        Regenerar desde 0
                      </Button>
                      <Button size="sm" onClick={() => approve(a.jobId)}>
                        Aprobar y entregar
                      </Button>
                    </>
                  )}
                </div>
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
                      {/* Acciones de la card. Van FUERA de GeneratingCard porque la card
                          entera es un <Link> al editor y un botón adentro sería
                          interactivo dentro de interactivo. */}
                      <div className="mt-1 flex items-center gap-3">
                        <button
                          onClick={() => discard(a.jobId, true)}
                          title="Cortar la generación y guardarlo en la Biblioteca"
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                          Cancelar
                        </button>
                        {/* Priorizar solo tiene sentido si está ESPERANDO y no es ya urgente:
                            sobre el que ya corre no aceleraría nada. */}
                        {esperando && q!.priority > PRIORITY_URGENT && (
                          <button
                            onClick={() => prioritize(a.jobId)}
                            className="ml-auto text-[11px] font-medium text-accent-strong underline-offset-2 hover:underline"
                          >
                            Priorizar ↑
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </Column>
            )}

            {entregado.length > 0 && (
              <Column
                title="Entregados"
                count={entregado.length}
                action={
                  <Link
                    href="/biblioteca"
                    title="Ver todos tus entregados, en carpetas por avenger"
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-accent-strong/40 hover:bg-accent/5 hover:text-accent-strong"
                  >
                    <FolderOpen className="h-3 w-3" />
                    Biblioteca
                  </Link>
                }
                footer={
                  entregado.length > ENTREGADOS_VISIBLES ? (
                    <Link
                      href="/biblioteca"
                      className="block px-3 py-2 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-accent-strong hover:underline"
                    >
                      + {entregado.length - ENTREGADOS_VISIBLES} más en la Biblioteca →
                    </Link>
                  ) : null
                }
              >
                {entregado.slice(0, ENTREGADOS_VISIBLES).map((a) => (
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

/**
 * El botón "Revisado". Marca en un solo sentido: una vez contado, queda contado — el
 * contador mide trabajo hecho, y poder desmarcarlo lo volvería un número editable.
 * Deshabilitado (y no oculto) cuando ya está marcado, para que la card siga mostrando
 * que ese pedido ya se contó hoy.
 */
function ReviewedToggle({ marked, onMark }: { marked: boolean; onMark: () => void }) {
  return (
    <button
      onClick={onMark}
      disabled={marked}
      title={
        marked
          ? "Ya lo contaste hoy. Vuelve a contar mañana si lo revisás de nuevo."
          : "Sumar este carrusel a tu contador de revisiones del día"
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
        marked
          ? "cursor-default border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
          : "border-border text-muted-foreground hover:border-emerald-500/40 hover:bg-emerald-500/5 hover:text-emerald-700"
      )}
    >
      <Check className="h-3.5 w-3.5" />
      Revisado
    </button>
  );
}

function Column({
  title,
  count,
  accent,
  empty,
  action,
  footer,
  children,
}: {
  title: string;
  count: number;
  accent?: boolean;
  empty?: string;
  /** Acción de la columna, al lado del contador (p. ej. "Biblioteca"). */
  action?: React.ReactNode;
  /** Pie de la columna: lo que queda afuera de la lista recortada. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isEmpty = Array.isArray(children) && children.length === 0;
  return (
    <section className={cn("rounded-2xl p-1", accent ? "bg-amber-500/5" : "bg-transparent")}>
      <div className="mb-2 flex items-center justify-between gap-2 px-3 pt-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <div className="flex items-center gap-2">
          {action}
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {count}
          </span>
        </div>
      </div>
      {isEmpty && empty ? (
        <p className="px-3 pb-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-3 px-1 pb-1">{children}</ul>
      )}
      {footer}
    </section>
  );
}
