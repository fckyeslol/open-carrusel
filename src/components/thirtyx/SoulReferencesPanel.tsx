"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UserRoundPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SoulReference {
  id: string;
  nombre: string;
  estado: string;
}

/** Mismos topes que src/lib/higgsfield.ts, para avisar antes de mandar. */
const MIN_FOTOS = 3;
const MAX_FOTOS = 20;

/**
 * Referencias de persona (SoulIds) para que una persona REAL salga con su cara.
 *
 * Una imagen de referencia normal le da a Soul el encuadre y la luz, no la cara: pedir
 * "Elon Musk" pasando su foto devolvía a alguien parecido pero distinto, y la diseñadora
 * terminaba buscando la imagen a mano — el trabajo que la herramienta venía a sacarle.
 *
 * Se carga una vez por persona y sirve para todos los carruseles: por eso vive en /30x
 * junto a las claves, y no en el editor de una lámina.
 */
export function SoulReferencesPanel({ configurado }: { configurado: boolean }) {
  const [refs, setRefs] = useState<SoulReference[]>([]);
  const [nombre, setNombre] = useState("");
  const [fotos, setFotos] = useState<File[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async () => {
    if (!configurado) return;
    try {
      const res = await fetch("/api/soul-references");
      const data = await res.json();
      setRefs(data.referencias || []);
    } catch {
      /* listar es informativo: sin conexión, el panel queda vacío y ya */
    }
  }, [configurado]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const crear = useCallback(async () => {
    setError(null);
    setAviso(null);
    if (!nombre.trim()) return setError("Ponele un nombre (con eso la vas a elegir después).");
    if (fotos.length < MIN_FOTOS)
      return setError(
        `Hacen falta al menos ${MIN_FOTOS} fotos de la persona. Con menos, el parecido no se ` +
          `sostiene entre generaciones.`
      );

    setSubiendo(true);
    try {
      const fd = new FormData();
      fd.append("nombre", nombre.trim());
      for (const f of fotos) fd.append("fotos", f);
      const res = await fetch("/api/soul-references", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "No se pudo crear la referencia.");
        return;
      }
      setAviso(data.aviso || "Referencia creada.");
      setNombre("");
      setFotos([]);
      if (fileRef.current) fileRef.current.value = "";
      await cargar();
    } catch {
      setError("Error de red al crear la referencia.");
    } finally {
      setSubiendo(false);
    }
  }, [nombre, fotos, cargar]);

  if (!configurado) return null;

  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-center gap-2">
        <UserRoundPlus className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Personas reales
        </h3>
      </div>
      <p className="mt-1 mb-3 text-xs text-muted-foreground">
        Para que una persona identificable salga con SU cara y no con una parecida. Cargá{" "}
        {MIN_FOTOS}–{MAX_FOTOS} fotos de la misma persona (ángulos, luces y expresiones
        distintas) una sola vez: después el agente la usa en cualquier carrusel.
      </p>

      {refs.length > 0 && (
        <ul className="mb-4 space-y-1.5">
          {refs.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
            >
              <span className="truncate text-xs font-medium">{r.nombre}</span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  r.estado === "completed"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {r.estado === "completed" ? "lista" : "entrenando…"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2.5">
        <Input
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="Nombre de la persona (ej. Elon Musk)"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(e) => setFotos([...(e.target.files || [])])}
          className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:py-1.5 file:text-xs file:font-medium"
        />
        {fotos.length > 0 && (
          <p
            className={cn(
              "text-[11px]",
              fotos.length < MIN_FOTOS ? "text-amber-600" : "text-muted-foreground"
            )}
          >
            {fotos.length} foto{fotos.length === 1 ? "" : "s"}
            {fotos.length < MIN_FOTOS && ` — faltan ${MIN_FOTOS - fotos.length}`}
          </p>
        )}
      </div>

      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      {aviso && <p className="mt-2 text-[11px] text-muted-foreground">{aviso}</p>}

      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={crear}
        disabled={subiendo || fotos.length < MIN_FOTOS || !nombre.trim()}
      >
        {subiendo ? "Subiendo…" : "Crear referencia"}
      </Button>
    </div>
  );
}
