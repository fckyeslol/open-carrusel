"use client";

import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { wrapSlideHtml } from "@/lib/slide-html";
import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

interface SlideRendererProps {
  html: string;
  aspectRatio: AspectRatio;
  className?: string;
  style?: React.CSSProperties;
}

export function SlideRenderer({
  html,
  aspectRatio,
  className,
  style,
}: SlideRendererProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const { width: slideW, height: slideH } = DIMENSIONS[aspectRatio];

  const srcDoc = useMemo(
    () => wrapSlideHtml(html, aspectRatio),
    [html, aspectRatio]
  );

  const measure = useCallback(() => {
    const el = outerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setDims({ w: rect.width, h: rect.height });
    }
  }, []);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => measure());
    obs.observe(el);
    measure();
    return () => obs.disconnect();
  }, [measure]);

  // Escala para encajar la lámina en el contenedor.
  const rawScale = dims ? Math.min(dims.w / slideW, dims.h / slideH) : 0;

  // NITIDEZ: el box se redondea a enteros y la escala se RE-DERIVA de ese box.
  // Antes el contenedor usaba Math.floor() mientras el iframe se escalaba con el
  // factor sin redondear: el contenido caía en coordenadas fraccionarias y el
  // borde sangraba medio píxel, que es lo que se veía "borroso".
  const scaledW = Math.round(slideW * rawScale);
  const scaledH = Math.round(slideH * rawScale);
  const scaleX = scaledW / slideW;
  const scaleY = scaledH / slideH;
  const scale = rawScale;

  return (
    <div
      ref={outerRef}
      className={className}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      {scale > 0 && (
        <div
          style={{
            width: scaledW,
            height: scaledH,
            overflow: "hidden",
            borderRadius: 8,
            position: "relative",
            boxShadow: "0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)",
            border: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <iframe
            sandbox=""
            srcDoc={srcDoc}
            title="Slide preview"
            style={{
              width: slideW,
              height: slideH,
              border: "none",
              // Dos ejes: garantiza que el contenido cubra el box EXACTO. La
              // diferencia entre scaleX y scaleY es <0.1% (invisible) y elimina
              // la costura de subpíxel del borde.
              transform: `scale(${scaleX}, ${scaleY})`,
              transformOrigin: "top left",
              position: "absolute",
              top: 0,
              left: 0,
              pointerEvents: "none",
            }}
          />
        </div>
      )}
    </div>
  );
}
