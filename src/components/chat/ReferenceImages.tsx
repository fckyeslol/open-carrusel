"use client";

import { useState, useCallback } from "react";
import { Upload, X, Copy, Check, Image as ImageIcon, ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReferenceImage } from "@/types/carousel";

interface ReferenceImagesProps {
  carouselId: string;
  images: ReferenceImage[];
  onImagesChange: () => void;
}

export function ReferenceImages({
  carouselId,
  images,
  onImagesChange,
}: ReferenceImagesProps) {
  const [uploading, setUploading] = useState(false);
  const [previewImg, setPreviewImg] = useState<ReferenceImage | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const handleUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const uploadRes = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        const uploadData = await uploadRes.json().catch(() => ({}));
        // Antes un error se tragaba en silencio → "elijo y no pasa nada".
        if (!uploadRes.ok) {
          throw new Error(uploadData?.error || `Error ${uploadRes.status} al subir`);
        }

        const refRes = await fetch(`/api/carousels/${carouselId}/references`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: uploadData.url, name: file.name }),
        });
        if (!refRes.ok) {
          const d = await refRes.json().catch(() => ({}));
          throw new Error(d?.error || `Error ${refRes.status} al registrar la imagen`);
        }

        onImagesChange();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
      }
    },
    [carouselId, onImagesChange]
  );

  const handleRemove = useCallback(
    async (imageId: string) => {
      await fetch(
        `/api/carousels/${carouselId}/references?imageId=${imageId}`,
        { method: "DELETE" }
      );
      onImagesChange();
    },
    [carouselId, onImagesChange]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/")
      );
      files.forEach(handleUpload);
    },
    [handleUpload]
  );

  const handlePick = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.multiple = true;
    // Agregarlo al DOM: un <input> desprendido puede no disparar 'change' de forma
    // confiable en algunos navegadores. Se remueve apenas termina.
    input.style.display = "none";
    document.body.appendChild(input);
    input.onchange = (e) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? []);
      files.forEach(handleUpload);
      input.remove();
    };
    input.click();
  }, [handleUpload]);

  const copyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(url);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  return (
    <div className="border-b border-border">
      {/* Header: toggle a la izquierda, subir a la derecha */}
      <div className="flex items-center justify-between px-3 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={open}
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <ImageIcon className="h-3.5 w-3.5" />
          Assets
          {images.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60">({images.length})</span>
          )}
        </button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePick}
          disabled={uploading}
          className="h-6 gap-1 px-2 text-xs"
        >
          <Upload className="h-3 w-3" />
          {uploading ? "Subiendo…" : "Subir"}
        </Button>
      </div>

      {error && (
        <p className="px-3 pb-2 text-[11px] text-red-600 break-words">{error}</p>
      )}

      {open && (
        <div className="px-3 pb-3">
          {images.length === 0 ? (
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={handlePick}
              className="rounded-lg border border-dashed border-border p-3 text-center cursor-pointer transition-colors hover:border-muted-foreground/40 hover:bg-muted/20"
            >
              <Upload className="mx-auto mb-1 h-4 w-4 text-muted-foreground/40" />
              <p className="text-[11px] font-medium text-muted-foreground">
                Subí logos, gráficos e ilustraciones
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground/60">
                Claude los usa en las slides · PNG, JPG, WebP
              </p>
            </div>
          ) : (
            // Tira horizontal de miniaturas: no se corta en vertical y ocupa poco.
            <div
              className="flex gap-2 overflow-x-auto pb-1"
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
            >
              {images.map((img) => (
                <div key={img.id} className="group relative shrink-0">
                  <button
                    onClick={() => setPreviewImg(img)}
                    title={img.name}
                    className="block h-14 w-14 overflow-hidden rounded-md border border-border transition-colors hover:border-accent"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.url} alt={img.name} className="h-full w-full object-cover" />
                  </button>
                  <button
                    onClick={() => handleRemove(img.id)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-destructive group-hover:opacity-100"
                    title="Eliminar"
                    aria-label="Eliminar imagen"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {/* Agregar más */}
              <button
                onClick={handlePick}
                disabled={uploading}
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground"
                title="Agregar más"
                aria-label="Agregar más imágenes"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Preview lightbox */}
      {previewImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-8"
          onClick={() => setPreviewImg(null)}
        >
          <div
            className="relative w-full max-w-lg overflow-hidden rounded-xl bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewImg.url}
              alt={previewImg.name}
              className="max-h-[60vh] w-full bg-muted/20 object-contain"
            />
            <div className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{previewImg.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {previewImg.url}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-xs"
                  onClick={() => copyUrl(previewImg.url)}
                >
                  {copied === previewImg.url ? (
                    <Check className="h-3 w-3 text-green-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  Copiar URL
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  onClick={() => setPreviewImg(null)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
