/**
 * Helper mínimo para respuestas SSE (Server-Sent Events) desde route handlers.
 *
 * Se usa en las rutas de ingesta 30x, donde el trabajo dura hasta 2 minutos y el
 * cliente necesita saber en qué etapa va en lugar de esperar un JSON al final.
 */

const encoder = new TextEncoder();

export interface SseStreamHandlers<T> {
  /** Emite un evento al cliente. No-op si el cliente ya cerró la conexión. */
  send: (event: T) => void;
}

/**
 * Envuelve un trabajo async en un ReadableStream SSE.
 *
 * El trabajo recibe un `send` para emitir eventos. Si lanza, el error se
 * convierte en el evento final vía `onError` — el stream nunca se corta a la
 * mitad sin explicación, que es justo el fallo que esta capa evita.
 */
export function sseResponse<T>(
  run: (handlers: SseStreamHandlers<T>) => Promise<void>,
  onError: (error: unknown) => T
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: T) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // El cliente cerró la pestaña o abortó: dejar de emitir sin romper el trabajo.
          closed = true;
        }
      };

      try {
        await run({ send });
      } catch (error) {
        send(onError(error));
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* ya cerrado por el cliente */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform + X-Accel-Buffering evitan que un proxy acumule los chunks
      // y anule el streaming (el síntoma sería "todo llega junto al final").
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Lee un stream SSE en el cliente y llama `onEvent` por cada evento.
 * Tolera chunks partidos a la mitad de un mensaje (buffer acumulativo).
 */
export async function readSseStream<T>(
  response: Response,
  onEvent: (event: T) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("La respuesta no trae stream");

  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Los mensajes SSE se separan con una línea en blanco.
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const payload = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (payload) {
        try {
          onEvent(JSON.parse(payload) as T);
        } catch {
          // Evento corrupto: ignorarlo en vez de tumbar toda la ingesta.
        }
      }

      boundary = buffer.indexOf("\n\n");
    }
  }
}
