"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { wrapEditableSlide } from "@/lib/slide-editor";
import { DIMENSIONS, type AspectRatio } from "@/types/carousel";
import { Button } from "@/components/ui/button";
import {
  Type,
  Image as ImageIcon,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Trash2,
  Group,
  Ungroup,
  CornerLeftUp,
} from "lucide-react";

const FONTS = [
  "Inter",
  "Instrument Serif",
  "Playfair Display",
  "Open Sans",
  "Arimo",
  "Poppins",
  "Nunito Sans",
  "Bricolage Grotesque",
  "Montserrat",
  "Lora",
  "Oswald",
  "Bebas Neue",
];

interface Selection {
  none?: boolean;
  isText?: boolean;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  fontWeight?: string;
  italic?: boolean;
  align?: string;
  letterSpacing?: string;
  count?: number;
  grouped?: boolean;
}

interface VisualEditorProps {
  html: string;
  aspectRatio: AspectRatio;
  onChange: (html: string) => void; // se llama con el HTML serializado tras cada edición
}

export function VisualEditor({ html, aspectRatio, onChange }: VisualEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Selection>({ none: true });
  const [scale, setScale] = useState(0);
  const { width: W, height: H } = DIMENSIONS[aspectRatio];

  // Capturamos el HTML inicial UNA vez: durante la edición el iframe es la fuente
  // de verdad y no debe recargarse cuando guardamos. Al cambiar de slide, el padre
  // remonta este componente con `key={slideId}` y vuelve a capturar el HTML nuevo.
  const [initialHtml] = useState(html);
  const srcDoc = useMemo(() => wrapEditableSlide(initialHtml, aspectRatio), [initialHtml, aspectRatio]);

  // escala para encajar en el contenedor
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) setScale(Math.min(r.width / W, r.height / H));
    };
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    measure();
    return () => obs.disconnect();
  }, [W, H]);

  // recibir mensajes del iframe
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (!m || !m.oc) return;
      if (m.oc === "sel") setSel(m as Selection);
      else if (m.oc === "html") onChange(m.html);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onChange]);

  const send = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ oc: msg.oc, ...msg }, "*");
  }, []);
  const applyProp = useCallback(
    (prop: string, value: unknown) => send({ oc: "apply", prop, value }),
    [send]
  );

  const onUpload = useCallback(
    async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        const url = data.url || data.path;
        if (url) send({ oc: "addImage", url });
      } catch {
        /* ignore */
      }
    },
    [send]
  );

  const hasSel = !sel.none;

  return (
    <div className="flex-1 flex min-h-0 bg-[#e9e9ec]">
      {/* Lienzo editable */}
      <div ref={wrapRef} className="flex-1 relative min-h-0 flex items-center justify-center p-8">
        {scale > 0 && (
          <div
            style={{
              width: Math.floor(W * scale),
              height: Math.floor(H * scale),
              position: "relative",
              boxShadow: "0 6px 30px rgba(0,0,0,.15)",
              borderRadius: 8,
              overflow: "hidden",
              background: "#fff",
            }}
            onClick={(e) => {
              // click fuera del contenido deselecciona
              if (e.target === e.currentTarget) send({ oc: "deselect" });
            }}
          >
            <iframe
              ref={iframeRef}
              sandbox="allow-scripts allow-same-origin"
              srcDoc={srcDoc}
              title="Editor"
              style={{
                width: W,
                height: H,
                border: "none",
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                position: "absolute",
                top: 0,
                left: 0,
              }}
            />
          </div>
        )}
      </div>

      {/* Panel de propiedades */}
      <div className="w-72 shrink-0 border-l border-border bg-surface overflow-y-auto p-4 space-y-4">
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={() => send({ oc: "addText" })}>
            <Type className="h-4 w-4" /> Texto
          </Button>
          <label className="flex-1">
            <Button size="sm" variant="outline" className="w-full pointer-events-none">
              <ImageIcon className="h-4 w-4" /> Imagen
            </Button>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
            />
          </label>
        </div>

        {!hasSel && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Clic en un elemento para editarlo. <b>Shift+clic</b> para seleccionar varios.
            Doble clic cambia el texto. Arrastrá para mover; las <b>esquinas</b> redimensionan.
          </p>
        )}

        {hasSel && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {(sel.count || 1) > 1 ? `${sel.count} seleccionados` : "1 seleccionado"}
                {sel.grouped ? " · grupo" : ""}
              </span>
              <div className="flex-1" />
              <Button
                size="sm"
                variant="outline"
                onClick={() => send({ oc: "parent" })}
                title="Seleccionar el contenedor (texto + su decorativo)"
              >
                <CornerLeftUp className="h-4 w-4" /> Nivel
              </Button>
              {(sel.count || 1) > 1 && !sel.grouped && (
                <Button size="sm" variant="outline" onClick={() => send({ oc: "group" })}>
                  <Group className="h-4 w-4" /> Agrupar
                </Button>
              )}
              {sel.grouped && (
                <Button size="sm" variant="outline" onClick={() => send({ oc: "ungroup" })}>
                  <Ungroup className="h-4 w-4" /> Desagrupar
                </Button>
              )}
            </div>
            {sel.isText && (
              <>
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Texto</span>
                  <textarea
                    className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm resize-none"
                    rows={2}
                    value={sel.text || ""}
                    onChange={(e) => {
                      setSel({ ...sel, text: e.target.value });
                      applyProp("text", e.target.value);
                    }}
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tipografía</span>
                  <select
                    className="mt-1 w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
                    value={FONTS.includes(sel.fontFamily || "") ? sel.fontFamily : ""}
                    onChange={(e) => applyProp("fontFamily", e.target.value)}
                  >
                    <option value="">{sel.fontFamily || "—"}</option>
                    {FONTS.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </label>
                <div className="flex gap-2">
                  <label className="flex-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tamaño</span>
                    <input
                      type="number"
                      className="mt-1 w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
                      value={sel.fontSize || 0}
                      onChange={(e) => applyProp("fontSize", Number(e.target.value))}
                    />
                  </label>
                  <label>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Color</span>
                    <input
                      type="color"
                      className="mt-1 h-9 w-12 rounded-md border border-border bg-background"
                      value={sel.color || "#000000"}
                      onChange={(e) => applyProp("color", e.target.value)}
                    />
                  </label>
                </div>
                <div className="flex gap-1">
                  <Button size="icon" variant={Number(sel.fontWeight) >= 600 ? "accent" : "outline"} onClick={() => applyProp("bold", Number(sel.fontWeight) < 600)}>
                    <Bold className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant={sel.italic ? "accent" : "outline"} onClick={() => applyProp("italic", !sel.italic)}>
                    <Italic className="h-4 w-4" />
                  </Button>
                  <div className="flex-1" />
                  <Button size="icon" variant={sel.align === "left" ? "accent" : "outline"} onClick={() => applyProp("align", "left")}>
                    <AlignLeft className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant={sel.align === "center" ? "accent" : "outline"} onClick={() => applyProp("align", "center")}>
                    <AlignCenter className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant={sel.align === "right" ? "accent" : "outline"} onClick={() => applyProp("align", "right")}>
                    <AlignRight className="h-4 w-4" />
                  </Button>
                </div>
              </>
            )}

            <Button size="sm" variant="outline" className="w-full text-red-600" onClick={() => applyProp("remove", true)}>
              <Trash2 className="h-4 w-4" /> Borrar elemento
            </Button>
          </div>
        )}

        <div className="border-t border-border pt-4 space-y-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Fondo del slide</span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              className="h-9 w-12 rounded-md border border-border"
              defaultValue="#F6F5F0"
              onChange={(e) => send({ oc: "setBg", value: e.target.value })}
            />
            <div className="flex gap-1 flex-wrap">
              {[
                "linear-gradient(135deg,#2A2320,#C77E97)",
                "linear-gradient(135deg,#15142B,#EBFF6F)",
                "linear-gradient(135deg,#0C1030,#3A34E0)",
                "radial-gradient(circle at 30% 20%,#E5ACBF,#F6F5F0)",
              ].map((g) => (
                <button
                  key={g}
                  className="h-7 w-7 rounded-md border border-border"
                  style={{ background: g }}
                  onClick={() => send({ oc: "setBg", value: g })}
                  aria-label="degradado"
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
