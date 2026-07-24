"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
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

const POLL_MS = 8000;

/** Estados en curso (aún generándose). */
const GENERATING = ["received", "claiming", "ingesting", "generating", "rendering"];

const STAGE_LABEL: Record<string, string> = {
  received: "En cola",
  ingesting: "Bajando referente",
  generating: "Generando",
  rendering: "Renderizando",
  blocked: "Sin avatar",
  failed: "Falló",
};

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
  const busyRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((b) => setDisplayName(b?.user?.displayName || ""))
      .catch(() => {});
  }, []);

  const sync = useCallback(async () => {
    try {
      const res = await fetch("/api/thirtyx/sync-mine", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "No se pudo sincronizar con Prewave");
      } else {
        setError(null);
      }
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
        await sync();
      } finally {
        busyRef.current.delete(jobId);
      }
    },
    [sync]
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }, [router]);

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
                    <Button size="sm" className="ml-auto" onClick={() => approve(a.jobId)}>
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
                {generando.map((a) => (
                  <li key={a.jobId} className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
                    <AssignmentThumb carouselId={a.carouselId} isActive />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{shortAvatar(a.avatarName, a.avatarSlug)}</p>
                      <p className="flex items-center gap-1.5 text-[11px] text-accent-strong">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                        {STAGE_LABEL[a.status] || "En proceso"}
                      </p>
                    </div>
                  </li>
                ))}
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
