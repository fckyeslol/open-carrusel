/**
 * Núcleo de spawn del Claude CLI, compartido por:
 *   - la ruta de chat con SSE (/api/chat) — streaming token a token al navegador
 *   - el runner headless (thirtyx-runner) — corre sin navegador y ESPERA el final
 *
 * Antes esta lógica vivía inline dentro de /api/chat. Se extrajo acá para no
 * duplicarla: generar un carrusel desde la cola necesita exactamente el mismo
 * subproceso, pero sin un cliente HTTP que mantenga viva la conexión.
 */
import { spawn } from "child_process";
import crossSpawn from "cross-spawn";
import { getClaudePath, resolveDirectExecutable } from "./claude-path";

/** Herramientas que el agente puede usar para construir el carrusel. */
const DEFAULT_ALLOWED_TOOLS = ["Bash", "WebFetch", "Read"] as const;

/** 8 min: generar un carrusel 30x lee varias imágenes (visión) y escribe N láminas. */
const DEFAULT_TIMEOUT_MS = 480_000;
const STDERR_CAP = 8192;

export interface SpawnClaudeOptions {
  message: string;
  systemPrompt: string;
  sessionId?: string;
  cwd?: string;
  maxBudgetUsd?: string;
  timeoutMs?: number;
  allowedTools?: readonly string[];
  signal?: AbortSignal;
  /** Streaming hooks (la ruta de chat los cablea a SSE; el runner los ignora). */
  onToken?: (text: string) => void;
  onResult?: (text: string) => void;
  onSessionId?: (id: string) => void;
}

export interface SpawnClaudeResult {
  exitCode: number | null;
  sessionId: string;
  stderr: string;
  /** Texto del evento `result` (resumen final del agente), si vino. */
  resultText: string;
}

/** Error de ARRANQUE del subproceso (ENOENT, permisos, etc.). */
export class ClaudeSpawnError extends Error {
  code?: string;
  syscall?: string;
  path?: string;
  stderr?: string;
  constructor(message: string, extra: Partial<ClaudeSpawnError> = {}) {
    super(message);
    this.name = "ClaudeSpawnError";
    Object.assign(this, extra);
  }
}

function buildArgs(opts: SpawnClaudeOptions): string[] {
  const tools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const args = [
    "-p",
    opts.message,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--append-system-prompt",
    opts.systemPrompt,
  ];
  for (const t of tools) args.push("--allowedTools", t);
  args.push("--max-budget-usd", opts.maxBudgetUsd || process.env.CLAUDE_MAX_BUDGET_USD || "8.00");
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  return args;
}

/** Interpreta una línea de `stream-json` y dispara los callbacks correspondientes. */
function handleEvent(event: Record<string, unknown>, opts: SpawnClaudeOptions, setSid: (id: string) => void) {
  if (event.type === "system" && event.subtype === "init" && event.session_id) {
    setSid(event.session_id as string);
    return;
  }
  if (event.type === "assistant" && event.message) {
    const msg = event.message as Record<string, unknown>;
    if (msg.type === "message" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") opts.onToken?.(b.text);
      }
    }
    return;
  }
  if (event.type === "result") {
    if (event.session_id) setSid(event.session_id as string);
    if (typeof event.result === "string" && event.result) opts.onResult?.(event.result);
    return;
  }
}

/**
 * Corre el Claude CLI hasta que termina.
 *
 * Resuelve con `{ exitCode, sessionId, stderr, resultText }` — INCLUSO si el
 * código de salida es != 0 (el que llama decide qué hacer). Solo RECHAZA con
 * `ClaudeSpawnError` si el proceso no pudo siquiera arrancar.
 */
export function spawnClaude(opts: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
  return new Promise((resolve, reject) => {
    const claudePath = getClaudePath();
    // En Windows resolvemos al .exe real para saltar el límite de 8191 chars de cmd.exe.
    const spawnPath = resolveDirectExecutable(claudePath);
    const args = buildArgs(opts);

    const isWindowsShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(spawnPath);
    const spawner = isWindowsShim ? crossSpawn : spawn;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawner(spawnPath, args, {
        cwd: opts.cwd ?? process.cwd(),
        signal: opts.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.end(); // no le mandamos input al subproceso
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return reject(
        new ClaudeSpawnError("Failed to start Claude CLI", {
          code: e?.code,
          path: claudePath,
          message: e?.message,
        })
      );
    }

    let sessionId = opts.sessionId ?? "";
    let resultText = "";
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const setSid = (id: string) => {
      sessionId = id;
      opts.onSessionId?.(id);
    };
    const wrappedResult: SpawnClaudeOptions = {
      ...opts,
      onResult: (t) => {
        resultText += t;
        opts.onResult?.(t);
      },
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line), wrappedResult, setSid);
        } catch {
          /* línea no parseable: ignorar */
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < STDERR_CAP) {
        stderrBuf = (stderrBuf + chunk.toString()).slice(-STDERR_CAP);
      }
    });

    const timeout = setTimeout(() => child.kill(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const e = err as NodeJS.ErrnoException;
      try {
        child.kill();
      } catch {
        /* ya muerto */
      }
      reject(
        new ClaudeSpawnError(err.message || "Claude subprocess error", {
          code: e?.code,
          syscall: e?.syscall,
          path: e?.path,
          stderr: stderrBuf || undefined,
        })
      );
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Drenar lo que quede en el buffer (última línea sin \n).
      if (stdoutBuf.trim()) {
        try {
          handleEvent(JSON.parse(stdoutBuf), wrappedResult, setSid);
        } catch {
          /* ignorar */
        }
      }
      resolve({ exitCode: code, sessionId, stderr: stderrBuf, resultText });
    });
  });
}
