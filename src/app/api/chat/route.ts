import { NextRequest, NextResponse } from "next/server";
import { mkdir, stat } from "fs/promises";
import path from "path";
import { isClaudeAvailable } from "@/lib/claude-path";
import { spawnClaude, ClaudeSpawnError } from "@/lib/generate-headless";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { getBrand } from "@/lib/brand";
import { getCarousel } from "@/lib/carousels";
import { getPreset } from "@/lib/style-presets";
import { isHiggsfieldConfigured } from "@/lib/higgsfield";
import { getCentralClaudeToken, getInternalApiToken, isHostedMode } from "@/lib/hosted";
import { getSessionUser } from "@/lib/auth";
import { getClaudeToken } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UPLOADS_DIR = path.resolve(process.cwd(), "public", "uploads");
const MAX_ATTACHMENTS = 6;

/**
 * Resuelve un adjunto del chat (`/uploads/...`) a su ruta absoluta en disco,
 * verificando que exista y no se escape de la carpeta de uploads. Devuelve
 * null si es inválido — un adjunto malo no debe tumbar el mensaje entero.
 */
async function resolveAttachment(ref: unknown): Promise<string | null> {
  if (typeof ref !== "string" || !ref.startsWith("/uploads/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.length < 2 || segments.some((s) => s === "." || s === "..")) return null;
  const resolved = path.resolve(UPLOADS_DIR, ...segments.slice(1));
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) return null;
  try {
    const info = await stat(resolved);
    return info.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

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
    /** URLs públicas locales (`/uploads/...`) de imágenes adjuntas al mensaje. */
    attachments?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { message, sessionId, carouselId, stylePresetId, attachments } = body;

  // Modo hosteado: la generación corre con un token de Claude. Preferimos el
  // token propio de la usuaria logueada (su seat paga su consumo); si no conectó
  // ninguno, caemos al token central del despliegue (getCentralClaudeToken —
  // tu seat de Team paga todo). Sin ninguno de los dos no se puede generar:
  // mejor un error claro acá que un spawn que falla en inglés.
  let spawnEnv: Record<string, string> | undefined;
  let internalToken: string | undefined;
  if (isHostedMode()) {
    const user = await getSessionUser(request);
    if (!user) {
      return NextResponse.json({ error: "No autenticada" }, { status: 401 });
    }
    const ownToken = await getClaudeToken(user.id);
    const claudeToken = ownToken ?? getCentralClaudeToken();
    if (!claudeToken) {
      return NextResponse.json(
        {
          error:
            "Todavía no conectaste tu Claude. Andá a tu cuenta, corré `claude setup-token` en tu compu y pegá el token.",
        },
        { status: 409 }
      );
    }
    // CLAUDE_CONFIG_DIR aislado: (1) si el server tuviera un `claude login`
    // global, esas credenciales NO pisan el token que inyectamos (el CLI prefiere
    // credenciales guardadas sobre el env), y (2) las sesiones de chat quedan
    // separadas. Con token PROPIO usamos el dir de la usuaria; con el token
    // CENTRAL usamos un dir compartido `_central`, para que credenciales
    // cacheadas de un token propio previo de esa usuaria nunca pisen el central.
    // Base configurable: en Cloud Run apunta a disco local efímero (rápido; las
    // sesiones --resume solo viven durante la conversación, no hace falta que
    // sobrevivan reinicios), no al volumen GCS montado en /app/data.
    const configBase =
      process.env.CLAUDE_CONFIG_BASE || path.resolve(process.cwd(), "data", "claude-config");
    const configDir = path.join(configBase, ownToken ? user.id : "_central");
    await mkdir(configDir, { recursive: true });
    spawnEnv = { CLAUDE_CODE_OAUTH_TOKEN: claudeToken, CLAUDE_CONFIG_DIR: configDir };
    internalToken = getInternalApiToken();
  }

  // Adjuntos: validar y resolver a rutas absolutas ANTES de validar el mensaje,
  // porque un mensaje solo-imágenes es válido.
  const attachmentPaths: string[] = [];
  if (attachments !== undefined) {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
      return NextResponse.json({ error: "Invalid attachments" }, { status: 400 });
    }
    for (const ref of attachments) {
      const abs = await resolveAttachment(ref);
      if (!abs) {
        return NextResponse.json(
          { error: `Invalid attachment: ${String(ref)}` },
          { status: 400 }
        );
      }
      attachmentPaths.push(abs);
    }
  }

  const trimmedMessage = typeof message === "string" ? message.trim() : "";
  if (
    (!trimmedMessage && attachmentPaths.length === 0) ||
    (typeof message === "string" && message.length > 10000)
  ) {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }

  // El CLI recibe texto: las imágenes viajan como rutas que el agente mira con Read.
  const attachmentBlock =
    attachmentPaths.length > 0
      ? `\n\n[Imágenes adjuntas por el usuario — antes de responder, miralas con Read:\n${attachmentPaths
          .map((p) => `- ${p}`)
          .join("\n")}]`
      : "";
  const effectiveMessage =
    (trimmedMessage || "Mirá las imágenes adjuntas y usalas como referencia.") +
    attachmentBlock;

  // Build dynamic system prompt with current brand + carousel + style preset context
  const brand = await getBrand();
  const carousel = carouselId ? await getCarousel(carouselId) : null;
  // Preferir el preset pedido; si no vino, usar el del carrusel (avatar 30x asociado).
  const effectivePresetId = stylePresetId || carousel?.stylePresetId || null;
  const stylePreset = effectivePresetId ? await getPreset(effectivePresetId) : null;
  // En modo hosteado el subproceso corre EN el server: siempre loopback (el host
  // del request es el dominio público, que no le sirve al Python del agente).
  const host = request.headers.get("host") || "localhost:3000";
  const baseUrl = isHostedMode()
    ? `http://127.0.0.1:${process.env.PORT || "3000"}`
    : `http://${host}`;
  const systemPrompt = buildSystemPrompt(
    brand,
    carousel,
    stylePreset,
    baseUrl,
    await isHiggsfieldConfigured(),
    internalToken
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
        message: effectiveMessage,
        systemPrompt,
        sessionId,
        cwd: process.cwd(),
        signal: abortController.signal,
        env: spawnEnv,
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
