#!/usr/bin/env node
// Open Carrusel — environment diagnostic.
// Pure Node, no dependencies, safe to run pre-`npm install`.
// Exit 0 if everything required is OK; exit 1 on any required failure.

import { existsSync, statSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import http from "node:http";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const CHECK = "✓";
const FAIL = "✗";
const INFO = "○";
const WARN = "!";

const checks = [];
let hardFailures = 0;

function add(symbol, label, detail, fatal = false) {
  checks.push({ symbol, label, detail });
  if (fatal && symbol === FAIL) hardFailures += 1;
}

function tryExec(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

// 1. Node version
const major = Number(process.versions.node.split(".")[0]);
if (major >= 20) {
  add(CHECK, "Node", `v${process.versions.node}`);
} else {
  add(FAIL, "Node", `v${process.versions.node} (need ≥20 — install from https://nodejs.org)`, true);
}

// 2. Claude CLI
const claudeEnv = process.env.CLAUDE_CLI_PATH;
const candidates = [
  claudeEnv,
  join(homedir(), ".local/bin/claude"),
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
  join(homedir(), ".npm-global/bin/claude"),
].filter(Boolean);

let claudePath = null;
const which = tryExec(platform() === "win32" ? "where claude" : "command -v claude");
if (which) claudePath = which.split("\n")[0];
if (!claudePath) {
  for (const c of candidates) {
    if (existsSync(c)) {
      claudePath = c;
      break;
    }
  }
}
if (claudePath) {
  add(CHECK, "Claude CLI", claudePath);
} else {
  add(FAIL, "Claude CLI", "not found — install from https://docs.anthropic.com/en/docs/claude-code", true);
}

// 3. Dependencies
if (existsSync("node_modules") && statSync("node_modules").isDirectory()) {
  add(CHECK, "Dependencies", "node_modules present");
} else {
  add(FAIL, "Dependencies", "node_modules missing — run `/start` or `npm install`", true);
}

// 4. Data files
const dataFiles = ["brand.json", "carousels.json", "templates.json", "staged-actions.json", "style-presets.json"];
const missingData = dataFiles.filter((f) => !existsSync(join("data", f)));
if (missingData.length === 0) {
  add(CHECK, "Data files", "all 5 seeded");
} else if (missingData.length === dataFiles.length) {
  add(FAIL, "Data files", "none seeded — run `/start` or `npm run setup`", true);
} else {
  add(WARN, "Data files", `${missingData.length} missing: ${missingData.join(", ")} — run /start`);
}

// 5. Port 3000
let portStatus = "free";
let portFree = true;
if (platform() !== "win32") {
  const pid = tryExec("lsof -ti :3000");
  if (pid) {
    portStatus = `in use by PID ${pid.split("\n")[0]} — \`/stop\` to kill`;
    portFree = false;
  }
} else {
  // Best-effort on Windows; non-fatal
  const out = tryExec("netstat -ano -p tcp");
  if (out && /:3000\s+.+LISTENING/i.test(out)) {
    portStatus = "in use (run `netstat -ano | findstr :3000` for details)";
    portFree = false;
  }
}
add(portFree ? CHECK : INFO, "Port 3000", portStatus);

// 6. Instagram residential proxy (IG_PROXY)
//
// Este chequeo existe por el incidente del 2026-07-28: el proveedor (Litport) empezó
// a devolver `500 / X-Proxy-Error-Code: 2` a TODO CONNECT, la ingesta moría con
// `net::ERR_TUNNEL_CONNECTION_FAILED` y desde la UI parecía un problema del post.
// Distinguir "el proxy no abre el túnel" de "Instagram no da el JSON" a mano lleva
// media hora; acá son 10 segundos.
//
// NO es fatal: desde el arreglo, `withProxyFallback` (src/lib/instagram.ts) reintenta
// por la IP directa, que en una máquina residencial alcanza sola. Un proxy caído es
// degradación, no falla dura.

/** Lee una var de entorno, cayendo a los .env del repo (el doctor no los carga). */
function envOrDotenv(key) {
  if (process.env[key]?.trim()) return process.env[key].trim();
  for (const file of [".env.local", ".env", ".env.hosted"]) {
    if (!existsSync(file)) continue;
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
        if (m && m[1] === key) {
          const value = m[2].trim().replace(/^["']|["']$/g, "");
          if (value) return value;
        }
      }
    } catch {
      // .env ilegible: se ignora, el chequeo queda como "no configurado"
    }
  }
  return null;
}

/**
 * Abre un CONNECT contra el proxy y devuelve el status. Es exactamente lo que hace
 * Chrome antes de navegar, así que reproduce el fallo real sin levantar Chrome.
 */
function probeProxyTunnel(raw, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return resolve({ ok: false, detail: "IG_PROXY no es una URL válida (esperado http://user:pass@host:puerto)" });
    }
    const target = "www.instagram.com:443";
    const headers = { Host: target };
    if (u.username) {
      const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || "")}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(creds).toString("base64")}`;
    }
    const where = `${u.hostname}:${u.port || 80}`;

    const req = http.request({
      host: u.hostname,
      port: Number(u.port) || 80,
      method: "CONNECT",
      path: target,
      headers,
      timeout: timeoutMs,
    });
    /** Un CONNECT rechazado (500, 407, 403…): el proxy contestó pero no abrió nada. */
    const rejected = (res) => {
      const why = res.headers?.["x-proxy-error-message"];
      return {
        ok: false,
        detail:
          `${where} — el proxy RECHAZÓ el túnel (HTTP ${res.statusCode}` +
          `${why ? `: ${why}` : ""}). Revisá plan/tráfico/puerto en el panel del proveedor. ` +
          `La ingesta sigue por IP directa (sirve en IP residencial, NO desde la nube).`,
      };
    };

    // OJO: Node emite `connect` para CUALQUIER respuesta a un CONNECT, no solo 2xx
    // (llhttp marca toda respuesta a CONNECT como upgrade). Sin chequear el status,
    // este mismo chequeo daba "túnel OK" sobre el 500 de Litport — o sea justo el
    // fallo que vino a detectar. El status manda.
    req.on("connect", (res, socket) => {
      socket.destroy();
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      resolve(ok ? { ok: true, detail: `${where} — túnel OK` } : rejected(res));
    });
    // Red de seguridad: si alguna versión lo entrega como respuesta normal.
    req.on("response", (res) => {
      resolve(rejected(res));
      res.resume();
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, detail: `${where} — sin respuesta en ${timeoutMs / 1000}s` });
    });
    req.on("error", (err) => resolve({ ok: false, detail: `${where} — ${err.message}` }));
    req.end();
  });
}

/** Todos los proxies del pool: IG_PROXY (lista) + IG_PROXY_1..20. Ver ig-proxies.ts. */
function collectProxies() {
  const raws = [];
  const push = (value) => {
    if (!value) return;
    for (const part of value.split(/[\s,]+/)) {
      const trimmed = part.trim();
      if (trimmed) raws.push(trimmed);
    }
  };
  push(envOrDotenv("IG_PROXY"));
  for (let i = 1; i <= 20; i++) push(envOrDotenv(`IG_PROXY_${i}`));
  return [...new Set(raws)];
}

const igProxies = collectProxies();
if (igProxies.length === 0) {
  const hint = envOrDotenv("IG_SESSIONID") ? " (usás IG_SESSIONID)" : "";
  add(INFO, "IG proxy", `ninguno configurado — Instagram sale por la IP directa${hint}`);
} else {
  // Se prueban TODOS, no solo el primero: el sentido del pool es que si el primario
  // se cae haya otro sano detrás, y eso solo se sabe probándolos.
  const results = await Promise.all(igProxies.map((raw) => probeProxyTunnel(raw)));
  const okCount = results.filter((r) => r.ok).length;
  results.forEach((result, i) => {
    const label = igProxies.length === 1 ? "IG proxy" : `IG proxy ${i + 1}`;
    add(result.ok ? CHECK : WARN, label, result.detail);
  });
  if (igProxies.length > 1) {
    add(
      okCount > 0 ? CHECK : WARN,
      "IG proxy pool",
      okCount > 0
        ? `${okCount} de ${igProxies.length} con túnel OK — hay fallback`
        : `los ${igProxies.length} caídos — la ingesta cae a IP directa (no sirve desde la nube)`
    );
  }
}

// Output
const labelWidth = Math.max(...checks.map((c) => c.label.length));
console.log("");
for (const { symbol, label, detail } of checks) {
  console.log(`  ${symbol}  ${label.padEnd(labelWidth)}   ${detail}`);
}
console.log("");

if (hardFailures > 0) {
  console.log(`  ${hardFailures} required check${hardFailures > 1 ? "s" : ""} failed.`);
  process.exit(1);
} else {
  process.exit(0);
}
