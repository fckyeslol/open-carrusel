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
import {
  configDirForToken,
  markTokenExhausted,
  tokenLabel,
  tokenTryOrder,
} from "./claude-tokens";

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
  /**
   * Variables de entorno EXTRA para el subproceso (se mezclan sobre process.env).
   * En modo hosteado acá viaja CLAUDE_CODE_OAUTH_TOKEN de la usuaria dueña de la
   * generación, para que el consumo salga de SU seat (Team/Max) y no del server.
   */
  env?: Record<string, string>;
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
  /** El evento `result` vino con `is_error: true` (el turno terminó en error). */
  isError: boolean;
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
function handleEvent(
  event: Record<string, unknown>,
  opts: SpawnClaudeOptions,
  setSid: (id: string) => void,
  setError: () => void
) {
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
    if (event.is_error === true) setError();
    if (typeof event.result === "string" && event.result) opts.onResult?.(event.result);
    return;
  }
}

/**
 * Frases distintivas con las que el CLI reporta que la cuenta llegó a su límite de
 * uso (OAuth Max/Team) o fue rate-limiteada. Se buscan en stderr + texto del
 * `result`. Son lo bastante específicas como para no confundirse con una generación
 * normal (un carrusel sobre "límites" no dispara esto).
 */
const USAGE_LIMIT_RE =
  /usage limit reached|usage limit will reset|reached your usage limit|rate limit|rate.?limited|429|too many requests|quota (?:exceeded|reached)|insufficient quota|out of (?:credits?|quota)|limit will reset at/i;

/**
 * ¿Este resultado indica que la CUENTA llegó a su límite (vs. un error cualquiera)?
 * Requiere que el turno haya terminado mal (exit != 0 o `is_error`) Y que el texto
 * matchee una frase de límite: así un error de python o del proxy interno NO quema
 * una cuenta por error.
 */
export function isUsageLimitError(
  r: Pick<SpawnClaudeResult, "exitCode" | "stderr" | "resultText" | "isError">
): boolean {
  const failed = r.isError || (r.exitCode !== null && r.exitCode !== 0);
  if (!failed) return false;
  return USAGE_LIMIT_RE.test(`${r.stderr}\n${r.resultText}`);
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
        // Solo construir un env custom si hay overrides: heredar es el caso normal.
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
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
    let isError = false;

    const setSid = (id: string) => {
      sessionId = id;
      opts.onSessionId?.(id);
    };
    const setError = () => {
      isError = true;
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
          handleEvent(JSON.parse(line), wrappedResult, setSid, setError);
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
          handleEvent(JSON.parse(stdoutBuf), wrappedResult, setSid, setError);
        } catch {
          /* ignorar */
        }
      }
      resolve({ exitCode: code, sessionId, stderr: stderrBuf, resultText, isError });
    });
  });
}

export interface FallbackResult extends SpawnClaudeResult {
  /**
   * Cuál token central produjo este resultado. `null` = no hay tokens centrales
   * configurados (modo local: el subproceso heredó la auth del server).
   */
  tokenUsed: string | null;
  /** Todas las cuentas configuradas llegaron al límite en esta operación. */
  exhaustedAll: boolean;
}

/**
 * Corre `spawnClaude` con FALLBACK entre las cuentas centrales de Claude.
 *
 * Intenta con el token preferido (el que venía usando la operación, para poder
 * --resume), y si ESE llega a su límite de uso, lo marca en cooldown y reintenta
 * con la siguiente cuenta disponible — SIN reanudar sesión (una sesión de Claude
 * vive en el servidor de SU cuenta; no se puede resumir en otra). Solo reintenta
 * ante un límite de uso: cualquier otro error (o un éxito) corta y se devuelve tal
 * cual, para no rotar cuentas por un bug de generación.
 *
 * `scope` nombra la carpeta de config aislada por token (p. ej. "runner", "central").
 * En modo local (sin tokens centrales) hace un único spawn heredando la auth.
 */
export async function spawnClaudeWithCentralFallback(
  opts: SpawnClaudeOptions,
  scope: string,
  preferredToken?: string
): Promise<FallbackResult> {
  const order = tokenTryOrder(preferredToken);

  // Sin tokens centrales (modo local): un solo spawn, auth heredada del server.
  if (order.length === 0) {
    const res = await spawnClaude(opts);
    return { ...res, tokenUsed: null, exhaustedAll: false };
  }

  let last: SpawnClaudeResult | null = null;
  for (let i = 0; i < order.length; i++) {
    const token = order[i];
    // Solo reanudamos sesión con el token que la creó (el preferido, primer intento).
    const sessionId = i === 0 && token === preferredToken ? opts.sessionId : undefined;
    const env = {
      ...(opts.env ?? {}),
      CLAUDE_CODE_OAUTH_TOKEN: token,
      CLAUDE_CONFIG_DIR: configDirForToken(token, scope),
    };

    const res = await spawnClaude({ ...opts, sessionId, env });
    last = res;

    if (isUsageLimitError(res)) {
      markTokenExhausted(token);
      if (i < order.length - 1) {
        console.warn(
          `[claude-tokens] rotando de cuenta ${tokenLabel(token)} a la siguiente por límite de uso`
        );
        continue;
      }
      return { ...res, tokenUsed: token, exhaustedAll: true };
    }
    return { ...res, tokenUsed: token, exhaustedAll: false };
  }

  // Inalcanzable (order.length > 0 garantiza al menos una vuelta), pero TS lo pide.
  return { ...(last as SpawnClaudeResult), tokenUsed: null, exhaustedAll: true };
}
