"use client";

import { useRef, useState } from "react";
import { Check, Copy as CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PaletteColor } from "@/lib/adn-palette";

/** Normaliza '#abc', '#aabbcc' o 'rgb(r,g,b)' a '#aabbcc'; null si no es un color reconocible. */
export function toHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const short = /^#?([0-9a-f]{3})$/.exec(v);
  if (short) {
    const [r, g, b] = short[1];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const long = /^#?([0-9a-f]{6})$/.exec(v);
  if (long) return `#${long[1]}`;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
  if (rgb) {
    const to2 = (n: string) =>
      Math.min(255, Number(n)).toString(16).padStart(2, "0");
    return `#${to2(rgb[1])}${to2(rgb[2])}${to2(rgb[3])}`;
  }
  return null;
}

interface ColorInputProps {
  value?: string;
  onChange: (hex: string) => void;
  title?: string;
  className?: string;
  /** Muestras de un clic (paleta del ADN del avatar). Se pintan bajo el campo. */
  swatches?: PaletteColor[];
}

/**
 * Selector de color con campo HEX editable: el cuadrito abre el picker nativo
 * y el texto permite copiar el HEX o pegar uno (con o sin '#', 3 o 6 dígitos).
 */
export function ColorInput({ value, onChange, title, className, swatches }: ColorInputProps) {
  const hex = toHex(value) ?? "#000000";
  // Mientras se escribe, mostramos el borrador; al salir volvemos al valor real.
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitText = (text: string) => {
    setDraft(text);
    const parsed = toHex(text);
    if (parsed) onChange(parsed);
  };

  const copyHex = async () => {
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // Sin permiso de clipboard: el usuario aún puede seleccionar el texto.
    }
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-1.5">
      <div className="relative h-9 w-10 shrink-0" title={title}>
        <input
          type="color"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={hex}
          onChange={(e) => {
            setDraft(null);
            onChange(e.target.value);
          }}
          aria-label={title || "Color"}
        />
        <div
          className="pointer-events-none h-full w-full rounded-md border border-border"
          style={{ backgroundColor: hex }}
        />
      </div>
      <input
        type="text"
        spellCheck={false}
        className="h-9 w-full min-w-0 rounded-md border border-border bg-background px-2 font-mono text-xs uppercase"
        value={draft ?? hex}
        placeholder="#000000"
        onChange={(e) => commitText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => setDraft(null)}
      />
      <button
        type="button"
        className="flex h-9 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground"
        title="Copiar HEX"
        onClick={copyHex}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <CopyIcon className="h-3.5 w-3.5" />}
      </button>
      </div>
      {swatches && swatches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {swatches.map((s) => {
            const swHex = s.hex.toLowerCase();
            const active = hex === swHex;
            return (
              <button
                key={swHex}
                type="button"
                onClick={() => {
                  setDraft(null);
                  onChange(swHex);
                }}
                title={`${s.name} · ${swHex.toUpperCase()}`}
                aria-label={`${s.name} ${swHex}`}
                aria-pressed={active}
                className={cn(
                  "h-6 w-6 shrink-0 rounded-md border transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-foreground/40",
                  active ? "border-foreground ring-2 ring-foreground/60" : "border-border"
                )}
                style={{ backgroundColor: swHex }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
