"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { wrapEditableSlide, EDITOR_FONTS } from "@/lib/slide-editor";
import { DIMENSIONS, type AspectRatio } from "@/types/carousel";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/section";
import { BackgroundPicker } from "./BackgroundPicker";
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
  Undo2,
  Copy as CopyIcon,
  BringToFront,
  SendToBack,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Sparkles,
  RefreshCw,
} from "lucide-react";

const FONTS = EDITOR_FONTS;

/** Grosores estándar de Google Fonts, con nombre en español. */
const WEIGHTS = [
  { value: "100", label: "Fino" },
  { value: "200", label: "Extrafino" },
  { value: "300", label: "Ligero" },
  { value: "400", label: "Regular" },
  { value: "500", label: "Medio" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Negrita" },
  { value: "800", label: "Extranegrita" },
  { value: "900", label: "Black" },
] as const;

interface Selection {
  none?: boolean;
  isText?: boolean;
  isImage?: boolean;
  tag?: string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  fontWeight?: string;
  italic?: boolean;
  align?: string;
  letterSpacing?: number;
  lineHeight?: number;
  opacity?: number;
  radius?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Generación de imágenes con IA (Higgsfield). aiTarget define si la próxima
  // imagen generada se INSERTA nueva o REEMPLAZA la imagen seleccionada.
  const [aiTarget, setAiTarget] = useState<null | "insert" | "regen">(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
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
      setUploading(true);
      setUploadError(null);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
        const url = data.url || data.path;
        if (!url) throw new Error("El servidor no devolvió la URL");
        // URL absoluta: el iframe es `srcdoc` (about:srcdoc) y una ruta relativa
        // puede no resolver según el contexto. Absoluta carga siempre.
        send({ oc: "addImage", url: new URL(url, window.location.origin).href });
      } catch (e) {
        setUploadError((e as Error).message);
      } finally {
        setUploading(false);
      }
    },
    [send]
  );

  // Genera una imagen con IA y devuelve su URL absoluta (o null si falló).
  const generateImage = useCallback(
    async (prompt: string): Promise<string | null> => {
      setAiBusy(true);
      setAiError(null);
      try {
        const res = await fetch("/api/generate-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, aspectRatio }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
        if (!data.url) throw new Error("El servidor no devolvió la URL");
        return new URL(data.url, window.location.origin).href;
      } catch (e) {
        setAiError((e as Error).message);
        return null;
      } finally {
        setAiBusy(false);
      }
    },
    [aspectRatio]
  );

  const runAi = useCallback(async () => {
    const p = aiPrompt.trim();
    if (!p) return;
    const abs = await generateImage(p);
    if (!abs) return;
    if (aiTarget === "regen") send({ oc: "setImgSrc", url: abs });
    else send({ oc: "addImage", url: abs });
    setAiTarget(null);
    setAiPrompt("");
  }, [aiPrompt, aiTarget, generateImage, send]);

  const hasSel = !sel.none;
  const labelCls =
    "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
  const inputCls =
    "mt-1 w-full h-9 rounded-md border border-border bg-background px-2 text-sm";

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
      <div className="w-80 shrink-0 border-l border-border bg-surface flex flex-col min-h-0">
        {/* Barra de acciones — fija arriba */}
        <div className="shrink-0 border-b border-border p-3 space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="outline" onClick={() => send({ oc: "addText" })}>
              <Type className="h-4 w-4" /> Texto
            </Button>
            {/* el input se dispara por ref: un <button> dentro de <label> NO activa el file input */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              <ImageIcon className="h-4 w-4" /> {uploading ? "Subiendo…" : "Imagen"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUpload(f);
                e.target.value = "";
              }}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => {
              setAiError(null);
              setAiTarget((t) => (t === "insert" ? null : "insert"));
            }}
          >
            <Sparkles className="h-4 w-4" /> Generar con IA
          </Button>
          {aiTarget && (
            <div className="rounded-md border border-border bg-background p-2 space-y-2">
              <span className={labelCls}>
                {aiTarget === "regen" ? "Regenerar imagen con IA" : "Nueva imagen con IA"}
              </span>
              <textarea
                className="w-full rounded-md border border-border bg-background p-2 text-sm resize-none"
                rows={3}
                placeholder="Describí la imagen (podés escribir en inglés). Ej: soft editorial studio background, warm tones, no text"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                disabled={aiBusy}
              />
              <div className="flex gap-2">
                <Button size="sm" variant="accent" className="flex-1" onClick={runAi} disabled={aiBusy || !aiPrompt.trim()}>
                  <Sparkles className="h-4 w-4" /> {aiBusy ? "Generando… (~1-2 min)" : "Generar"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setAiTarget(null);
                    setAiPrompt("");
                  }}
                  disabled={aiBusy}
                >
                  Cancelar
                </Button>
              </div>
              {aiBusy && (
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Higgsfield tarda ~1-2 min por imagen. No cierres el editor.
                </p>
              )}
              {aiError && <p className="text-xs text-red-600">{aiError}</p>}
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => send({ oc: "undo" })}>
              <Undo2 className="h-4 w-4" /> Deshacer
            </Button>
            <Button size="sm" variant="ghost" onClick={() => send({ oc: "duplicate" })} disabled={!hasSel}>
              <CopyIcon className="h-4 w-4" /> Duplicar
            </Button>
          </div>
          {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}
        </div>

        {/* Cuerpo scrolleable */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3">
          {!hasSel && (
            <p className="py-4 text-xs text-muted-foreground leading-relaxed">
              Clic en un elemento para editarlo. <b>Shift+clic</b> para seleccionar varios.
              Doble clic cambia el texto. Arrastrá para mover; en texto, las <b>esquinas</b>{" "}
              escalan la tipografía y los <b>laterales</b> ajustan el ancho.
            </p>
          )}

          {hasSel && (
            <>
              <div className="flex items-center gap-2 pt-3 pb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                  {(sel.count || 1) > 1 ? `${sel.count} seleccionados` : "1 seleccionado"}
                  {sel.grouped ? " · grupo" : ""}
                </span>
              </div>

              {sel.isImage && (
                <Section title="Imagen" defaultOpen>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setAiError(null);
                      setAiPrompt("");
                      setAiTarget((t) => (t === "regen" ? null : "regen"));
                    }}
                  >
                    <RefreshCw className="h-4 w-4" /> Regenerar con IA
                  </Button>
                </Section>
              )}

              {sel.isText && (
                <Section title="Texto" defaultOpen>
                  <label className="block">
                    <textarea
                      className="w-full rounded-md border border-border bg-background p-2 text-sm resize-none"
                      rows={2}
                      value={sel.text || ""}
                      onChange={(e) => {
                        setSel({ ...sel, text: e.target.value });
                        applyProp("text", e.target.value);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>Tipografía</span>
                    <select
                      className={inputCls}
                      value={sel.fontFamily || ""}
                      onChange={(e) => applyProp("fontFamily", e.target.value)}
                    >
                      {/* Si la lámina usa una fuente fuera del allowlist, la anteponemos
                          para que se vea Y se pueda volver a elegir (antes quedaba muda). */}
                      {!sel.fontFamily && <option value="">—</option>}
                      {(sel.fontFamily && !FONTS.includes(sel.fontFamily)
                        ? [sel.fontFamily, ...FONTS]
                        : FONTS
                      ).map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <div className="flex gap-2">
                    <label className="flex-1">
                      <span className={labelCls}>Tamaño</span>
                      <input
                        type="number"
                        className={inputCls}
                        value={sel.fontSize || 0}
                        onChange={(e) => applyProp("fontSize", Number(e.target.value))}
                      />
                    </label>
                    <label>
                      <span className={labelCls}>Color</span>
                      <input
                        type="color"
                        className="mt-1 h-9 w-12 rounded-md border border-border bg-background"
                        value={sel.color || "#000000"}
                        onChange={(e) => applyProp("color", e.target.value)}
                      />
                    </label>
                  </div>
                  {/* Grosor manual: la fuente sirve solo los pesos que tiene; los que
                      no existen, el navegador los aproxima al más cercano. */}
                  <label className="block">
                    <span className={labelCls}>Grosor</span>
                    <select
                      className={inputCls}
                      value={String(Number(sel.fontWeight) || 400)}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSel({ ...sel, fontWeight: v });
                        applyProp("fontWeight", v);
                      }}
                    >
                      {WEIGHTS.map((w) => (
                        <option key={w.value} value={w.value}>
                          {w.value} · {w.label}
                        </option>
                      ))}
                    </select>
                  </label>
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
                  <div className="flex gap-2">
                    <label className="flex-1">
                      <span className={labelCls}>Interletra</span>
                      <input
                        type="number"
                        step={0.5}
                        className={inputCls}
                        value={sel.letterSpacing ?? 0}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setSel({ ...sel, letterSpacing: v });
                          applyProp("letterSpacing", v);
                        }}
                      />
                    </label>
                    <label className="flex-1">
                      <span className={labelCls}>Interlínea</span>
                      <input
                        type="number"
                        step={0.1}
                        min={0}
                        className={inputCls}
                        value={sel.lineHeight ?? 0}
                        onChange={(e) => {
                          const v = Math.max(0, Number(e.target.value));
                          setSel({ ...sel, lineHeight: v });
                          applyProp("lineHeight", v);
                        }}
                      />
                    </label>
                  </div>
                  <div className="block">
                    <span className={labelCls}>Efecto de texto</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {[
                        { id: "none", label: "Ninguno" },
                        { id: "shadow", label: "Sombra" },
                        { id: "neon", label: "Neón" },
                        { id: "outline", label: "Contorno" },
                        { id: "hollow", label: "Hueco" },
                      ].map((fx) => (
                        <Button
                          key={fx.id}
                          size="sm"
                          variant="outline"
                          onClick={() => applyProp("textEffect", fx.id)}
                        >
                          {fx.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </Section>
              )}

              <Section title="Apariencia" defaultOpen={!sel.isText && !sel.isImage}>
                <label className="block">
                  <span className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Opacidad <span className="tabular-nums">{sel.opacity ?? 100}%</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={sel.opacity ?? 100}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setSel({ ...sel, opacity: v });
                      applyProp("opacity", v);
                    }}
                    className="mt-1 w-full accent-accent"
                  />
                </label>
                <label className="block">
                  <span className={labelCls}>Esquinas (px)</span>
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    value={sel.radius ?? 0}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value));
                      setSel({ ...sel, radius: v });
                      applyProp("radius", v);
                    }}
                  />
                </label>
              </Section>

              {(sel.count || 1) === 1 && (
                <Section title="Posición y tamaño">
                  <div className="grid grid-cols-2 gap-2">
                    {(["x", "y", "w", "h"] as const).map((k) => (
                      <label key={k} className="block">
                        <span className={labelCls}>{k.toUpperCase()}</span>
                        <input
                          type="number"
                          className={inputCls}
                          value={Math.round(sel[k] ?? 0)}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setSel({ ...sel, [k]: v });
                            applyProp(k, v);
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </Section>
              )}

              <Section title="Alinear y distribuir">
                <p className="text-[10px] text-muted-foreground">
                  {(sel.count || 1) > 1 ? "Entre los seleccionados" : "Respecto al lienzo"}
                </p>
                <div className="flex gap-1">
                  <Button size="icon" variant="outline" title="Izquierda" onClick={() => send({ oc: "align", kind: "left" })}>
                    <AlignStartVertical className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="outline" title="Centro horizontal" onClick={() => send({ oc: "align", kind: "hcenter" })}>
                    <AlignCenterVertical className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="outline" title="Derecha" onClick={() => send({ oc: "align", kind: "right" })}>
                    <AlignEndVertical className="h-4 w-4" />
                  </Button>
                  <div className="w-1" />
                  <Button size="icon" variant="outline" title="Arriba" onClick={() => send({ oc: "align", kind: "top" })}>
                    <AlignStartHorizontal className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="outline" title="Centro vertical" onClick={() => send({ oc: "align", kind: "vcenter" })}>
                    <AlignCenterHorizontal className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="outline" title="Abajo" onClick={() => send({ oc: "align", kind: "bottom" })}>
                    <AlignEndHorizontal className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="outline"
                    title="Distribuir horizontal (3+)"
                    disabled={(sel.count || 1) < 3}
                    onClick={() => send({ oc: "distribute", axis: "h" })}
                  >
                    <AlignHorizontalDistributeCenter className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    title="Distribuir vertical (3+)"
                    disabled={(sel.count || 1) < 3}
                    onClick={() => send({ oc: "distribute", axis: "v" })}
                  >
                    <AlignVerticalDistributeCenter className="h-4 w-4" />
                  </Button>
                </div>
              </Section>

              <Section title="Capa y grupo">
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => applyProp("front", true)}
                    title="Traer al frente"
                  >
                    <BringToFront className="h-4 w-4" /> Al frente
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => applyProp("back", true)}
                    title="Enviar atrás"
                  >
                    <SendToBack className="h-4 w-4" /> Atrás
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => send({ oc: "group" })}
                    disabled={(sel.count || 1) < 2}
                    title="Shift+clic para sumar elementos, después Agrupar"
                  >
                    <Group className="h-4 w-4" /> Agrupar
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => send({ oc: "ungroup" })} disabled={!sel.grouped}>
                    <Ungroup className="h-4 w-4" /> Desagrupar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => send({ oc: "unlink" })}
                    disabled={!sel.grouped}
                    title="Saca del grupo lo seleccionado (Alt+clic selecciona un miembro suelto)"
                  >
                    Sacar
                  </Button>
                </div>
              </Section>

              <Button size="sm" variant="outline" className="my-3 w-full text-red-600" onClick={() => applyProp("remove", true)}>
                <Trash2 className="h-4 w-4" /> Borrar elemento
              </Button>
            </>
          )}

          {/* Fondo del slide */}
          <Section title="Fondo del slide" defaultOpen={!hasSel}>
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
            <div className="max-h-72 overflow-y-auto">
              <BackgroundPicker onApply={(value) => send({ oc: "setBg", value })} />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
