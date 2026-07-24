"use client";

import {
  DndContext,
  closestCenter,
  useSensor,
  useSensors,
  PointerSensor,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Type, Image as ImageIcon, Shapes, Group, Square } from "lucide-react";
import { cn } from "@/lib/utils";

/** Una capa reportada por el runtime del iframe (orden: frente → fondo). */
export interface LayerItem {
  id: string;
  kind: "text" | "image" | "shape" | "group" | "box";
  label: string;
  selected: boolean;
}

interface LayerPanelProps {
  layers: LayerItem[];
  /** Selecciona la capa en el lienzo. */
  onSelect: (id: string) => void;
  /** Nuevo orden completo (frente → fondo) tras arrastrar. */
  onReorder: (ids: string[]) => void;
}

const KIND_ICON = {
  text: Type,
  image: ImageIcon,
  shape: Shapes,
  group: Group,
  box: Square,
} as const;

function LayerRow({
  layer,
  onSelect,
}: {
  layer: LayerItem;
  onSelect: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: layer.id });
  const Icon = KIND_ICON[layer.kind] ?? Square;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-xs transition-colors",
        layer.selected
          ? "border-accent bg-accent/10 text-foreground"
          : "border-border bg-background text-foreground/80 hover:bg-accent/5"
      )}
    >
      <button
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
        aria-label="Reordenar capa"
        title="Arrastrar para reordenar"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onSelect(layer.id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={layer.label}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{layer.label}</span>
      </button>
    </div>
  );
}

/**
 * Lista de capas del slide (de arriba/frente hacia abajo/fondo). Clic selecciona;
 * arrastrar reordena. Refleja en vivo lo que reporta el runtime del iframe.
 */
export function LayerPanel({ layers, onSelect, onReorder }: LayerPanelProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = layers.map((l) => l.id);
    const from = ids.indexOf(active.id as string);
    const to = ids.indexOf(over.id as string);
    if (from === -1 || to === -1) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
  };

  if (layers.length === 0) {
    return (
      <p className="py-1 text-[10px] text-muted-foreground leading-snug">
        No hay elementos en esta lámina todavía.
      </p>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={layers.map((l) => l.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1">
          {layers.map((layer) => (
            <LayerRow key={layer.id} layer={layer} onSelect={onSelect} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
