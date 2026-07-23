import type { ReactNode } from "react";

/**
 * Galería de formas del editor visual. Cada `id` tiene su definición real en
 * SHAPES dentro de src/lib/slide-editor.ts (runtime del iframe); acá vive solo
 * la miniatura del botón. Si agregás una forma, sumala en los dos lados.
 */
export interface ShapeDef {
  id: string;
  label: string;
  icon: ReactNode;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      {children}
    </svg>
  );
}

const fill = { fill: "currentColor" } as const;
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;

export const SHAPE_GALLERY: ShapeDef[] = [
  { id: "square", label: "Cuadrado", icon: <Icon><rect x="3" y="3" width="18" height="18" {...fill} /></Icon> },
  { id: "rounded", label: "Cuadrado redondeado", icon: <Icon><rect x="3" y="3" width="18" height="18" rx="5" {...fill} /></Icon> },
  { id: "circle", label: "Círculo", icon: <Icon><circle cx="12" cy="12" r="10" {...fill} /></Icon> },
  { id: "pill", label: "Píldora", icon: <Icon><rect x="2" y="8" width="20" height="8" rx="4" {...fill} /></Icon> },
  { id: "triangle", label: "Triángulo", icon: <Icon><polygon points="12,3 22,21 2,21" {...fill} /></Icon> },
  { id: "diamond", label: "Rombo", icon: <Icon><polygon points="12,2 22,12 12,22 2,12" {...fill} /></Icon> },
  { id: "pentagon", label: "Pentágono", icon: <Icon><polygon points="12,2 22,9.5 18,21 6,21 2,9.5" {...fill} /></Icon> },
  { id: "hexagon", label: "Hexágono", icon: <Icon><polygon points="7,3 17,3 22,12 17,21 7,21 2,12" {...fill} /></Icon> },
  { id: "star", label: "Estrella", icon: <Icon><polygon points="12,2 14.6,9 22,9 16.2,13.5 18.4,21 12,16.6 5.6,21 7.8,13.5 2,9 9.4,9" {...fill} /></Icon> },
  { id: "heart", label: "Corazón", icon: <Icon><path d="M12 21C5 16 2 12.5 2 8.8 2 5.9 4.2 4 6.6 4c2 0 3.9 1.1 5.4 3 1.5-1.9 3.4-3 5.4-3C19.8 4 22 5.9 22 8.8c0 3.7-3 7.2-10 12.2Z" {...fill} /></Icon> },
  { id: "arrow", label: "Flecha", icon: <Icon><polygon points="2,10 14,10 14,5 22,12 14,19 14,14 2,14" {...fill} /></Icon> },
  { id: "cross", label: "Cruz", icon: <Icon><polygon points="9,2 15,2 15,9 22,9 22,15 15,15 15,22 9,22 9,15 2,15 2,9 9,9" {...fill} /></Icon> },
  { id: "half", label: "Semicírculo", icon: <Icon><path d="M2 20A10 10 0 0 1 22 20Z" {...fill} /></Icon> },
  { id: "bubble", label: "Globo de diálogo", icon: <Icon><path d="M5 3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-8l-5 5 1-5H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" {...fill} /></Icon> },
  { id: "line", label: "Línea", icon: <Icon><line x1="2" y1="12" x2="22" y2="12" {...stroke} /></Icon> },
  { id: "lineDashed", label: "Línea discontinua", icon: <Icon><line x1="2" y1="12" x2="22" y2="12" {...stroke} strokeDasharray="4 3" /></Icon> },
  { id: "lineDotted", label: "Línea punteada", icon: <Icon><line x1="2" y1="12" x2="22" y2="12" {...stroke} strokeDasharray="0.5 4" strokeLinecap="round" /></Icon> },
  { id: "frame", label: "Marco", icon: <Icon><rect x="3" y="3" width="18" height="18" {...stroke} /></Icon> },
  { id: "frameRounded", label: "Marco redondeado", icon: <Icon><rect x="3" y="3" width="18" height="18" rx="5" {...stroke} /></Icon> },
  { id: "frameCircle", label: "Marco circular", icon: <Icon><circle cx="12" cy="12" r="9.5" {...stroke} /></Icon> },
];

/** Presets de sombra: ids que entiende el prop 'shadow' del runtime. */
export const SHADOW_PRESETS = [
  { id: "none", label: "Ninguna", title: "Quitar la sombra" },
  { id: "soft", label: "Suave", title: "Sombra difusa leve" },
  { id: "medium", label: "Media", title: "Sombra difusa media" },
  { id: "strong", label: "Intensa", title: "Sombra difusa marcada" },
  { id: "float", label: "Elevada", title: "Despega el elemento: se ve más arriba del fondo" },
  { id: "dots", label: "Puntos", title: "Capa de puntos halftone detrás (queda como elemento aparte)" },
] as const;

/** Degradados listos para aplicar de un clic. */
export const GRADIENT_PRESETS: { from: string; to: string; angle: number }[] = [
  { from: "#2A2320", to: "#C77E97", angle: 135 },
  { from: "#15142B", to: "#EBFF6F", angle: 135 },
  { from: "#0C1030", to: "#3A34E0", angle: 135 },
  { from: "#F97316", to: "#EC4899", angle: 135 },
  { from: "#0EA5E9", to: "#22D3EE", angle: 135 },
  { from: "#111827", to: "#4B5563", angle: 180 },
];
