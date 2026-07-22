"use client";

import { useState } from "react";
import { Presentation, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ExportPptxButtonProps {
  carouselId: string;
  carouselName: string;
  slideCount: number;
}

/**
 * Exporta el carrusel a .pptx (contenido-first) para importar en Canva y que las
 * diseñadoras rematen el diseño ahí. Objetos editables: texto, imágenes, fondos.
 */
export function ExportPptxButton({
  carouselId,
  carouselName,
  slideCount,
}: ExportPptxButtonProps) {
  const [exporting, setExporting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);

  const handleExport = async () => {
    if (exporting || slideCount === 0) return;
    setExporting(true);
    setDone(false);
    setError(false);

    try {
      const response = await fetch(
        `/api/carousels/${carouselId}/export-pptx`,
        { method: "POST" }
      );

      if (!response.ok) {
        throw new Error("Export failed");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const safeName = carouselName.replace(/[^a-zA-Z0-9-_]/g, "_") || carouselId;
      const a = document.createElement("a");
      a.href = url;
      a.download = `carousel-${safeName}.pptx`;
      a.click();
      URL.revokeObjectURL(url);
      setDone(true);
    } catch (err) {
      console.error("PPTX export error:", err);
      setError(true);
    } finally {
      setExporting(false);
      setTimeout(() => {
        setDone(false);
        setError(false);
      }, 3000);
    }
  };

  return (
    <Button
      onClick={handleExport}
      disabled={exporting || slideCount === 0}
      variant="outline"
      size="sm"
      title="Exportar a .pptx para editar en Canva"
    >
      <span
        key={exporting ? "exporting" : done ? "done" : error ? "error" : "idle"}
        className="oc-enter-pop inline-flex items-center gap-2"
      >
        {exporting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Generando…</span>
          </>
        ) : done ? (
          <>
            <Check className="h-4 w-4" />
            <span>Listo!</span>
          </>
        ) : error ? (
          <span>Error — reintenta</span>
        ) : (
          <>
            <Presentation className="h-4 w-4" />
            <span>Exportar a Canva</span>
          </>
        )}
      </span>
    </Button>
  );
}
