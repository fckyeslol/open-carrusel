"use client";

import { useState, useCallback } from "react";
import { Upload, X, Copy, Check, Image } from "lucide-react";
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
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-1.5">
          <Image className="h-3 w-3 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">
            Assets
          </span>
          {images.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60">
              ({images.length})
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePick}
          disabled={uploading}
          className="h-6 text-xs gap-1 px-2"
        >
          <Upload className="h-3 w-3" />
          {uploading ? "Subiendo..." : "Subir"}
        </Button>
      </div>

      {error && (
        <p className="px-4 pb-2 text-[11px] text-red-600 break-words">{error}</p>
      )}

      {/* Drop zone or grid */}
      {images.length === 0 ? (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={handlePick}
          className="mx-4 mb-3 border border-dashed border-border rounded-lg p-4 text-center cursor-pointer hover:border-muted-foreground/40 hover:bg-muted/20 transition-colors"
        >
          <Upload className="h-4 w-4 mx-auto text-muted-foreground/40 mb-2" />
          <p className="text-[11px] text-muted-foreground font-medium">
            Sube logos, gráficos e ilustraciones
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            Claude los usará en las slides · PNG, JPG, WebP
          </p>
        </div>
      ) : (
        <div className="px-4 pb-3 space-y-1.5 max-h-44 overflow-y-auto">
          {images.map((img) => (
            <div
              key={img.id}
              className="flex items-center gap-2 group rounded-lg px-2 py-1.5 hover:bg-muted/40 transition-colors"
            >
              {/* Thumbnail */}
              <button
                onClick={() =>
                  setPreviewImg(previewImg?.id === img.id ? null : img)
                }
                className="shrink-0 w-9 h-9 rounded-md overflow-hidden border border-border hover:border-accent transition-colors"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.name}
                  className="w-full h-full object-cover"
                />
              </button>

              {/* Name + URL */}
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium text-foreground truncate leading-tight">
                  {img.name.replace(/\.[^.]+$/, "")}
                </p>
                <p className="text-[10px] text-muted-foreground/70 font-mono truncate leading-tight">
                  {img.url}
                </p>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => copyUrl(img.url)}
                  className="h-6 w-6 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title="Copiar URL"
                >
                  {copied === img.url ? (
                    <Check className="h-3 w-3 text-green-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
                <button
                  onClick={() => handleRemove(img.id)}
                  className="h-6 w-6 rounded flex items-center justify-center hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  title="Eliminar"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}

          {/* Add more */}
          <button
            onClick={handlePick}
            disabled={uploading}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed border-border text-[11px] text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground hover:bg-muted/20 transition-colors"
          >
            <Upload className="h-3 w-3" />
            {uploading ? "Subiendo..." : "Agregar más"}
          </button>
        </div>
      )}

      {/* Preview lightbox */}
      {previewImg && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-8"
          onClick={() => setPreviewImg(null)}
        >
          <div
            className="relative bg-card rounded-xl overflow-hidden shadow-2xl max-w-lg w-full"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewImg.url}
              alt={previewImg.name}
              className="w-full max-h-[60vh] object-contain bg-muted/20"
            />
            <div className="p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{previewImg.name}</p>
                <p className="text-xs font-mono text-muted-foreground truncate">
                  {previewImg.url}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
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
