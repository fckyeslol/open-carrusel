"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RASTER_IMAGE_ACCEPT } from "@/lib/upload-formats";
import type { Background } from "@/types/background";

/** Valor CSS que aplica un fondo a sangre, centrado y recortado sin deformar. */
export function backgroundCss(url: string): string {
  return `url('${url}') center/cover no-repeat`;
}

const ALL = "__all__";

interface BackgroundPickerProps {
  /** Recibe el valor CSS listo para `style.background`. */
  onApply: (cssBackground: string) => void;
}

export function BackgroundPicker({ onApply }: BackgroundPickerProps) {
  const [items, setItems] = useState<Background[]>([]);
  const [category, setCategory] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/backgrounds");
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data.backgrounds) ? data.backgrounds : []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const categories = useMemo(
    () => [...new Set(items.map((b) => b.category))].sort(),
    [items]
  );

  // Si se borró el último fondo de la categoría activa, el selector se esconde
  // (queda una sola categoría) y el filtro dejaría la grilla vacía para siempre:
  // volvemos a "Todos" en cuanto la categoría elegida deja de existir.
  const activeCategory = category !== ALL && !categories.includes(category) ? ALL : category;

  const visible = useMemo(
    () =>
      activeCategory === ALL ? items : items.filter((b) => b.category === activeCategory),
    [items, activeCategory]
  );

  const onUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("purpose", "background");
        const up = await fetch("/api/upload", { method: "POST", body: fd });
        const uploaded = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(uploaded?.error || `Error ${up.status}`);

        const res = await fetch("/api/backgrounds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: uploaded.url,
            name: file.name.replace(/\.[^.]+$/, "").slice(0, 120),
            category: activeCategory === ALL ? "general" : activeCategory,
            width: uploaded.width,
            height: uploaded.height,
          }),
        });
        const created = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(created?.error || `Error ${res.status}`);
        setItems((prev) => [...prev, created]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
      }
    },
    [activeCategory]
  );

  const onRemove = useCallback(async (item: Background) => {
    setItems((prev) => prev.filter((b) => b.id !== item.id));
    try {
      const res = await fetch(`/api/backgrounds/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Error ${res.status}`);
    } catch (e) {
      setError((e as Error).message);
      // Reponemos solo este ítem. Restaurar un snapshot del array entero
      // resucitaría lo que otro borrado, ya confirmado, sacó mientras tanto.
      setItems((prev) =>
        prev.some((b) => b.id === item.id) ? prev : [...prev, item]
      );
    }
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Fondos
        </span>
        <span className="text-[11px] text-muted-foreground/70">{items.length}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title="Subir un fondo nuevo"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={RASTER_IMAGE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
      </div>

      {categories.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {[ALL, ...categories].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] transition-colors",
                activeCategory === c
                  ? "bg-foreground text-background"
                  : "border border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              )}
            >
              {c === ALL ? "Todos" : c}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      {loading ? (
        <p className="text-xs text-muted-foreground">Cargando…</p>
      ) : visible.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          No hay fondos todavía. Usá <b>+</b> para subir uno, o corré{" "}
          <code className="rounded bg-muted px-1">npm run import:backgrounds</code>.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {visible.map((b) => (
            <div key={b.id} className="group relative">
              <button
                type="button"
                onClick={() => onApply(backgroundCss(b.url))}
                title={`${b.name} · ${b.width}×${b.height}`}
                className="block aspect-[4/5] w-full overflow-hidden rounded-md border border-border transition-all hover:border-foreground/50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-foreground/30"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={b.url}
                  alt={b.name}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                />
              </button>
              <button
                type="button"
                onClick={() => onRemove(b)}
                title="Quitar de la biblioteca (no borra el archivo)"
                aria-label={`Quitar ${b.name} de la biblioteca`}
                /* Visible al pasar el mouse, al tabular con teclado y siempre en
                   pantallas táctiles, donde el hover nunca ocurre. */
                className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background opacity-0 shadow-sm transition-all hover:bg-red-600 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-foreground/40 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() => onApply("transparent")}
      >
        <Ban className="h-4 w-4" /> Quitar fondo
      </Button>
    </div>
  );
}
