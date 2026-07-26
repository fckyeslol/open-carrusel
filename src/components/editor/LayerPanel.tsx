"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  GripVertical,
  Type,
  Image as ImageIcon,
  Shapes,
  Group,
  Square,
  ChevronRight,
  ChevronDown,
  Lock,
  LockOpen,
  Eye,
  EyeOff,
  ChevronUp,
  ChevronsUp,
  ChevronsDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Una capa reportada por el runtime del iframe (orden: frente → fondo). */
export interface LayerItem {
  id: string;
  kind: "text" | "image" | "shape" | "group" | "box";
  label: string;
  selected: boolean;
  locked?: boolean;
  hidden?: boolean;
  /** Miembros de un grupo o hijos de un contenedor (también frente → fondo). */
  children?: LayerItem[];
}

export type LayerDir = "front" | "back" | "up" | "down";

interface LayerPanelProps {
  layers: LayerItem[];
  /** Selecciona la capa en el lienzo. */
  onSelect: (id: string) => void;
  /** Nuevo orden de UN nivel (frente → fondo) tras arrastrar. */
  onReorder: (ids: string[]) => void;
  onMove: (id: string, dir: LayerDir) => void;
  onToggle: (id: string, flag: "lock" | "hide", value: boolean) => void;
  onRename: (id: string, name: string) => void;
}

const KIND_ICON = {
  text: Type,
  image: ImageIcon,
  shape: Shapes,
  group: Group,
  box: Square,
} as const;

/** Todas las listas de hermanos del árbol, indexadas por el id de cada fila. */
function siblingIndex(items: LayerItem[], into: Map<string, string[]> = new Map()) {
  const ids = items.map((i) => i.id);
  for (const it of items) {
    into.set(it.id, ids);
    if (it.children?.length) siblingIndex(it.children, into);
  }
  return into;
}

interface RowProps extends Omit<LayerPanelProps, "layers" | "onReorder"> {
  layer: LayerItem;
  depth: number;
  /** Ids cuyo estado abierto/cerrado el usuario invirtió respecto del default. */
  flipped: Set<string>;
  toggleOpen: (id: string) => void;
}

/** Los grupos se muestran abiertos por defecto; los contenedores, cerrados. */
function isExpanded(layer: LayerItem, flipped: Set<string>) {
  const byDefault = layer.kind === "group";
  return flipped.has(layer.id) ? !byDefault : byDefault;
}

