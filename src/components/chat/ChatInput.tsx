"use client";

import { useState, useRef, useCallback } from "react";
import { Send, Square, Paperclip, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ChatAttachment {
  url: string;
  name: string;
}

interface ChatInputProps {
  onSend: (message: string, attachments: ChatAttachment[]) => void;
  isStreaming: boolean;
  disabled?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onStop?: () => void;
}

const SUGGESTIONS = [
  "Create a 5-slide carousel about...",
  "Make the design more minimal",
  "Change the accent color to blue",
  "Add a call-to-action slide",
  "Make the headings bigger",
];

const MAX_ATTACHMENTS = 6;

export function ChatInput({ onSend, isStreaming, disabled, textareaRef: externalRef, onStop }: ChatInputProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef || internalRef;

  const isUploading = uploadingCount > 0;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      setUploadError(null);
      setUploadingCount((n) => n + images.length);
      for (const file of images) {
        try {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/upload", { method: "POST", body: formData });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data?.error || `Error ${res.status} al subir`);
          }
          setAttachments((prev) =>
            prev.length >= MAX_ATTACHMENTS
              ? prev
              : [...prev, { url: data.url as string, name: file.name }]
          );
        } catch (e) {
          setUploadError((e as Error).message);
        } finally {
          setUploadingCount((n) => n - 1);
        }
      }
    },
    []
  );

  const handlePickFiles = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    input.onchange = (e) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? []);
      uploadFiles(files);
      input.remove();
    };
    input.click();
  }, [uploadFiles]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files ?? []);
      if (files.some((f) => f.type.startsWith("image/"))) {
        e.preventDefault();
        uploadFiles(files);
      }
    },
    [uploadFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      uploadFiles(Array.from(e.dataTransfer.files ?? []));
    },
    [uploadFiles]
  );

  const removeAttachment = useCallback((url: string) => {
    setAttachments((prev) => prev.filter((a) => a.url !== url));
  }, []);

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !isUploading;

  const handleSubmit = () => {
    if (!canSend || isStreaming) return;
    onSend(value.trim(), attachments);
    setValue("");
    setAttachments([]);
    setUploadError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    }
  };

  return (
    <div
      className="border-t border-border p-3"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {value.length === 0 && attachments.length === 0 && !isStreaming && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {SUGGESTIONS.slice(0, 3).map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => setValue(suggestion)}
              className="text-xs px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {uploadError && (
        <p className="mb-2 text-[11px] text-red-600 break-words">{uploadError}</p>
      )}

      {(attachments.length > 0 || isUploading) && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {attachments.map((att) => (
            <div key={att.url} className="group relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={att.url}
                alt={att.name}
                title={att.name}
                className="h-12 w-12 rounded-md border border-border object-cover"
              />
              <button
                onClick={() => removeAttachment(att.url)}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:text-destructive"
                title="Quitar imagen"
                aria-label={`Quitar ${att.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {isUploading && (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-dashed border-border">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <Button
          size="icon"
          variant="ghost"
          onClick={handlePickFiles}
          disabled={isStreaming || disabled || attachments.length >= MAX_ATTACHMENTS}
          aria-label="Adjuntar imágenes"
          title="Adjuntar imágenes (o pegá/arrastrá)"
          className="shrink-0 text-muted-foreground"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          placeholder={
            isStreaming ? "AI is working..." : "Describe your carousel..."
          }
          disabled={isStreaming || disabled}
          rows={1}
          className="flex-1 resize-none bg-muted rounded-lg px-3 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          aria-label="Chat message input"
        />
        {isStreaming ? (
          <Button
            size="icon"
            variant="destructive"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={handleSubmit}
            disabled={!canSend || disabled}
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
