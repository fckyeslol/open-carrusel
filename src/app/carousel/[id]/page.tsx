"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2, Grid3X3, Bookmark, Maximize2, Pencil, PanelLeft } from "lucide-react";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CarouselPreview } from "@/components/editor/CarouselPreview";
import { VisualEditor } from "@/components/editor/VisualEditor";
import { SlideFilmstrip } from "@/components/editor/SlideFilmstrip";
import { AspectRatioSelector } from "@/components/editor/AspectRatioSelector";
import { ExportButton } from "@/components/editor/ExportButton";
import { CaptionPanel } from "@/components/editor/CaptionPanel";
import { FullscreenPreview } from "@/components/editor/FullscreenPreview";
import { SaveState } from "@/components/editor/SaveState";
import type { Carousel, AspectRatio, Slide } from "@/types/carousel";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CarouselEditorPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const [carousel, setCarousel] = useState<Carousel | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [activeSlide, setActiveSlide] = useState(0);
  const [claudeAvailable, setClaudeAvailable] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error" | "stale">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Espejo en vivo del HTML editado por lámina (slideId → html). Es un ref para
  // no re-renderizar la tira en cada tecla; sirve para que el fullscreen muestre
  // lo que estás editando ahora y no la versión anterior del carrusel.
  const liveEditsRef = useRef<Record<string, string>>({});

  // Guarda el HTML editado (debounced). CLAVE para la fluidez: NO tocamos el
  // estado de React mientras se edita — hacerlo re-renderizaba los 7 iframes de
  // la tira en cada micro-cambio y era la principal fuente de jank. La tira se
  // refresca al salir del modo edición.
  const handleSlideHtmlChange = useCallback(
    (slideId: string, newHtml: string) => {
      liveEditsRef.current[slideId] = newHtml;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveState("saving");
      saveTimer.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/carousels/${id}/slides/${slideId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ html: newHtml }),
          });
          // 404 = la lámina ya no existe (el carrusel cambió por fuera). Antes esto
          // fallaba en silencio y se perdía todo lo editado.
          if (!res.ok) throw new Error(res.status === 404 ? "stale" : `HTTP ${res.status}`);
          setSaveState("saved");
        } catch (e) {
          setSaveState((e as Error).message === "stale" ? "stale" : "error");
        }
      }, 600);
    },
    [id]
  );
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

  const fetchCarousel = useCallback(async () => {
    try {
      const res = await fetch(`/api/carousels/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setCarousel((prev) => {
          // If new slides were added during generation, jump to the latest slide
          if (prev && data.slides.length > prev.slides.length) {
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

  // Al salir del modo edición, refrescamos el carrusel (actualiza la tira) y
  // descartamos las ediciones en vivo: el servidor ya es la fuente de verdad y
  // un snapshot viejo no debe pisar contenido regenerado después.
  useEffect(() => {
    if (!editMode) {
      liveEditsRef.current = {};
      fetchCarousel();
    }
  }, [editMode, fetchCarousel]);

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

  const handleUndoSlide = async (slideId: string) => {
    const res = await fetch(`/api/carousels/${id}/slides/${slideId}/undo`, {
      method: "POST",
    });
    if (res.ok) await fetchCarousel();
  };

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

  const handleAddSlideRequest = useCallback(() => {
    setChatOpen(true);
    // Focus chat input after a tick (to let panel render)
    setTimeout(() => {
      chatInputRef.current?.focus();
    }, 100);
  }, []);

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
            />
          </div>

          {/* Preview / Editor visual */}
          {editMode && carousel.slides[activeSlide] ? (
            <VisualEditor
              key={carousel.slides[activeSlide].id}
              html={carousel.slides[activeSlide].html}
              aspectRatio={carousel.aspectRatio}
              onChange={(newHtml) =>
                handleSlideHtmlChange(carousel.slides[activeSlide].id, newHtml)
              }
              showSafeZones={showSafeZones}
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
        onAddSlideRequest={handleAddSlideRequest}
        onReorderSlides={handleReorderSlides}
        isGenerating={isGenerating}
      />
    </div>
  );
}
