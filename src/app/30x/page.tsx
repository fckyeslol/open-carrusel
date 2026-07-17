"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

interface Job {
  id: string;
  reference_url: string | null;
  avatar_slug: string | null;
  avatar_name: string | null;
  created_at: string;
}

export default function ThirtyXPage() {
  const router = useRouter();
  const [avatars, setAvatars] = useState<AvatarInfo[]>([]);
  const [prewave, setPrewave] = useState<PrewaveStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);

  // manual entry
  const [url, setUrl] = useState("");
  const [avatarSlug, setAvatarSlug] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // config form
  const [showConfig, setShowConfig] = useState(false);
  const [apiBase, setApiBase] = useState("");
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/thirtyx/config");
      const data = await res.json();
      setAvatars(data.avatars || []);
      setPrewave(data.prewave || null);
      setApiBase(data.prewave?.apiBase || "");
      const ready = (data.avatars || []).filter((a: AvatarInfo) => a.status === "ready");
      if (ready.length && !avatarSlug) setAvatarSlug(ready[0].slug || "");
    } catch {
      setError("No se pudo cargar la configuración 30x");
    }
  }, [avatarSlug]);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/thirtyx/jobs");
      const data = await res.json();
      if (!res.ok) {
        setJobsError(data.error || "No se pudieron cargar los trabajos");
        setJobs([]);
        return;
      }
      setJobsError(null);
      setJobs(data.jobs || []);
    } catch {
      setJobsError("Error de red al cargar los trabajos");
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);
  useEffect(() => {
    if (prewave?.configured) loadJobs();
  }, [prewave?.configured, loadJobs]);

  const goToCarousel = (data: { carouselId: string; generationMessage: string }) => {
    try {
      sessionStorage.setItem(`autogen-${data.carouselId}`, data.generationMessage);
    } catch {
      /* noop */
    }
    router.push(`/carousel/${data.carouselId}`);
  };

  const handleManual = async () => {
    setError(null);
    if (!url.trim()) return setError("Pegá la URL del referente de Instagram");
    if (!avatarSlug) return setError("Elegí un avatar");
    setBusy("manual");
    try {
      const res = await fetch("/api/thirtyx/from-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceUrl: url.trim(), avatarSlug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falló la ingesta");
      goToCarousel(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleStartJob = async (jobId: string) => {
    setError(null);
    setBusy(jobId);
    try {
      const res = await fetch(`/api/thirtyx/jobs/${jobId}/start`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo iniciar el trabajo");
      goToCarousel(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = async () => {
    setBusy("config");
    try {
      await fetch("/api/thirtyx/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiBase, token, apiKey }),
      });
      setToken("");
      setApiKey("");
      setShowConfig(false);
      await loadConfig();
    } finally {
      setBusy(null);
    }
  };

  const readyAvatars = avatars.filter((a) => a.status === "ready");

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <TopBar />
      <main className="flex-1 w-full max-w-3xl mx-auto px-6 py-10 space-y-10">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Carruseles 30x</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Generá un carrusel desde un referente de Instagram con el ADN del avatar.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowConfig((v) => !v)}>
            {prewave?.configured ? "Conexión ✓" : "Conectar Prewave"}
          </Button>
        </header>

        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 text-sm px-4 py-3">
            {error}
          </div>
        )}

        {/* Config */}
        {showConfig && (
          <section className="rounded-xl border border-border p-5 space-y-3 bg-surface">
            <h2 className="font-semibold text-sm">Conexión con Prewave (la cola actual)</h2>
            <label className="block text-xs text-muted-foreground">API base</label>
            <Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://api.prewave.oracle30x.co/api/v1" />
            <label className="block text-xs text-muted-foreground">
              Tu token de diseñadora (JWT) — solo ves TUS trabajos
            </label>
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder={prewave?.hasToken ? "•••••• (ya guardado)" : "pegá tu token"} />
            <label className="block text-xs text-muted-foreground">
              o Pipeline API key (ops) — acceso total
            </label>
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder={prewave?.hasApiKey ? "•••••• (ya guardada)" : "opcional"} />
            <Button size="sm" onClick={saveConfig} disabled={busy === "config"}>
              {busy === "config" ? "Guardando…" : "Guardar"}
            </Button>
          </section>
        )}

        {/* Entrada manual */}
        <section className="rounded-xl border border-border p-5 space-y-4">
          <h2 className="font-semibold">Pegá una URL de Instagram</h2>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.instagram.com/p/XXXXXXXX/"
          />
          <div className="flex items-center gap-3">
            <select
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              value={avatarSlug}
              onChange={(e) => setAvatarSlug(e.target.value)}
            >
              <option value="">— Elegí un avatar —</option>
              {readyAvatars.map((a) => (
                <option key={a.presetId} value={a.slug || ""}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button onClick={handleManual} disabled={busy === "manual"}>
              {busy === "manual" ? "Bajando referente…" : "Generar carrusel"}
            </Button>
          </div>
          {avatars.length > 0 && readyAvatars.length === 0 && (
            <p className="text-xs text-amber-600">
              Ningún avatar está listo. Corré <code>node scripts/import-avatars.mjs</code> y creá sus formatos.
            </p>
          )}
        </section>

        {/* Bandeja de trabajos */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Trabajos pendientes (cola de Prewave)</h2>
            {prewave?.configured && (
              <Button variant="outline" size="sm" onClick={loadJobs}>
                Actualizar
              </Button>
            )}
          </div>
          {!prewave?.configured ? (
            <p className="text-sm text-muted-foreground">
              Conectá tu token de Prewave para ver los trabajos que te asignaron.
            </p>
          ) : jobsError ? (
            <p className="text-sm text-red-600">{jobsError}</p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay trabajos pendientes.</p>
          ) : (
            <ul className="space-y-2">
              {jobs.map((job) => (
                <li key={job.id} className="rounded-lg border border-border p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {job.avatar_name || job.avatar_slug || "Sin avatar"}
                    </p>
                    <a
                      href={job.reference_url || "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-accent underline truncate block max-w-md"
                    >
                      {job.reference_url}
                    </a>
                  </div>
                  <Button size="sm" onClick={() => handleStartJob(job.id)} disabled={busy === job.id}>
                    {busy === job.id ? "Preparando…" : "Generar"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-xs text-muted-foreground">
          <Link href="/" className="underline">
            ← Volver a todos los carruseles
          </Link>
        </p>
      </main>
    </div>
  );
}
