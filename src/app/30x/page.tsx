"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IngestProgress } from "@/components/thirtyx/IngestProgress";
import { SectionLabel } from "@/components/thirtyx/SectionLabel";
import { AssignmentQueue } from "@/components/thirtyx/AssignmentQueue";
import { useIngest, type IngestDone } from "@/hooks/useIngest";
import { isInstagramUrl } from "@/lib/instagram-url";
import { cn } from "@/lib/utils";

interface AvatarInfo {
  slug: string | null;
  name: string;
  presetId: string;
  status: string;
  hasFormat: boolean;
}

interface PrewaveStatus {
  apiBase: string;
  configured: boolean;
  hasToken: boolean;
  hasApiKey: boolean;
}

interface HiggsfieldStatus {
  configured: boolean;
  hasApiKey: boolean;
  hasApiSecret: boolean;
}

/** "30X — Andrés Bilbao" → "Andrés Bilbao": el prefijo se repite en todos. */
function shortAvatarName(name: string): string {
  return name.replace(/^30X\s*[—–-]\s*/i, "").trim() || name;
}

export default function ThirtyXPage() {
  const router = useRouter();
  const [avatars, setAvatars] = useState<AvatarInfo[]>([]);
  const [prewave, setPrewave] = useState<PrewaveStatus | null>(null);
  const [higgsfield, setHiggsfield] = useState<HiggsfieldStatus | null>(null);

  // manual entry
  const [url, setUrl] = useState("");
  const [avatarSlug, setAvatarSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  // config form
  const [showConfig, setShowConfig] = useState(false);
  const [apiBase, setApiBase] = useState("");
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hfKey, setHfKey] = useState("");
  const [hfSecret, setHfSecret] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);

  const goToCarousel = useCallback(
    (data: IngestDone) => {
      try {
        sessionStorage.setItem(`autogen-${data.carouselId}`, data.generationMessage);
      } catch {
        /* noop */
      }
      router.push(`/carousel/${data.carouselId}`);
    },
    [router]
  );

  const ingest = useIngest(goToCarousel);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/thirtyx/config");
      const data = await res.json();
      setAvatars(data.avatars || []);
      setPrewave(data.prewave || null);
      setHiggsfield(data.higgsfield || null);
      setApiBase(data.prewave?.apiBase || "");
      const ready = (data.avatars || []).filter((a: AvatarInfo) => a.status === "ready");
      if (ready.length && !avatarSlug) setAvatarSlug(ready[0].slug || "");
    } catch {
      setError("No se pudo cargar la configuración 30x");
    }
  }, [avatarSlug]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const runManual = useCallback(() => {
    setError(null);
    ingest.start("manual", (signal) =>
      fetch("/api/thirtyx/from-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceUrl: url.trim(), avatarSlug }),
        signal,
      })
    );
  }, [ingest, url, avatarSlug]);

  const handleManual = () => {
    setError(null);
    if (!url.trim()) return setError("Pegá la URL del referente de Instagram");
    if (!isInstagramUrl(url.trim()))
      return setError("Esa URL no parece un post o reel de Instagram");
    if (!avatarSlug) return setError("Elegí un avatar");
    runManual();
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      await fetch("/api/thirtyx/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiBase,
          token,
          apiKey,
          higgsfield: { apiKey: hfKey, apiSecret: hfSecret },
        }),
      });
      setToken("");
      setApiKey("");
      setHfKey("");
      setHfSecret("");
      setShowConfig(false);
      await loadConfig();
    } finally {
      setSavingConfig(false);
    }
  };

  const readyAvatars = avatars.filter((a) => a.status === "ready");
  const busy = ingest.runningKey !== null && !ingest.error && !ingest.finished;
  const manualRunning = ingest.runningKey === "manual";
  const canSubmit = url.trim().length > 0 && avatarSlug.length > 0;
  const selectedAvatar = readyAvatars.find((a) => a.slug === avatarSlug);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <TopBar />
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12 sm:px-8">
        {/* ── Masthead editorial ─────────────────────────────────────────── */}
        <header className="border-b border-foreground/15 pb-6">
          <div className="flex items-start justify-between gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
                Carruseles
              </p>
              <h1 className="mt-1 text-5xl font-bold leading-none tracking-[-0.03em] sm:text-6xl">
                30x
              </h1>
            </div>

            <button
              type="button"
              onClick={() => setShowConfig((v) => !v)}
              aria-expanded={showConfig}
              className="group flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-[11px] font-medium transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  prewave?.configured ? "bg-emerald-500" : "bg-muted-foreground/40"
                )}
              />
              {prewave?.configured ? "Prewave conectado" : "Conectar Prewave"}
            </button>
          </div>

          <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-muted-foreground">
            Generá un carrusel desde un referente de Instagram con el ADN del avatar.
          </p>
        </header>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {/* ── Config Prewave ─────────────────────────────────────────────── */}
        {showConfig && (
          <section className="mt-8 rounded-xl border border-border bg-surface p-5">
            <SectionLabel index="00">Conexión con Prewave</SectionLabel>
            <div className="space-y-3">
              <label className="block text-xs text-muted-foreground" htmlFor="prewave-base">
                API base
              </label>
              <Input
                id="prewave-base"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="https://api.prewave.oracle30x.co/api/v1"
              />
              <label className="block text-xs text-muted-foreground" htmlFor="prewave-token">
                Tu token de diseñadora (JWT) — solo ves TUS trabajos
              </label>
              <Input
                id="prewave-token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                placeholder={prewave?.hasToken ? "•••••• (ya guardado)" : "pegá tu token"}
              />
              <label className="block text-xs text-muted-foreground" htmlFor="prewave-key">
                o Pipeline API key (ops) — acceso total
              </label>
              <Input
                id="prewave-key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type="password"
                placeholder={prewave?.hasApiKey ? "•••••• (ya guardada)" : "opcional"}
              />
            </div>

            {/* ── Generación de imágenes (Higgsfield) ─────────────────────── */}
            <div className="mt-6 border-t border-border pt-5">
              <div className="flex items-center gap-2">
                <SectionLabel index="01">Generación de imágenes (Higgsfield)</SectionLabel>
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    higgsfield?.configured ? "bg-emerald-500" : "bg-muted-foreground/40"
                  )}
                />
              </div>
              <p className="mt-1 mb-3 text-xs text-muted-foreground">
                Para generar/regenerar imágenes con IA en el editor. Pedile las claves a Mateo
                y pegalas acá una sola vez (quedan guardadas en esta compu).
              </p>
              <div className="space-y-3">
                <label className="block text-xs text-muted-foreground" htmlFor="hf-key">
                  API Key ID
                </label>
                <Input
                  id="hf-key"
                  value={hfKey}
                  onChange={(e) => setHfKey(e.target.value)}
                  type="password"
                  placeholder={higgsfield?.hasApiKey ? "•••••• (ya guardada)" : "pegá la API Key ID"}
                />
                <label className="block text-xs text-muted-foreground" htmlFor="hf-secret">
                  API Key Secret
                </label>
                <Input
                  id="hf-secret"
                  value={hfSecret}
                  onChange={(e) => setHfSecret(e.target.value)}
                  type="password"
                  placeholder={higgsfield?.hasApiSecret ? "•••••• (ya guardada)" : "pegá la API Key Secret"}
                />
              </div>

            <Button size="sm" className="mt-5" onClick={saveConfig} disabled={savingConfig}>
              {savingConfig ? "Guardando…" : "Guardar"}
            </Button>
            </div>
          </section>
        )}

        {/* ── 01 · Referente (el bloque protagonista) ────────────────────── */}
        <section className="mt-10">
          <SectionLabel
            index="01"
            aside={selectedAvatar ? shortAvatarName(selectedAvatar.name) : undefined}
          >
            Referente
          </SectionLabel>

          <div className="rounded-xl border border-border bg-surface p-6 sm:p-7">
            <label
              htmlFor="reference-url"
              className="block text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
            >
              URL de Instagram
            </label>

            {/* Input subrayado, no encajonado: la URL es la protagonista. */}
            <input
              id="reference-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit && !busy) handleManual();
              }}
              disabled={busy}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="instagram.com/p/…"
              className="mt-2 w-full border-0 border-b-2 border-border bg-transparent px-0 py-2.5 text-lg text-foreground transition-colors placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none disabled:opacity-50 sm:text-xl"
            />

            <p className="mt-2 text-xs text-muted-foreground">
              Post o reel público. Bajamos sus láminas y las usamos como referente.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <label className="sr-only" htmlFor="avatar-select">
                Avatar
              </label>
              <select
                id="avatar-select"
                className="h-10 cursor-pointer rounded-lg border border-border bg-background px-3 text-sm transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                value={avatarSlug}
                onChange={(e) => setAvatarSlug(e.target.value)}
                disabled={busy}
              >
                <option value="">— Elegí un avatar —</option>
                {readyAvatars.map((a) => (
                  <option key={a.presetId} value={a.slug || ""}>
                    {shortAvatarName(a.name)}
                  </option>
                ))}
              </select>

              {/* variant default (casi negro, 17.9:1). El acento en blanco solo
                  da 3.83:1 y no pasa AA para el texto del botón. */}
              <Button
                onClick={handleManual}
                disabled={busy || !canSubmit}
                className="ml-auto"
              >
                {manualRunning && busy ? "Generando…" : "Generar carrusel"}
              </Button>
            </div>

            {avatars.length > 0 && readyAvatars.length === 0 && (
              <p className="mt-4 text-xs text-amber-600">
                Ningún avatar está listo. Corré <code>node scripts/import-avatars.mjs</code> y
                creá sus formatos.
              </p>
            )}
          </div>

          {manualRunning && ingest.startedAt !== null && (
            <div className="oc-enter mt-4">
              {/* key por arranque: remonta el panel en cada reintento para que
                  el cronómetro no muestre el tiempo del run anterior. */}
              <IngestProgress
                key={ingest.startedAt}
                stages={ingest.stages}
                startedAt={ingest.startedAt}
                finished={ingest.finished}
                error={ingest.error}
                onRetry={runManual}
                onCancel={ingest.reset}
              />
            </div>
          )}
        </section>

        {/* ── 02 · Asignaciones (push desde Prewave) ─────────────────────── */}
        <AssignmentQueue />

        <footer className="mt-16 border-t border-border pt-5">
          <Link
            href="/"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            ← Volver a todos los carruseles
          </Link>
        </footer>
      </main>
    </div>
  );
}
