"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Layers, Calendar, SlidersHorizontal, Trash2, Copy, Pencil, Search } from "lucide-react";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CreateCarouselDialog } from "@/components/ui/create-carousel-dialog";
import { BrandSetup } from "@/components/brand/BrandSetup";
import { SlideRenderer } from "@/components/editor/SlideRenderer";
import { TemplateGallery } from "@/components/templates/TemplateGallery";
import type { Carousel } from "@/types/carousel";
import type { BrandConfig } from "@/types/brand";

export default function DashboardPage() {
  const router = useRouter();
  const [carousels, setCarousels] = useState<Carousel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBrandSetup, setShowBrandSetup] = useState(false);
  const [brand, setBrand] = useState<BrandConfig | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/carousels").then((r) => r.json()),
      fetch("/api/brand").then((r) => r.json()),
    ])
      .then(([carouselData, brandData]) => {
        setCarousels(carouselData.carousels || []);
        setBrand(brandData);
        if (!brandData.name || brandData.name.trim() === "") {
          setShowBrandSetup(true);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
  }>({ open: false, title: "", description: "", onConfirm: () => {} });

  const handleDelete = useCallback((e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    setConfirmState({
      open: true,
      title: `¿Eliminar "${name}"?`,
      description: "Se borra el carrusel y todas sus láminas. No se puede deshacer.",
      onConfirm: async () => {
        const res = await fetch(`/api/carousels/${id}`, { method: "DELETE" });
        if (res.ok) {
          setCarousels((prev) => prev.filter((c) => c.id !== id));
        }
      },
    });
  }, []);

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [activeTab, setActiveTab] = useState<"carousels" | "templates">("carousels");

  /**
   * Buscador. "En el open carrusel no hay organización de carruseles como el HOME de
   * Canva (o historial)": con decenas de piezas, una reja sin filtro obliga a abrir
   * carruseles al azar para encontrar uno — y abrir el equivocado es justo lo que
   * enreda. Filtra en cliente porque la lista ya está entera en memoria.
   */
  const [query, setQuery] = useState("");
  const visibles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return carousels;
    return carousels.filter((c) => c.name.toLowerCase().includes(q));
  }, [carousels, query]);

  /** Renombrar en la propia tarjeta: el nombre es la única forma de encontrarlo después. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const commitRename = useCallback(
    async (id: string) => {
      const nombre = renameValue.trim();
      setRenaming(null);
      const actual = carousels.find((c) => c.id === id);
      if (!nombre || !actual || nombre === actual.name) return;
      // Optimista: el PUT es un write chico y la tarjeta ya muestra el nombre nuevo.
      setCarousels((prev) => prev.map((c) => (c.id === id ? { ...c, name: nombre } : c)));
      const res = await fetch(`/api/carousels/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nombre }),
      });
      if (!res.ok) {
        setCarousels((prev) => prev.map((c) => (c.id === id ? { ...c, name: actual.name } : c)));
      }
    },
    [renameValue, carousels]
  );

  const handleCreate = useCallback(async (name: string, aspectRatio: string) => {
    const res = await fetch("/api/carousels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        aspectRatio,
      }),
    });
    if (res.ok) {
      const carousel = await res.json();
      router.push(`/carousel/${carousel.id}`);
    }
  }, [router]);

  return (
    <div className="h-full flex flex-col">
      <TopBar onSettingsClick={() => setShowBrandSetup(true)} />

      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => setConfirmState((s) => ({ ...s, open }))}
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel="Eliminar"
        variant="destructive"
        onConfirm={confirmState.onConfirm}
      />

      <CreateCarouselDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreate={handleCreate}
      />

      <BrandSetup
        open={showBrandSetup}
        onComplete={() => {
          setShowBrandSetup(false);
          fetch("/api/brand")
            .then((r) => r.json())
            .then((data) => setBrand(data))
            .catch(() => {});
        }}
        initialBrand={brand || undefined}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold">Open Carrusel</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Tus carruseles. Los de 30x viven en el tablero y la Biblioteca.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/biblioteca">
                <Button variant="outline">Biblioteca 30x</Button>
              </Link>
              <Link href="/30x">
                <Button variant="outline">Carruseles 30x</Button>
              </Link>
              <Button onClick={() => setShowCreateDialog(true)} variant="accent">
                <Plus className="h-4 w-4" />
                Nuevo carrusel
              </Button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-6 border-b border-border">
            <button
              onClick={() => setActiveTab("carousels")}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "carousels"
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Mis carruseles
            </button>
            <button
              onClick={() => setActiveTab("templates")}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "templates"
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Plantillas
            </button>
          </div>

          {/* Buscador. Solo cuando hay lo suficiente como para perder algo de vista. */}
          {activeTab === "carousels" && carousels.length > 5 && (
            <div className="relative mb-5">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Buscar entre ${carousels.length} carruseles…`}
                className="h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent/60"
              />
            </div>
          )}

          {activeTab === "templates" ? (
            <TemplateGallery />
          ) : loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-48 rounded-xl bg-muted animate-pulse"
                />
              ))}
            </div>
          ) : carousels.length === 0 ? (
            <div className="text-center py-20">
              <Layers className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h2 className="text-lg font-semibold mb-2">Todavía no hay carruseles</h2>
              <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
                Creá el primero y el asistente te ayuda a armar las láminas.
              </p>
              <Button onClick={() => setShowCreateDialog(true)} variant="accent" size="lg">
                <Plus className="h-5 w-5" />
                Crear el primero
              </Button>
            </div>
          ) : visibles.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
              Ningún carrusel se llama así.
            </p>
          ) : (
            <div className="oc-stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibles.map((carousel) => (
                <div
                  key={carousel.id}
                  onClick={() => router.push(`/carousel/${carousel.id}`)}
                  className="relative text-left rounded-xl border border-border bg-surface hover:border-accent/50 hover:shadow-md hover:-translate-y-0.5 p-4 group cursor-pointer transition-[translate,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]"
                >
                  {/* Card actions */}
                  <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const res = await fetch(`/api/carousels/${carousel.id}/duplicate`, { method: "POST" });
                        if (res.ok) {
                          const dup = await res.json();
                          setCarousels((prev) => [dup, ...prev]);
                        }
                      }}
                      className="h-7 w-7 rounded-lg flex items-center justify-center bg-white border border-border hover:bg-muted"
                      aria-label={`Duplicar ${carousel.name}`}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameValue(carousel.name);
                        setRenaming(carousel.id);
                      }}
                      className="h-7 w-7 rounded-lg flex items-center justify-center bg-white border border-border hover:bg-muted"
                      aria-label={`Renombrar ${carousel.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, carousel.id, carousel.name)}
                      className="h-7 w-7 rounded-lg flex items-center justify-center bg-white border border-border hover:bg-destructive hover:text-white hover:border-destructive"
                      aria-label={`Eliminar ${carousel.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="h-28 rounded-lg bg-muted mb-3 flex items-center justify-center overflow-hidden">
                    {carousel.slides.length > 0 ? (
                      <SlideRenderer
                        html={carousel.slides[0].html}
                        aspectRatio={carousel.aspectRatio}
                        className="w-full h-full"
                      />
                    ) : (
                      <Layers className="h-8 w-8 text-muted-foreground/30" />
                    )}
                  </div>
                  {renaming === carousel.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(carousel.id)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitRename(carousel.id);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="w-full rounded border border-accent/60 bg-background px-1.5 py-0.5 text-sm font-semibold outline-none"
                    />
                  ) : (
                    <h3 className="font-semibold text-sm group-hover:text-accent transition-colors truncate">
                      {carousel.name}
                    </h3>
                  )}
                  <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="text-[10px]">
                      <SlidersHorizontal className="h-2.5 w-2.5 mr-1" />
                      {carousel.aspectRatio}
                    </Badge>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {new Date(carousel.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
