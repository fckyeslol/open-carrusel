"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2, Grid3X3, Bookmark, Maximize2, Pencil, PanelLeft, Undo2, Redo2 } from "lucide-react";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CarouselPreview } from "@/components/editor/CarouselPreview";
import { VisualEditor } from "@/components/editor/VisualEditor";
import { SlideFilmstrip } from "@/components/editor/SlideFilmstrip";
import { AspectRatioSelector } from "@/components/editor/AspectRatioSelector";
import { ResizeButton } from "@/components/editor/ResizeButton";
import { ExportButton } from "@/components/editor/ExportButton";
import { CaptionPanel } from "@/components/editor/CaptionPanel";
import { FullscreenPreview } from "@/components/editor/FullscreenPreview";
import { SaveState } from "@/components/editor/SaveState";
import type { Carousel, AspectRatio, Slide } from "@/types/carousel";
import type { StylePreset } from "@/types/style-preset";
import { paletteFromBrandColors, type PaletteColor } from "@/lib/adn-palette";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CarouselEditorPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const [carousel, setCarousel] = useState<Carousel | null>(null);
  // Paleta del ADN del avatar activo: muestras de un clic en el editor visual.
  const [palette, setPalette] = useState<PaletteColor[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [activeSlide, setActiveSlide] = useState(0);
  const [claudeAvailable, setClaudeAvailable] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // Se incrementa al deshacer/rehacer para forzar el remonte del editor visual
  // (que captura el HTML solo al montarse) y reflejar la versión restaurada.
  const [editorNonce, setEditorNonce] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error" | "stale">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Espejo en vivo del HTML editado por lámina (slideId → html). Es un ref para
  // no re-renderizar la tira en cada tecla; sirve para que el fullscreen muestre
  // lo que estás editando ahora y no la versión anterior del carrusel.
  const liveEditsRef = useRef<Record<string, string>>({});

  // Última edición que el server todavía no confirmó. Permite "flushear" el
  // guardado pendiente (salida del modo edición, cierre de la página) en vez de
  // perder los últimos 600 ms de trabajo por el debounce.
  const pendingSaveRef = useRef<{ slideId: string; html: string } | null>(null);
  // Cadena de PUTs: garantiza que los guardados llegan al server EN ORDEN.
  // Sin esto, un flush podía adelantarse a un PUT en vuelo y una versión vieja
  // pisaba a la nueva.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  const putSlide = useCallback(
    (slideId: string, newHtml: string, keepalive = false) => {
      saveChainRef.current = saveChainRef.current.then(async () => {
        try {
          const res = await fetch(`/api/carousels/${id}/slides/${slideId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ html: newHtml }),
            // keepalive: el guardado sobrevive aunque la página se esté cerrando
            keepalive,
          });
          // 404 = la lámina ya no existe (el carrusel cambió por fuera). Antes esto
          // fallaba en silencio y se perdía todo lo editado.
          if (!res.ok) throw new Error(res.status === 404 ? "stale" : `HTTP ${res.status}`);
          setSaveState("saved");
        } catch (e) {
          setSaveState((e as Error).message === "stale" ? "stale" : "error");
        }
      });
      return saveChainRef.current;
    },
    [id]
  );

  // Dispara YA el guardado pendiente (si lo hay) y devuelve su promesa.
  const flushPendingSave = useCallback(
    (keepalive = false) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const pending = pendingSaveRef.current;
      if (!pending) return Promise.resolve();
      pendingSaveRef.current = null;
      return putSlide(pending.slideId, pending.html, keepalive);
    },
    [putSlide]
  );

  // Guarda el HTML editado (debounced). CLAVE para la fluidez: NO tocamos el
  // estado de React mientras se edita — hacerlo re-renderizaba los 7 iframes de
  // la tira en cada micro-cambio y era la principal fuente de jank. La tira se
  // refresca al salir del modo edición.
  const handleSlideHtmlChange = useCallback(
    (slideId: string, newHtml: string) => {
      liveEditsRef.current[slideId] = newHtml;
      pendingSaveRef.current = { slideId, html: newHtml };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveState("saving");
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        const pending = pendingSaveRef.current;
        if (!pending) return;
        pendingSaveRef.current = null;
        putSlide(pending.slideId, pending.html);
      }, 600);
    },
    [putSlide]
  );

  // Si la página se cierra o recarga con un guardado pendiente, lo mandamos con
  // keepalive: sin esto los últimos 600 ms de edición se perdían al navegar.
  useEffect(() => {
    const onPageHide = () => {
      flushPendingSave(true);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      // desmontaje por navegación interna: mismo flush, sin keepalive
      flushPendingSave();
    };
  }, [flushPendingSave]);
  const [showFullscreen, setShowFullscreen] = useState(false);
  // Snapshot de láminas para el fullscreen. Se calcula al abrir fusionando las
  // ediciones en vivo, así "expandir" refleja el estado actual y no el guardado.
  const [fullscreenSlides, setFullscreenSlides] = useState<Slide[] | null>(null);

  const openFullscreen = useCallback(() => {
    // Solo en modo edición hace falta el snapshot: fuera de él, carousel.slides
    // ya es la fuente de verdad y conviene pasarlo vivo (la IA puede seguir
    // agregando láminas mientras el fullscreen está abierto).
    const edits = liveEditsRef.current;
    setFullscreenSlides(
      editMode && carousel
        ? carousel.slides.map((s) =>
            edits[s.id] != null ? { ...s, html: edits[s.id] } : s
          )
        : null
    );
    setShowFullscreen(true);
  }, [editMode, carousel]);
  // Generación 30x: mensaje a auto-enviar al chat cuando el carrusel viene de un
  // referente recién ingestado (la /30x guarda el mensaje en sessionStorage).
  const [autoGenMsg, setAutoGenMsg] = useState<string | undefined>(undefined);

  useEffect(() => {
    try {
      const msg = sessionStorage.getItem(`autogen-${id}`);
      if (msg) {
        setAutoGenMsg(msg);
        sessionStorage.removeItem(`autogen-${id}`); // one-shot
      }
    } catch {
      // sessionStorage no disponible
    }
  }, [id]);

  // Confirm dialog state
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
  }>({ open: false, title: "", description: "", onConfirm: () => {} });

  // Ref for focusing chat input when + button is clicked
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  const fetchCarousel = useCallback(async (focusSlideId?: string) => {
    try {
      const res = await fetch(`/api/carousels/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setCarousel((prev) => {
          // Si se pidió enfocar una lámina concreta (agregar/duplicar), saltamos
          // a ella en vez de al final: una duplicada se inserta en el medio.
          const focusIdx = focusSlideId
            ? data.slides.findIndex((s: Slide) => s.id === focusSlideId)
            : -1;
          if (focusIdx !== -1) {
            setActiveSlide(focusIdx);
          } else if (prev && data.slides.length > prev.slides.length) {
            // If new slides were added during generation, jump to the latest slide
            setActiveSlide(data.slides.length - 1);
          } else {
            setActiveSlide((prevIdx) =>
              data.slides.length === 0 ? 0 : Math.min(prevIdx, data.slides.length - 1)
            );
          }
          return data;
        });
      }
    } catch {
      // ignore network errors
    }
  }, [id]);

  // Paleta del ADN: buscamos el preset del avatar de este carrusel y derivamos
  // sus 5 colores para ofrecerlos como muestras en el editor. Si no hay preset
  // (carrusel suelto sin avatar), el editor simplemente no muestra swatches.
  const stylePresetId = carousel?.stylePresetId;
  useEffect(() => {
    if (!stylePresetId) {
      setPalette([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/style-presets");
        if (!res.ok) return;
        const data = await res.json();
        const preset = (data.presets as StylePreset[] | undefined)?.find(
          (p) => p.id === stylePresetId
        );
        if (!cancelled) setPalette(paletteFromBrandColors(preset?.brand?.colors));
      } catch {
        // Sin paleta el editor sigue funcionando; no es un error bloqueante.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stylePresetId]);

  // Al salir del modo edición, refrescamos el carrusel (actualiza la tira) y
  // descartamos las ediciones en vivo: el servidor ya es la fuente de verdad y
  // un snapshot viejo no debe pisar contenido regenerado después.
  // El flush va PRIMERO y se espera: sin eso, el fetch le ganaba la carrera al
  // PUT debounced y la vista recargaba la versión anterior de la lámina (el
  // clásico "centré el logo, salí, y apareció movido").
  useEffect(() => {
    if (!editMode) {
      let cancelled = false;
      flushPendingSave().then(() => {
        if (cancelled) return;
        liveEditsRef.current = {};
        fetchCarousel();
      });
      return () => {
        cancelled = true;
      };
    }
  }, [editMode, fetchCarousel, flushPendingSave]);

  // Initial data load
  useEffect(() => {
    const load = async () => {
      await fetchCarousel();
      try {
        const res = await fetch("/api/chat/check");
        const data: { available?: boolean } = await res.json();
        if (data.available === false) setClaudeAvailable(false);
      } catch {
        // assume available
      }
    };
    load();
  }, [fetchCarousel]);

  // Poll for carousel updates while AI is generating slides
  useEffect(() => {
    if (!isGenerating) return;
    const interval = setInterval(() => {
      fetchCarousel();
    }, 500);
    return () => clearInterval(interval);
  }, [isGenerating, fetchCarousel]);

  const handleAspectChange = async (ratio: AspectRatio) => {
    if (!carousel) return;
    const res = await fetch(`/api/carousels/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aspectRatio: ratio }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCarousel(updated);
    }
  };

  const handleDeleteSlide = (slideId: string) => {
    if (!carousel) return;
    const slideIndex = carousel.slides.findIndex((s) => s.id === slideId);
    setConfirmState({
      open: true,
      title: `Delete slide ${slideIndex + 1}?`,
      description: "This action cannot be undone.",
      onConfirm: async () => {
        const res = await fetch(`/api/carousels/${id}/slides/${slideId}`, {
          method: "DELETE",
        });
        if (res.ok) await fetchCarousel();
      },
    });
  };

  // Deshacer / rehacer sobre el historial persistido de una lámina.
  // Flush primero: garantiza que el server tenga la última edición antes de
  // mover el puntero del historial, así el Ctrl+Z retrocede desde el estado real.
  const runSlideHistory = useCallback(
    async (slideId: string, action: "undo" | "redo") => {
      await flushPendingSave();
      const res = await fetch(`/api/carousels/${id}/slides/${slideId}/${action}`, {
        method: "POST",
      });
      if (!res.ok) return;
      // La edición en vivo quedó obsoleta: el server es la fuente de verdad.
      delete liveEditsRef.current[slideId];
      setEditorNonce((n) => n + 1);
      await fetchCarousel();
    },
    [id, flushPendingSave, fetchCarousel]
  );

  const handleUndoSlide = useCallback(
    (slideId: string) => runSlideHistory(slideId, "undo"),
    [runSlideHistory]
  );

  const handleRedoSlide = useCallback(
    (slideId: string) => runSlideHistory(slideId, "redo"),
    [runSlideHistory]
  );

  // Atajos globales de deshacer/rehacer sobre la lámina activa. En modo edición
  // NO se enganchan: el editor visual maneja su propio Ctrl+Z a nivel de elemento.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editMode || !carousel) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
        return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const active = carousel.slides[activeSlide];
      if (!active) return;
      const wantRedo = key === "y" || (key === "z" && e.shiftKey);
      const wantUndo = key === "z" && !e.shiftKey;
      if (wantRedo) {
        if ((active.redoVersions?.length ?? 0) > 0) {
          e.preventDefault();
          handleRedoSlide(active.id);
        }
      } else if (wantUndo) {
        if (active.previousVersions.length > 0) {
          e.preventDefault();
          handleUndoSlide(active.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, carousel, activeSlide, handleUndoSlide, handleRedoSlide]);

  const handleDeleteCarousel = useCallback(() => {
    if (!carousel) return;
    setConfirmState({
      open: true,
      title: `Delete "${carousel.name}"?`,
      description: "This will permanently delete the carousel and all its slides.",
      onConfirm: async () => {
        const res = await fetch(`/api/carousels/${id}`, { method: "DELETE" });
        if (res.ok) router.push("/");
      },
    });
  }, [carousel, id, router]);

  const handleStreamStart = useCallback(() => {
    setIsGenerating(true);
  }, []);

  const handleStreamEnd = useCallback(() => {
    setIsGenerating(false);
    fetchCarousel();
  }, [fetchCarousel]);

  const handleReorderSlides = useCallback(
    async (slideIds: string[]) => {
      await fetch(`/api/carousels/${id}/slides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slideIds }),
      });
      await fetchCarousel();
    },
    [id, fetchCarousel]
  );

  const handleAddBlankSlide = useCallback(async () => {
    const res = await fetch(`/api/carousels/${id}/slides`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blank: true }),
    });
    if (res.ok) {
      const slide: Slide = await res.json();
      await fetchCarousel(slide.id);
    }
  }, [id, fetchCarousel]);

  const handleDuplicateSlide = useCallback(
    async (slideId: string) => {
      const res = await fetch(
        `/api/carousels/${id}/slides/${slideId}/duplicate`,
        { method: "POST" }
      );
      if (res.ok) {
        const slide: Slide = await res.json();
        await fetchCarousel(slide.id);
      }
    },
    [id, fetchCarousel]
  );

  if (notFound) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <p className="text-lg font-semibold">Carousel not found</p>
        <p className="text-sm text-muted-foreground">
          This carousel may have been deleted.
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (!carousel) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="h-8 w-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <TopBar
        title={carousel.name}
        showBack
        editable
        onTitleChange={async (name) => {
          const res = await fetch(`/api/carousels/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (res.ok) {
            const updated = await res.json();
            setCarousel(updated);
          }
        }}
      />

      {/* Fullscreen preview */}
      <FullscreenPreview
        open={showFullscreen}
        onOpenChange={(open) => {
          setShowFullscreen(open);
          if (!open) setFullscreenSlides(null);
        }}
        slides={fullscreenSlides ?? carousel.slides}
        aspectRatio={carousel.aspectRatio}
        activeIndex={activeSlide}
        onActiveChange={setActiveSlide}
      />

      {/* Confirm dialog */}
      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => setConfirmState((s) => ({ ...s, open }))}
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmState.onConfirm}
      />

      {/* Main editor area */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Chat panel */}
        {chatOpen && (
          <div className="oc-fade w-80 border-r border-border shrink-0 flex flex-col bg-surface">
            <ChatPanel
              carouselId={id}
              claudeAvailable={claudeAvailable}
              referenceImages={carousel.referenceImages || []}
              onStreamStart={handleStreamStart}
              onStreamEnd={handleStreamEnd}
              chatInputRef={chatInputRef}
              autoSendMessage={autoGenMsg}
            />
          </div>
        )}

        {/* Right side: toolbar + preview */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Toolbar */}
          <div className="h-12 border-b border-border bg-surface flex items-center px-4 gap-2 shrink-0">
            <AspectRatioSelector
              value={carousel.aspectRatio}
              onChange={handleAspectChange}
            />

            <ResizeButton
              carouselId={id}
              aspectRatio={carousel.aspectRatio}
              slideCount={carousel.slides.length}
            />

            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />

            <Button
              variant={editMode ? "default" : "outline"}
              size="sm"
              onClick={() => setEditMode((v) => !v)}
              aria-pressed={editMode}
              title="Editor visual"
            >
              <Pencil className="h-3.5 w-3.5" />
              {editMode ? "Editando" : "Editar"}
            </Button>

            {editMode && saveState !== "idle" && <SaveState state={saveState} />}

            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />

            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const active = carousel.slides[activeSlide];
                if (active) handleUndoSlide(active.id);
              }}
              // En modo edición el estado no se refresca en cada guardado (por
              // rendimiento), así que el conteo puede estar viejo: dejamos deshacer
              // siempre disponible ahí y el server decide si hay algo que deshacer.
              disabled={!editMode && !carousel.slides[activeSlide]?.previousVersions.length}
              className="text-muted-foreground"
              aria-label="Deshacer"
              title="Deshacer (Ctrl+Z)"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const active = carousel.slides[activeSlide];
                if (active) handleRedoSlide(active.id);
              }}
              disabled={!carousel.slides[activeSlide]?.redoVersions?.length}
              className="text-muted-foreground"
              aria-label="Rehacer"
              title="Rehacer (Ctrl+Shift+Z)"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </Button>

            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={openFullscreen}
              className="text-muted-foreground"
              aria-label="Fullscreen preview"
              title="Fullscreen preview"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={showSafeZones ? "outline" : "ghost"}
              size="sm"
              onClick={() => setShowSafeZones(!showSafeZones)}
              aria-pressed={showSafeZones}
              className={
                showSafeZones
                  ? "border-foreground/30 bg-muted text-foreground"
                  : "text-muted-foreground"
              }
              aria-label="Zonas seguras de Instagram"
              title="Zonas seguras de Instagram"
            >
              <Grid3X3 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await fetch("/api/templates", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ carouselId: carousel.id }),
                });
              }}
              className="text-muted-foreground"
              aria-label="Guardar como plantilla"
              title="Guardar como plantilla"
            >
              <Bookmark className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDeleteCarousel}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Eliminar carrusel"
              title="Eliminar carrusel"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>

            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setChatOpen(!chatOpen)}
              aria-pressed={chatOpen}
              className="text-muted-foreground"
              title={chatOpen ? "Ocultar el chat" : "Mostrar el chat"}
            >
              <PanelLeft className="h-3.5 w-3.5" />
              {chatOpen ? "Ocultar chat" : "Mostrar chat"}
            </Button>
            <ExportButton
              carouselId={carousel.id}
              carouselName={carousel.name}
              slideCount={carousel.slides.length}
              activeSlideNumber={activeSlide + 1}
            />
          </div>

          {/* Preview / Editor visual */}
          {editMode && carousel.slides[activeSlide] ? (
            <VisualEditor
              key={`${carousel.slides[activeSlide].id}:${editorNonce}`}
              // Prioriza la edición en vivo: al cambiar de lámina y volver (el
              // editor se remonta), carousel.slides trae el HTML de ANTES de
              // entrar al modo edición — montarlo pisaría lo recién editado.
              html={
                liveEditsRef.current[carousel.slides[activeSlide].id] ??
                carousel.slides[activeSlide].html
              }
              aspectRatio={carousel.aspectRatio}
              onChange={(newHtml) =>
                handleSlideHtmlChange(carousel.slides[activeSlide].id, newHtml)
              }
              showSafeZones={showSafeZones}
              palette={palette}
            />
          ) : (
            <CarouselPreview
              slides={carousel.slides}
              aspectRatio={carousel.aspectRatio}
              activeIndex={activeSlide}
              onActiveChange={setActiveSlide}
              showSafeZones={showSafeZones}
            />
          )}

          {/* Caption panel */}
          <CaptionPanel
            caption={carousel.caption}
            hashtags={carousel.hashtags}
          />
        </div>
      </div>

      {/* Filmstrip */}
      <SlideFilmstrip
        slides={carousel.slides}
        aspectRatio={carousel.aspectRatio}
        activeIndex={activeSlide}
        onActiveChange={setActiveSlide}
        onDeleteSlide={handleDeleteSlide}
        onUndoSlide={handleUndoSlide}
        onDuplicateSlide={handleDuplicateSlide}
        onAddBlankSlide={handleAddBlankSlide}
        onReorderSlides={handleReorderSlides}
        isGenerating={isGenerating}
      />
    </div>
  );
}
