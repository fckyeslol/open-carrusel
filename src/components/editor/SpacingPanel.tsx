"use client";

import { useState } from "react";
import { Link, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";

/** Los cuatro lados de una caja CSS, en el orden en que se leen en el panel. */
export interface BoxSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type BoxName = "padding" | "margin";
export type BoxSide = keyof BoxSides | "all";

interface SpacingPanelProps {
  padding: BoxSides;
  margin: BoxSides;
  /**
   * El elemento está posicionado en absoluto. El margen externo ahí solo lo corre,
   * que es exactamente lo que ya hacen X/Y: se avisa para no mandar a la diseñadora
   * a pelear dos controles por lo mismo.
   */
  absolute?: boolean;
  onChange: (box: BoxName, side: BoxSide, value: number) => void;
}

const SIDE_LABEL: Record<keyof BoxSides, string> = {
  top: "Arriba",
  right: "Derecha",
  bottom: "Abajo",
  left: "Izquierda",
};

/**
 * Campo de un lado. Vacío se lee como 0 en vez de NaN: al borrar el contenido
 * para escribir otro número el elemento no tiene que saltar a un valor absurdo.
 */
function SideField({
  value,
  label,
  min,
  onChange,
}: {
  value: number;
  label: string;
  min?: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={min}
      step={4}
      title={label}
      aria-label={label}
      value={Math.round(value)}
      onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))}
      className="h-9 w-full rounded-md border border-border bg-background px-1.5 text-center text-sm tabular-nums"
    />
  );
}

/**
 * Cruz de cuatro lados (arriba / izquierda · derecha / abajo), la misma forma que
 * usan Figma y Canva: se lee de un vistazo qué lado toca cada campo. El eslabón
 * ata los cuatro para el caso común de "más aire por todos lados".
 */
function BoxCross({
  box,
  title,
  hint,
  sides,
  min,
  onChange,
}: {
  box: BoxName;
  title: string;
  hint: string;
  sides: BoxSides;
  min?: number;
  onChange: (side: BoxSide, value: number) => void;
}) {
  const [linked, setLinked] = useState(true);
  const set = (side: keyof BoxSides, v: number) => onChange(linked ? "all" : side, v);
  const uniform =
    sides.top === sides.right && sides.right === sides.bottom && sides.bottom === sides.left;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <button
          type="button"
          onClick={() => setLinked((v) => !v)}
          title={
            linked
              ? "Los cuatro lados cambian juntos — clic para editarlos por separado"
              : "Cada lado por separado — clic para atarlos"
          }
          aria-pressed={linked}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors",
            linked
              ? "border-accent bg-accent/10 text-accent"
              : "border-border text-muted-foreground hover:text-foreground"
          )}
        >
          {linked ? <Link className="h-3.5 w-3.5" /> : <Unlink className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="grid grid-cols-3 items-center gap-1">
        <div />
        <SideField value={sides.top} label={SIDE_LABEL.top} min={min} onChange={(v) => set("top", v)} />
        <div />
        <SideField value={sides.left} label={SIDE_LABEL.left} min={min} onChange={(v) => set("left", v)} />
        <div
          className={cn(
            "flex h-9 items-center justify-center rounded-md border border-dashed text-[10px] leading-none",
            box === "padding" ? "border-border/80" : "border-border/50"
          )}
          title={hint}
        >
          {linked && uniform ? `${Math.round(sides.top)}px` : "px"}
        </div>
        <SideField value={sides.right} label={SIDE_LABEL.right} min={min} onChange={(v) => set("right", v)} />
        <div />
        <SideField
          value={sides.bottom}
          label={SIDE_LABEL.bottom}
          min={min}
          onChange={(v) => set("bottom", v)}
        />
        <div />
      </div>
    </div>
  );
}

/**
 * Márgenes del elemento seleccionado: relleno interno (el aire entre el texto y
 * el borde de su caja) y margen externo (la separación con lo que tiene al lado).
 *
 * Son dos cosas distintas y las diseñadoras necesitan las dos: el relleno para que
 * un titular no quede pegado al borde de su recuadro de color, y el margen para
 * abrir espacio entre bloques apilados sin sacarlos del flujo a mano.
 */
export function SpacingPanel({ padding, margin, absolute, onChange }: SpacingPanelProps) {
  return (
    <div className="space-y-3">
      <BoxCross
        box="padding"
        title="Margen interno"
        hint="Aire entre el contenido y el borde de su propia caja"
        sides={padding}
        min={0}
        onChange={(side, v) => onChange("padding", side, v)}
      />
      <p className="text-[10px] leading-snug text-muted-foreground">
        El relleno crece <b>hacia adentro</b>: la caja se queda donde está y el texto gana
        aire. Si el elemento no tiene ancho fijo, la caja se agranda.
      </p>

      <BoxCross
        box="margin"
        title="Margen externo"
        hint="Separación con los elementos de al lado"
        sides={margin}
        onChange={(side, v) => onChange("margin", side, v)}
      />
      <p className="text-[10px] leading-snug text-muted-foreground">
        {absolute ? (
          <>
            Este elemento está <b>posicionado libre</b>: el margen externo solo lo corre, lo
            mismo que hacen X e Y. Para separarlo de otro bloque conviene mover ese otro.
          </>
        ) : (
          <>
            Abre espacio con los bloques de al lado <b>sin sacarlo del flujo</b>. Ojo: si
            después lo arrastrás, pasa a posición libre y el margen vuelve a 0.
          </>
        )}
      </p>
    </div>
  );
}
