"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Loader2,
  Check,
  ChevronDown,
  FileImage,
  FileText,
  Code2,
  Shapes,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  allPages,
  pageFileSuffix,
  parsePageSelection,
  type PageSelection,
} from "@/lib/page-selection";
import { ExportPageScope, type PageScope } from "./ExportPageScope";

interface ExportButtonProps {
  carouselId: string;
  carouselName: string;
  slideCount: number;
  /** Lámina activa (1-based): es la que exporta la opción "Esta lámina". */
  activeSlideNumber: number;
}

/** Pausa entre descargas para que el navegador no bloquee los archivos en ráfaga. */
const DOWNLOAD_GAP_MS = 400;

type FormatId = "png" | "png-alpha" | "pdf" | "html" | "svg";

interface FormatOption {
  id: FormatId;
  label: string;
  hint: string;
  icon: typeof FileImage;
}

const FORMATS: FormatOption[] = [
  {
    id: "png",
    label: "PNG — láminas sueltas",
    hint: "Un .png por lámina, tamaño IG exacto",
    icon: FileImage,
  },
  {
    id: "png-alpha",
    label: "PNG — sin fondo",
    hint: "Transparente: quita color/degradado/textura de fondo, deja el contenido",
    icon: FileImage,
  },
  {
    id: "pdf",
    label: "PDF",
    hint: "Un solo PDF, texto editable (Acrobat, Illustrator, Canva)",
    icon: FileText,
  },
  {
    id: "html",
    label: "HTML — editable",
    hint: "Un HTML autocontenido con las láminas apiladas",
    icon: Code2,
  },
  {
    id: "svg",
    label: "SVG — láminas sueltas",
    hint: "Un .svg por lámina (edición vectorial limitada)",
    icon: Shapes,
  },
];

/** Dispara la descarga de un blob con el nombre dado. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Menú de exportación multi-formato. Arriba se eligen las LÁMINAS y abajo el formato,
 * como en Canva: la selección es una sola y vale para todos los formatos. PNG y SVG bajan
 * un archivo por lámina seleccionada (bucle); PDF y HTML bajan un solo archivo con ellas.
 */
export function ExportButton({
  carouselId,
  carouselName,
  slideCount,
  activeSlideNumber,
}: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [done, setDone] = useState(false);
  const [scope, setScope] = useState<PageScope>("all");
  const [customInput, setCustomInput] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  // Las tres opciones terminan en lo mismo: una lista de láminas 1-based. Se parsea con el
  // mismo módulo que usa la ruta, así lo que la UI habilita es exactamente lo que el
  // servidor acepta.
  const selection = useMemo<PageSelection>(() => {
    if (slideCount === 0) return { ok: false, error: "El carrusel no tiene láminas" };
    if (scope === "all") return { ok: true, pages: allPages(slideCount) };
    const input = scope === "current" ? String(activeSlideNumber) : customInput;
    return parsePageSelection(input, slideCount);
  }, [scope, customInput, slideCount, activeSlideNumber]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const safeName = carouselName.replace(/[^a-zA-Z0-9-_]/g, "_") || carouselId;

  /**
   * Un archivo por lámina seleccionada. El nombre lleva el número REAL de la lámina, no
   * el del bucle: exportar "3, 7" tiene que dar `slide-3` y `slide-7`.
   */
  const exportPerSlide = async (
    format: "png" | "svg",
    pages: number[],
    opts: { transparent?: boolean } = {}
  ) => {
    const suffix = opts.transparent ? "-sin-fondo" : "";
    const query = opts.transparent ? "&transparent=1" : "";
    setProgress({ current: 0, total: pages.length });
    for (const [i, slide] of pages.entries()) {
      const response = await fetch(
        `/api/carousels/${carouselId}/export?format=${format}&pages=${slide}${query}`,
        { method: "POST" }
      );
      if (!response.ok) throw new Error(`Export failed on slide ${slide}`);
      const blob = await response.blob();
      downloadBlob(blob, `${safeName}-slide-${slide}${suffix}.${format}`);
      setProgress({ current: i + 1, total: pages.length });
      if (i < pages.length - 1) {
        await new Promise((r) => setTimeout(r, DOWNLOAD_GAP_MS));
      }
    }
  };

  /** Un solo archivo con todas las láminas seleccionadas (PDF, HTML). */
  const exportSingleFile = async (
    format: "pdf" | "html",
    pages: number[]
  ) => {
    setProgress({ current: 0, total: 1 });
    const response = await fetch(
      `/api/carousels/${carouselId}/export?format=${format}&pages=${pages.join(",")}`,
      { method: "POST" }
    );
    if (!response.ok) throw new Error("Export failed");
    const blob = await response.blob();
    downloadBlob(
      blob,
      `${safeName}${pageFileSuffix(pages, slideCount)}.${format}`
    );
    setProgress({ current: 1, total: 1 });
  };

  const runExport = async (id: FormatId) => {
    if (exporting || !selection.ok) return;
    const { pages } = selection;
    setOpen(false);
    setExporting(true);
    setDone(false);

    try {
      switch (id) {
        case "png":
          await exportPerSlide("png", pages);
          break;
        case "png-alpha":
          await exportPerSlide("png", pages, { transparent: true });
          break;
        case "svg":
          await exportPerSlide("svg", pages);
          break;
        case "pdf":
          await exportSingleFile("pdf", pages);
          break;
        case "html":
          await exportSingleFile("html", pages);
          break;
      }
      setDone(true);
    } catch (error) {
      console.error("Export error:", error);
    } finally {
      setExporting(false);
      setTimeout(() => setDone(false), 3000);
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <Button
        onClick={() => setOpen((v) => !v)}
        disabled={exporting || slideCount === 0}
        variant="accent"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span
          key={exporting ? "exporting" : done ? "done" : "idle"}
          className="oc-enter-pop inline-flex items-center gap-2"
        >
          {exporting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {progress.current}/{progress.total}
              </span>
            </>
          ) : done ? (
            <>
              <Check className="h-4 w-4" />
              <span>¡Descargado!</span>
            </>
          ) : (
            <>
              <Download className="h-4 w-4" />
              <span>Exportar</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </>
          )}
        </span>
      </Button>

      {open && !exporting && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-surface pb-1.5 shadow-xl"
        >
          <ExportPageScope
            scope={scope}
            onScopeChange={setScope}
            customInput={customInput}
            onCustomInputChange={setCustomInput}
            slideCount={slideCount}
            activeSlideNumber={activeSlideNumber}
            selection={selection}
          />

          <div className="p-1.5">
            {FORMATS.map((f) => {
              const Icon = f.icon;
              return (
                <button
                  key={f.id}
                  role="menuitem"
                  onClick={() => runExport(f.id)}
                  disabled={!selection.ok}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                    "hover:bg-accent/10 focus:bg-accent/10 focus:outline-none",
                    "disabled:pointer-events-none disabled:opacity-40"
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium leading-tight">
                      {f.label}
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      {f.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
