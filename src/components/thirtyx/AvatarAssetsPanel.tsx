"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Trash2, ImageOff } from "lucide-react";
import { SectionLabel } from "@/components/thirtyx/SectionLabel";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

interface AssetFile {
  file: string;
  url: string;
}

type AssetKind = "logo" | "fotos" | "fondos" | "referencias";

interface AvatarAssets {
  slug: string;
  name: string;
  assets: Record<AssetKind, AssetFile[]>;
}

const KINDS: Array<{ kind: AssetKind; label: string; hint: string }> = [
  { kind: "logo", label: "Logo / firma", hint: "El primero pasa a ser el logo del avatar" },
  { kind: "fotos", label: "Fotos del mentor", hint: "Retratos para el fondo FOTO MENTOR" },
  { kind: "fondos", label: "Fondos", hint: "Texturas, planos y degradés de marca" },
  { kind: "referencias", label: "Referencias", hint: "Carruseles ya publicados, calibran el estilo" },
];

/** "Cinthya Sánchez" → "Cinthya" para los chips; el nombre completo va en title. */
function firstName(name: string): string {
  return name.split(/\s+/)[0] || name;
}

/**
 * Panel "Assets de marca" de /30x: cada avenger tiene su carpeta versionada en
 * git (30x/avatars/<slug>/assets/) y desde acá cualquiera del equipo sube o
 * borra imágenes sin tocar el explorador de archivos.
 */
export function AvatarAssetsPanel({ syncSlug }: { syncSlug?: string }) {
  const [avatars, setAvatars] = useState<AvatarAssets[]>([]);
  const [selected, setSelected] = useState("");
  const [uploading, setUploading] = useState<AssetKind | null>(null);
  const [dragOver, setDragOver] = useState<AssetKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<{ kind: AssetKind; file: string } | null>(null);
  const inputRefs = useRef<Partial<Record<AssetKind, HTMLInputElement | null>>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/avatar-assets");
      const data = await res.json();
      setAvatars(data.avatars || []);
    } catch {
      setError("No se pudieron cargar los assets");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Seguir a la sección Referente SOLO cuando cambia de avatar; si no, el efecto
  // pisaría la selección manual de los chips en cada render.
  const lastSync = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (syncSlug !== lastSync.current) {
      lastSync.current = syncSlug;
      if (syncSlug && avatars.some((a) => a.slug === syncSlug)) setSelected(syncSlug);
    }
  }, [syncSlug, avatars]);

  // Primer avatar por defecto al cargar.
  useEffect(() => {
    if (!selected && avatars.length) setSelected(avatars[0].slug);
  }, [avatars, selected]);

  const avatar = avatars.find((a) => a.slug === selected);

  const upload = useCallback(
    async (kind: AssetKind, files: FileList | File[]) => {
      if (!selected || uploading) return;
      setError(null);
      setUploading(kind);
      try {
        for (const file of Array.from(files)) {
          const body = new FormData();
          body.append("kind", kind);
          body.append("file", file);
          const res = await fetch(`/api/avatar-assets/${selected}`, { method: "POST", body });
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            throw new Error(data?.error || `No se pudo subir ${file.name}`);
          }
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo subir el archivo");
      } finally {
        setUploading(null);
      }
    },
    [selected, uploading, load]
  );

  const remove = useCallback(async () => {
    if (!toDelete || !selected) return;
    setError(null);
    try {
      const qs = new URLSearchParams({ kind: toDelete.kind, file: toDelete.file });
      const res = await fetch(`/api/avatar-assets/${selected}?${qs}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "No se pudo borrar");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo borrar el asset");
    } finally {
      setToDelete(null);
    }
  }, [toDelete, selected, load]);

  if (!avatars.length) return null;

  return (
    <section className="mt-10">
      <SectionLabel index="03" aside={avatar?.name}>
        Assets de marca
      </SectionLabel>

      <div className="rounded-xl border border-border bg-surface p-6 sm:p-7">
        {/* chips de avengers */}
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Avengers">
          {avatars.map((a) => {
            const count = KINDS.reduce((n, k) => n + a.assets[k.kind].length, 0);
            const active = a.slug === selected;
            return (
              <button
                key={a.slug}
                type="button"
                role="tab"
                aria-selected={active}
                title={a.name}
                onClick={() => setSelected(a.slug)}
                className={cn(
                  "cursor-pointer rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                )}
              >
                {firstName(a.name)}
                {count > 0 && (
                  <span className={cn("ml-1.5 font-mono text-[10px] tabular-nums", active ? "opacity-70" : "opacity-60")}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Las imágenes quedan guardadas para siempre en la carpeta del avenger y le llegan a
          todo el equipo. El agente las usa al generar sus carruseles.
        </p>

        {error && (
          <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* grupos por tipo */}
        {avatar && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {KINDS.map(({ kind, label, hint }) => {
              const files = avatar.assets[kind];
              const isUploading = uploading === kind;
              return (
                <div
                  key={kind}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(kind);
                  }}
                  onDragLeave={() => setDragOver((v) => (v === kind ? null : v))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(null);
                    if (e.dataTransfer.files.length) upload(kind, e.dataTransfer.files);
                  }}
                  className={cn(
                    "rounded-lg border p-4 transition-colors",
                    dragOver === kind ? "border-accent bg-accent/5" : "border-border bg-background"
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div>
                      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em]">{label}</h3>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => inputRefs.current[kind]?.click()}
                      disabled={uploading !== null}
                      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50"
                    >
                      <Plus className="h-3 w-3" aria-hidden="true" />
                      {isUploading ? "Subiendo…" : "Agregar"}
                    </button>
                    <input
                      ref={(el) => {
                        inputRefs.current[kind] = el;
                      }}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.length) upload(kind, e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </div>

                  {files.length === 0 ? (
                    <div className="mt-3 flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-[11px] text-muted-foreground/70">
                      <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      Sin imágenes — arrastrá acá o tocá Agregar
                    </div>
                  ) : (
                    <ul className="mt-3 grid grid-cols-4 gap-2">
                      {files.map(({ file, url }) => (
                        <li key={file} className="group relative">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt={file}
                            title={file}
                            loading="lazy"
                            className="aspect-square w-full rounded-md border border-border object-cover"
                          />
                          <button
                            type="button"
                            aria-label={`Borrar ${file}`}
                            onClick={() => setToDelete({ kind, file })}
                            className="absolute right-1 top-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title="¿Borrar este asset?"
        description={
          toDelete
            ? `"${toDelete.file}" se borra de la carpeta del avenger para todo el equipo.`
            : ""
        }
        confirmLabel="Borrar"
        variant="destructive"
        onConfirm={remove}
      />
    </section>
  );
}
