import { NextRequest, NextResponse } from "next/server";
import { isClaudeAvailable } from "@/lib/claude-path";
import { spawnClaude, ClaudeSpawnError } from "@/lib/generate-headless";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { getBrand } from "@/lib/brand";
import { getCarousel } from "@/lib/carousels";
import { getPreset } from "@/lib/style-presets";
import { isHiggsfieldConfigured } from "@/lib/higgsfield";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!isClaudeAvailable()) {
    return NextResponse.json(
      {
        error:
          "Claude CLI not found. Install from https://docs.anthropic.com/en/docs/claude-code or set CLAUDE_CLI_PATH in .env.local",
      },
      { status: 503 }
    );
  }

  let body: {
    message?: string;
    sessionId?: string;
    carouselId?: string;
    stylePresetId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { message, sessionId, carouselId, stylePresetId } = body;

  if (
    !message ||
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 10000
  ) {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }

  // Build dynamic system prompt with current brand + carousel + style preset context
  const brand = await getBrand();
  const carousel = carouselId ? await getCarousel(carouselId) : null;
  // Preferir el preset pedido; si no vino, usar el del carrusel (avatar 30x asociado).
  const effectivePresetId = stylePresetId || carousel?.stylePresetId || null;
  const stylePreset = effectivePresetId ? await getPreset(effectivePresetId) : null;
  const host = request.headers.get("host") || "localhost:3000";
  const baseUrl = `http://${host}`;
  const systemPrompt = buildSystemPrompt(
    brand,
    carousel,
    stylePreset,
    baseUrl,
    await isHiggsfieldConfigured()
  );

  const abortController = new AbortController();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // stream ya cerrado por el cliente
        }
      };

      spawnClaude({
        message,
        systemPrompt,
        sessionId,
        cwd: process.cwd(),
        signal: abortController.signal,
        onToken: (text) =>
          enqueue(`data: ${JSON.stringify({ type: "token", text })}\n\n`),
        onResult: (text) =>
          enqueue(`data: ${JSON.stringify({ type: "result", text })}\n\n`),
      })
        .then((res) => {
          if (res.exitCode && res.exitCode !== 0) {
            console.error("[chat] Claude subprocess exited non-zero", {
              exitCode: res.exitCode,
              stderr: res.stderr,
            });
            enqueue(
              `event: error\ndata: ${JSON.stringify({
                error: `Claude CLI exited with code ${res.exitCode}`,
                exitCode: res.exitCode,
                stderr: res.stderr || undefined,
              })}\n\n`
            );
          }
          enqueue(
            `event: done\ndata: ${JSON.stringify({
              sessionId: res.sessionId,
              exitCode: res.exitCode,
            })}\n\n`
          );
          try {
            controller.close();
          } catch {
            // ya cerrado
          }
        })
        .catch((err) => {
          const e = err as ClaudeSpawnError;
          console.error("[chat] failed to spawn Claude CLI", {
            platform: process.platform,
            code: e?.code,
            syscall: e?.syscall,
            path: e?.path,
            message: e?.message,
            stderr: e?.stderr,
          });
          enqueue(
            `event: error\ndata: ${JSON.stringify({
              error: e?.message || "Failed to start Claude CLI",
              code: e?.code,
              syscall: e?.syscall,
              path: e?.path,
              stderr: e?.stderr,
            })}\n\n`
          );
          try {
            controller.close();
          } catch {
            // ya cerrado
          }
        });
    },

    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
