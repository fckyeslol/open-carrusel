"use client";

import { useState } from "react";
import { Download, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ExportButtonProps {
  carouselId: string;
  carouselName: string;
  slideCount: number;
}

/** Pausa entre descargas para que el navegador no bloquee los .png en ráfaga. */
const DOWNLOAD_GAP_MS = 400;

/**
 * Exporta el carrusel como archivos PNG sueltos (uno por lámina), nunca ZIP.
 * En carruseles de varias láminas el navegador puede pedir permiso para
 * "descargar varios archivos" — se acepta una vez y quedan todos en Descargas.
 */
export function ExportButton({
  carouselId,
  carouselName,
  slideCount,
}: ExportButtonProps) {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [done, setDone] = useState(false);

  const handleExport = async () => {
    if (exporting || slideCount === 0) return;
    setExporting(true);
    setDone(false);
    setProgress({ current: 0, total: slideCount });

    const safeName =
      carouselName.replace(/[^a-zA-Z0-9-_]/g, "_") || carouselId;

    try {
      for (let slide = 1; slide <= slideCount; slide++) {
        const response = await fetch(
          `/api/carousels/${carouselId}/export?slide=${slide}`,
          { method: "POST" }
        );

        if (!response.ok) {
          throw new Error(`Export failed on slide ${slide}`);
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}-slide-${slide}.png`;
        a.click();
        URL.revokeObjectURL(url);

        setProgress({ current: slide, total: slideCount });

        if (slide < slideCount) {
          await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
        }
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
    <Button
      onClick={handleExport}
      disabled={exporting || slideCount === 0}
      variant="accent"
      size="sm"
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
            <span>Exportar PNG</span>
          </>
        )}
      </span>
    </Button>
  );
}
