#!/usr/bin/env node
// Daily launcher for the 30x designers.
//
// Does three things, in order:
//   1. Pulls the latest code from GitHub (safe: fast-forward only, never
//      touches /data or /public/uploads, never discards local work).
//   2. Runs `npm install` only if dependencies changed.
//   3. Opens the browser on /30x and starts the dev server.
//
// This is the command behind `npm run abrir`. It is designer-facing on purpose:
// `npm run dev` stays pure for development (no auto-update), so a developer with
// uncommitted work never gets surprised.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = process.cwd();
const URL = "http://localhost:3000/30x";
const BROWSER_DELAY_S = 8; // seconds to wait before opening the browser
const SHELL = process.platform === "win32"; // let Windows resolve npm.cmd / git.cmd

function log(msg) {
  process.stdout.write(msg + "\n");
}

// Run a command and capture stdout. Never throws — returns "" on any failure.
function capture(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf-8", shell: SHELL, timeout: 60000 });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout.trim();
  } catch {
    // ignore
  }
  return "";
}

function hasGit() {
  const probe = process.platform === "win32" ? "where" : "which";
  return capture(probe, ["git"]) !== "";
}

// Pull the latest code, safely. Any failure is non-fatal: we log a friendly
// note and let the app start on whatever version is already here.
function autoUpdate() {
  if (!fs.existsSync(path.join(ROOT, ".git"))) {
    // Not a git clone (e.g. still the plain zip). Nothing to update from.
    return;
  }
  if (!hasGit()) {
    log("ℹ️  (git no está instalado — abro con la versión actual)");
    return;
  }

  log("🔄 Buscando actualizaciones...");

  const before = capture("git", ["rev-parse", "HEAD"]);

  // Fetch the latest main. If this fails (no internet), just carry on.
  const fetch = spawnSync("git", ["fetch", "--quiet", "origin", "main"], {
    stdio: "ignore",
    shell: SHELL,
    timeout: 60000,
  });
  if (fetch.status !== 0) {
    log("ℹ️  (sin conexión ahora — abro con la versión actual)");
    return;
  }

  const remote = capture("git", ["rev-parse", "origin/main"]);
  if (!remote || remote === before) {
    log("✅ Ya tenés la última versión.");
    return;
  }

  // Refuse to touch a dirty working tree so nobody's local edits are lost.
  const dirty = capture("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    log("⚠️  Hay cambios locales sin guardar — no actualizo (abro con la versión actual).");
    return;
  }

  // Fast-forward only: never rewrites history, never discards work. If the
  // branch somehow diverged, this fails cleanly and we keep the current code.
  const merge = spawnSync("git", ["merge", "--ff-only", "origin/main"], {
    stdio: "ignore",
    shell: SHELL,
  });
  if (merge.status !== 0) {
    log("⚠️  No se pudo actualizar automáticamente — abro con la versión actual. Avisale a Mateo.");
    return;
  }

  log("✅ Actualizado a la última versión.");

  // Reinstall dependencies only when they actually changed.
  const changed = capture("git", [
    "diff",
    "--name-only",
    before,
    remote,
    "--",
    "package.json",
    "package-lock.json",
  ]);
  if (changed) {
    log("📦 Instalando cambios nuevos (un momento)...");
    spawnSync("npm", ["install"], { stdio: "inherit", shell: SHELL });
  }
}

// Regenera los presets de avatar desde los ADN versionados (30x/avatars/*).
// data/style-presets.json está gitignored, así que un clon nuevo llega sin
// avatares y el `git pull` no los trae; esto los reconstruye en cada apertura
// (idempotente) y propaga cualquier ADN actualizado tras el pull. Nunca es
// fatal: si algo falla, la app abre con los avatares que ya haya.
function refreshAvatars() {
  const r = spawnSync("node", [path.join("scripts", "import-avatars.mjs")], {
    encoding: "utf-8",
    shell: SHELL,
    timeout: 30000,
  });
  // No es fatal, pero NO lo silenciamos: si el sembrado falla, el selector
  // "Elegí un avatar" queda vacío y sin este aviso el fallo es invisible.
  if (r.status !== 0) {
    log("⚠️  No se pudieron preparar los avatares — avisale a Mateo con esto:");
    const detail = (r.stderr || r.stdout || r.error?.message || "").trim();
    if (detail) log("   " + detail.split("\n").slice(-3).join("\n   "));
  }
}

// Open the browser on /30x after a short delay, detached, so it happens while
// the dev server is booting in the foreground.
function openBrowserSoon() {
  let cmd, args;
  if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", `timeout /t ${BROWSER_DELAY_S} >nul & start "" "${URL}"`];
  } else if (process.platform === "darwin") {
    cmd = "bash";
    args = ["-c", `sleep ${BROWSER_DELAY_S}; open "${URL}"`];
  } else {
    cmd = "bash";
    args = ["-c", `sleep ${BROWSER_DELAY_S}; xdg-open "${URL}"`];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // If it can't open the browser, the user can navigate to the URL by hand.
  }
}

function main() {
  log("============================================================");
  log("   GENERADOR DE CARRUSELES 30x");
  log("------------------------------------------------------------");
  log("   Dejá ESTA ventana abierta mientras trabajás.");
  log("   Chrome se abre solo en unos segundos.");
  log("============================================================");
  log("");

  autoUpdate();
  refreshAvatars();
  log("");

  log(`🚀 Abriendo el programa... (${URL})`);
  openBrowserSoon();

  // Foreground: keeps running until the user closes the window.
  const dev = spawnSync("npm", ["run", "dev"], { stdio: "inherit", shell: SHELL });
  process.exit(dev.status ?? 0);
}

main();
