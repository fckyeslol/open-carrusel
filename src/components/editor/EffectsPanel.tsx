"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ColorInput } from "./ColorInput";
import type { PaletteColor } from "@/lib/adn-palette";
import { cn } from "@/lib/utils";

/**
 * Un efecto de filtro: se aplica sobre el elemento y RESPETA su silueta (una foto
 * con transparencia no queda con el efecto pintado en el rectángulo).
 */
export const FX_FILTERS = [
  { id: "grain", label: "Granulado", hint: "Grano de película fino, parejo" },
  { id: "noise", label: "Ruido", hint: "Moteado más grueso y visible" },
  { id: "duotone", label: "Duotono", hint: "Dos colores: sombras y luces" },
  { id: "chromatic", label: "Aberración", hint: "Aberración cromática: canales corridos" },
  { id: "emboss", label: "Relieve", hint: "Emboss: la imagen como grabada" },
  { id: "bevel", label: "Bisel", hint: "Borde biselado con luz diagonal" },
  { id: "motion", label: "Motion blur", hint: "Barrido en un eje (gira con el elemento)" },
  { id: "distort", label: "Distorsión", hint: "Deformación orgánica de la silueta" },
] as const;

/** Superficies: capa vinculada ENCIMA del elemento (material, vidrio, scanlines). */
export const FX_SURFACES = [
  { id: "frost", label: "Vidrio", hint: "Frost: difumina lo que se ve a través" },
  { id: "radial", label: "Desenf. radial", hint: "Centro nítido, bordes difuminados" },
  { id: "crt", label: "CRT", hint: "Scanlines de tubo + franja de color" },
] as const;

/** Materiales horneados (los mismos PNG que las texturas de lámina). */
export const FX_MATERIALS = [
  { slug: "granulado", label: "Grano" },
  { slug: "papel-fino", label: "Papel fino" },
  { slug: "papel-rugoso", label: "Papel rugoso" },
  { slug: "papel-arrugado", label: "Papel arrugado" },
  { slug: "carton", label: "Cartón" },
  { slug: "halftone", label: "Halftone" },
  { slug: "cuadricula", label: "Cuadrícula" },
  { slug: "frost", label: "Escarcha" },
] as const;

type FxValue = number | { i?: number; a?: string; b?: string; slug?: string; base?: string };

interface EffectsPanelProps {
  /** Efectos de filtro activos, tal como los reporta el runtime. */
  fx: Record<string, FxValue>;
  /** Capas de superficie activas (por kind). */
  fxLayers: Record<string, unknown>;
  /** Es una imagen subida: habilita el pixelado (se hornea en el servidor). */
  canPixelate: boolean;
  pixelBusy?: boolean;
  pixelError?: string | null;
  onFx: (kind: string, value: FxValue | null) => void;
  onFxLayer: (kind: string, value: FxValue | null) => void;
  onClear: () => void;
  onPixelate: (amount: number) => void;
  swatches?: PaletteColor[];
}

const labelCls = "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

/** Intensidad guardada de un efecto (los efectos con color guardan un objeto). */
function amountOf(v: FxValue | undefined, fallback = 50): number {
  if (v == null) return fallback;
  if (typeof v === "number") return v;
  return v.i ?? fallback;
}

