"use client";

import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

interface SafeZoneOverlayProps {
  aspectRatio: AspectRatio;
  visible: boolean;
}

// Padding firme de 108px por lado — lateral, arriba y abajo — medido sobre el
// lienzo real (1080px de ancho). Todo lo que viva DENTRO de este recuadro es la
// "zona segura": no se recorta en el grid ni queda tapado por la UI de Instagram.
// El texto siempre debe quedar acá adentro.
const SAFE_PADDING_PX = 108;

export function SafeZoneOverlay({ aspectRatio, visible }: SafeZoneOverlayProps) {
  if (!visible) return null;

  const { width, height } = DIMENSIONS[aspectRatio];

  // El overlay se estira al 100% del lienzo escalado, así que convertimos los
  // 108px a porcentaje de cada eje. Así el recuadro corresponde a exactamente
  // 108px reales en la exportación sin importar el zoom del preview.
  const padX = (SAFE_PADDING_PX / width) * 100;
  const padY = (SAFE_PADDING_PX / height) * 100;

  return (
    <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
      {/* Recuadro de zona segura. El box-shadow gigante hacia afuera oscurece
          todo el margen de 108px, dejando claro visualmente dónde NO poner
          contenido; el overflow-hidden del contenedor recorta la sombra al
          borde del lienzo. */}
      <div
        className="absolute rounded-sm border border-dashed border-emerald-400/80"
        style={{
          left: `${padX}%`,
          right: `${padX}%`,
          top: `${padY}%`,
          bottom: `${padY}%`,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.28)",
        }}
      >
        <span className="absolute -top-[19px] left-0 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-medium text-emerald-200">
          Zona segura · 108px
        </span>
      </div>
    </div>
  );
}
