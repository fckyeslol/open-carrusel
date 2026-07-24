"use client";

import { useEffect, useRef, useState } from "react";
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

interface ExportButtonProps {
  carouselId: string;
  carouselName: string;
  slideCount: number;
  /** Lámina activa (1-based) para el "PDF de la lámina actual". */
  activeSlideNumber: number;
}

/** Pausa entre descargas para que el navegador no bloquee los archivos en ráfaga. */
const DOWNLOAD_GAP_MS = 400;

type FormatId = "png" | "pdf-all" | "pdf-one" | "html" | "svg";

interface FormatOption {
  id: FormatId;
  label: string;
  hint: string;
  icon: typeof FileImage;
  /** true = un archivo por lámina (bucle); false = un solo archivo por carrusel. */
  perSlide: boolean;
}

const FORMATS: FormatOption[] = [
  {
    id: "png",
    label: "PNG — láminas sueltas",
    hint: "Un .png por lámina, tamaño IG exacto",
    icon: FileImage,
    perSlide: true,
  },
  {
    id: "pdf-all",
    label: "PDF — carrusel completo",
    hint: "Un PDF, texto editable (Acrobat, Illustrator, Canva)",
    icon: FileText,
    perSlide: false,
  },
  {
    id: "pdf-one",
    label: "PDF — lámina actual",
    hint: "Solo la lámina en pantalla, en su propio PDF",
    icon: FileText,
    perSlide: false,
  },
  {
    id: "html",
    label: "HTML — editable",
    hint: "Un HTML autocontenido con todas las láminas",
    icon: Code2,
    perSlide: false,
  },
  {
    id: "svg",
    label: "SVG — láminas sueltas",
    hint: "Un .svg por lámina (edición vectorial limitada)",
    icon: Shapes,
    perSlide: true,
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
 * Menú de exportación multi-formato. PNG y SVG bajan un archivo por lámina
 * (bucle, como antes); PDF y HTML bajan un solo archivo por carrusel.
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
  const menuRef = useRef<HTMLDivElement>(null);

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

  const exportPerSlide = async (format: "png" | "svg") => {
    const ext = format;
    setProgress({ current: 0, total: slideCount });
    for (let slide = 1; slide <= slideCount; slide++) {
      const response = await fetch(
        `/api/carousels/${carouselId}/export?format=${format}&slide=${slide}`,
        { method: "POST" }
      );
      if (!response.ok) throw new Error(`Export failed on slide ${slide}`);
      const blob = await response.blob();
      downloadBlob(blob, `${safeName}-slide-${slide}.${ext}`);
      setProgress({ current: slide, total: slideCount });
      if (slide < slideCount) {
        await new Promise((r) => setTimeout(r, DOWNLOAD_GAP_MS));
      }
    }
  };

  const exportSingleFile = async (
    query: string,
    ext: string,
    suffix = ""
  ) => {
    setProgress({ current: 0, total: 1 });
    const response = await fetch(
      `/api/carousels/${carouselId}/export?${query}`,
      { method: "POST" }
    );
    if (!response.ok) throw new Error("Export failed");
    const blob = await response.blob();
    downloadBlob(blob, `${safeName}${suffix}.${ext}`);
    setProgress({ current: 1, total: 1 });
  };

  const runExport = async (id: FormatId) => {
    if (exporting || slideCount === 0) return;
    setOpen(false);
    setExporting(true);
    setDone(false);

    try {
      switch (id) {
        case "png":
          await exportPerSlide("png");
          break;
        case "svg":
          await exportPerSlide("svg");
          break;
        case "pdf-all":
          await exportSingleFile("format=pdf", "pdf");
          break;
        case "pdf-one":
          await exportSingleFile(
            `format=pdf&slide=${activeSlideNumber}`,
            "pdf",
            `-slide-${activeSlideNumber}`
          );
          break;
        case "html":
          await exportSingleFile("format=html", "html");
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
          className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-surface p-1.5 shadow-xl"
        >
          {FORMATS.map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.id}
                role="menuitem"
                onClick={() => runExport(f.id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                  "hover:bg-accent/10 focus:bg-accent/10 focus:outline-none"
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
      )}
    </div>
  );
}