export function EffectsPanel({
  fx,
  fxLayers,
  canPixelate,
  pixelBusy,
  pixelError,
  onFx,
  onFxLayer,
  onClear,
  onPixelate,
  swatches,
}: EffectsPanelProps) {
  // Colores del duotono y del material elegido: el runtime los guarda dentro del
  // efecto, pero mientras está apagado hay que ofrecer un punto de partida.
  const duo = typeof fx.duotone === "object" ? fx.duotone : undefined;
  const [duoA, setDuoA] = useState(duo?.a ?? "#15142B");
  const [duoB, setDuoB] = useState(duo?.b ?? "#EBFF6F");
  const [material, setMaterial] = useState<string>("granulado");
  const [materialAmt, setMaterialAmt] = useState(60);
  const [pixelAmt, setPixelAmt] = useState(40);

  const activos =
    Object.keys(fx).length + Object.keys(fxLayers).length;

  /** Fila de un efecto: botón de encendido + intensidad cuando está activo. */
  const FxRow = ({
    id,
    label,
    hint,
    active,
    onToggle,
    onAmount,
    amount,
    children,
  }: {
    id: string;
    label: string;
    hint: string;
    active: boolean;
    onToggle: () => void;
    onAmount: (v: number) => void;
    amount: number;
    children?: React.ReactNode;
  }) => (
    <div
      key={id}
      className={cn(
        "rounded-md border p-1.5",
        active ? "border-accent bg-accent/5" : "border-border"
      )}
    >
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant={active ? "accent" : "outline"}
          className="flex-1 justify-start"
          title={hint}
          onClick={onToggle}
        >
          {label}
        </Button>
        {active && <span className="w-9 shrink-0 text-right text-[10px] tabular-nums">{amount}%</span>}
      </div>
      {active && (
        <>
          <input
            type="range"
            min={0}
            max={100}
            value={amount}
            onChange={(e) => onAmount(Number(e.target.value))}
            className="mt-1 w-full accent-accent"
          />
          {children}
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-muted-foreground leading-snug">
        Todos los efectos son CSS/SVG, así que el PNG exportado sale igual que el
        preview. Los <b>filtros</b> respetan la silueta del elemento; las{" "}
        <b>superficies</b> son una capa encima que queda pegada a él.
      </p>

      <span className={labelCls}>Filtros</span>
      <div className="grid gap-1">
        {FX_FILTERS.map((f) => {
          const active = fx[f.id] != null;
          const amount = amountOf(fx[f.id]);
          const send = (i: number) =>
            f.id === "duotone"
              ? onFx(f.id, { i, a: duoA, b: duoB })
              : onFx(f.id, i);
          return (
            <FxRow
              key={f.id}
              id={f.id}
              label={f.label}
              hint={f.hint}
              active={active}
              amount={amount}
              onToggle={() => (active ? onFx(f.id, null) : send(f.id === "duotone" ? 100 : 50))}
              onAmount={send}
            >
              {f.id === "duotone" && (
                <div className="mt-1.5 space-y-1.5">
                  <ColorInput
                    title="Color de las sombras"
                    value={duoA}
                    swatches={swatches}
                    onChange={(hex) => {
                      setDuoA(hex);
                      onFx("duotone", { i: amount, a: hex, b: duoB });
                    }}
                  />
                  <ColorInput
                    title="Color de las luces"
                    value={duoB}
                    swatches={swatches}
                    onChange={(hex) => {
                      setDuoB(hex);
                      onFx("duotone", { i: amount, a: duoA, b: hex });
                    }}
                  />
                </div>
              )}
            </FxRow>
          );
        })}
      </div>

      <span className={labelCls}>Superficies</span>
      <div className="grid gap-1">
        {FX_SURFACES.map((f) => {
          const active = fxLayers[f.id] != null;
          return (
            <FxRow
              key={f.id}
              id={f.id}
              label={f.label}
              hint={f.hint}
              active={active}
              amount={amountOf(undefined, 55)}
              onToggle={() => onFxLayer(f.id, active ? null : 55)}
              onAmount={(i) => onFxLayer(f.id, i)}
            />
          );
        })}
      </div>

      {/* Material: una sola capa, con el PNG elegido. */}
      <div
        className={cn(
          "rounded-md border p-1.5",
          fxLayers.material != null ? "border-accent bg-accent/5" : "border-border"
        )}
      >
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={fxLayers.material != null ? "accent" : "outline"}
            className="flex-1 justify-start"
            title="Papel, cartón, grano, halftone o cuadrícula sobre el elemento"
            onClick={() =>
              fxLayers.material != null
                ? onFxLayer("material", null)
                : onFxLayer("material", { i: materialAmt, slug: material })
            }
          >
            Material
          </Button>
          <span className="w-9 shrink-0 text-right text-[10px] tabular-nums">{materialAmt}%</span>
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-1">
          {FX_MATERIALS.map((m) => (
            <Button
              key={m.slug}
              size="sm"
              variant={material === m.slug ? "accent" : "outline"}
              onClick={() => {
                setMaterial(m.slug);
                onFxLayer("material", { i: materialAmt, slug: m.slug });
              }}
            >
              {m.label}
            </Button>
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={materialAmt}
          onChange={(e) => {
            const i = Number(e.target.value);
            setMaterialAmt(i);
            onFxLayer("material", { i, slug: material });
          }}
          className="mt-1 w-full accent-accent"
        />
      </div>

      {/* Pixelado: el único que se hornea en el servidor (no hay primitiva de
          submuestreo en filtros SVG). Solo para imágenes subidas. */}
      <div className="rounded-md border border-border p-1.5">
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 justify-start"
            disabled={!canPixelate || pixelBusy}
            title={
              canPixelate
                ? "Rehornea la imagen en bloques. Queda en el historial de versiones."
                : "Solo para imágenes subidas"
            }
            onClick={() => onPixelate(pixelAmt)}
          >
            {pixelBusy ? "Pixelando…" : "Pixelar"}
          </Button>
          <span className="w-9 shrink-0 text-right text-[10px] tabular-nums">{pixelAmt}%</span>
        </div>
        <input
          type="range"
          min={1}
          max={100}
          value={pixelAmt}
          onChange={(e) => setPixelAmt(Number(e.target.value))}
          disabled={!canPixelate}
          className="mt-1 w-full accent-accent"
        />
        {!canPixelate && (
          <p className="text-[10px] text-muted-foreground leading-snug">
            Disponible solo en imágenes subidas: se genera un archivo nuevo, así el
            export sale idéntico al preview.
          </p>
        )}
        {pixelError && <p className="text-xs text-red-600">{pixelError}</p>}
      </div>

      {activos > 0 && (
        <Button size="sm" variant="outline" className="w-full" onClick={onClear}>
          Quitar todos los efectos ({activos})
        </Button>
      )}
    </div>
  );
}