function LayerRow({
  layer,
  depth,
  flipped,
  toggleOpen,
  onSelect,
  onMove,
  onToggle,
  onRename,
}: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: layer.id });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(layer.label);
  const inputRef = useRef<HTMLInputElement>(null);
  const Icon = KIND_ICON[layer.kind] ?? Square;
  const kids = layer.children ?? [];
  const expanded = isExpanded(layer, flipped);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== layer.label) onRename(layer.id, next);
  };

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <div
        className={cn(
          "group/row flex items-center gap-1 rounded-md border px-1 py-1 text-xs transition-colors",
          layer.selected
            ? "border-accent bg-accent/10 text-foreground"
            : "border-border bg-background text-foreground/80 hover:bg-accent/5",
          layer.hidden && "opacity-50"
        )}
        style={{ marginLeft: depth * 10 }}
      >
        <button
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
          aria-label="Reordenar capa"
          title="Arrastrar para reordenar dentro de su nivel"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>

        {kids.length > 0 ? (
          <button
            type="button"
            onClick={() => toggleOpen(layer.id)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={expanded ? "Contraer" : "Expandir"}
            title={expanded ? "Contraer" : "Expandir"}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(layer.label);
                setEditing(false);
              }
            }}
            className="min-w-0 flex-1 rounded border border-accent bg-background px-1 py-0.5 text-xs"
          />
        ) : (
          <button
            type="button"
            onClick={() => onSelect(layer.id)}
            onDoubleClick={() => {
              setDraft(layer.label);
              setEditing(true);
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={`${layer.label} — doble clic para renombrar`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className={cn("truncate", layer.hidden && "line-through")}>{layer.label}</span>
          </button>
        )}

        {/* Acciones: aparecen al pasar el mouse; bloqueo y visibilidad quedan
            siempre visibles cuando están activos, para verlos de un vistazo. */}
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => onMove(layer.id, "front")}
            className="hidden text-muted-foreground hover:text-foreground group-hover/row:block"
            title="Traer al frente del todo"
            aria-label="Traer al frente"
          >
            <ChevronsUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMove(layer.id, "up")}
            className="hidden text-muted-foreground hover:text-foreground group-hover/row:block"
            title="Subir una capa"
            aria-label="Subir una capa"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMove(layer.id, "down")}
            className="hidden text-muted-foreground hover:text-foreground group-hover/row:block"
            title="Bajar una capa"
            aria-label="Bajar una capa"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMove(layer.id, "back")}
            className="hidden text-muted-foreground hover:text-foreground group-hover/row:block"
            title="Enviar al fondo del todo"
            aria-label="Enviar al fondo"
          >
            <ChevronsDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onToggle(layer.id, "hide", !layer.hidden)}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              !layer.hidden && "hidden group-hover/row:block"
            )}
            title={layer.hidden ? "Mostrar (no sale en el export mientras está oculta)" : "Ocultar"}
            aria-label={layer.hidden ? "Mostrar capa" : "Ocultar capa"}
          >
            {layer.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => onToggle(layer.id, "lock", !layer.locked)}
            className={cn(
              "hover:text-foreground",
              layer.locked ? "text-accent" : "hidden text-muted-foreground group-hover/row:block"
            )}
            title={layer.locked ? "Desbloquear" : "Bloquear (no se mueve ni se edita)"}
            aria-label={layer.locked ? "Desbloquear capa" : "Bloquear capa"}
          >
            {layer.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
          </button>
        </span>
      </div>

      {expanded && kids.length > 0 && (
        <LayerLevel
          layers={kids}
          depth={depth + 1}
          flipped={flipped}
          toggleOpen={toggleOpen}
          onSelect={onSelect}
          onMove={onMove}
          onToggle={onToggle}
          onRename={onRename}
        />
      )}
    </div>
  );
}

/** Un nivel de hermanos: su propio SortableContext, así el arrastre no cruza niveles. */
function LayerLevel({
  layers,
  depth,
  ...rest
}: Omit<RowProps, "layer"> & { layers: LayerItem[] }) {
  return (
    <SortableContext items={layers.map((l) => l.id)} strategy={verticalListSortingStrategy}>
      <div className="mt-1 flex flex-col gap-1">
        {layers.map((l) => (
          <LayerRow key={l.id} layer={l} depth={depth} {...rest} />
        ))}
      </div>
    </SortableContext>
  );
}

/**
 * Árbol de capas del slide (frente → fondo). Clic selecciona; doble clic renombra;
 * arrastrar reordena dentro del nivel. Los grupos y los contenedores se expanden.
 * Refleja en vivo lo que reporta el runtime del iframe.
 */
export function LayerPanel({
  layers,
  onSelect,
  onReorder,
  onMove,
  onToggle,
  onRename,
}: LayerPanelProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );
  // Los grupos arrancan abiertos (es lo que la diseñadora acaba de armar) y los
  // contenedores cerrados. En vez de sembrar ese default en un efecto — que
  // dispara renders en cascada cada vez que el runtime reporta capas — se guardan
  // solo los ids que el usuario cambió respecto del default.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const siblings = useMemo(() => siblingIndex(layers), [layers]);

  const toggleOpen = (id: string) =>
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = siblings.get(active.id as string);
    // Soltar en otro nivel no reordena nada: cada nivel es su propia lista.
    if (!ids || !ids.includes(over.id as string)) return;
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
      <LayerLevel
        layers={layers}
        depth={0}
        flipped={flipped}
        toggleOpen={toggleOpen}
        onSelect={onSelect}
        onMove={onMove}
        onToggle={onToggle}
        onRename={onRename}
      />
    </DndContext>
  );
}
