#!/usr/bin/env node
// Cross-platform setup for Open Carrusel. Runs on macOS, Linux, and Windows.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { importAvatars } from "./import-avatars.mjs";

const ROOT = process.cwd();
// Built-in spawn only — setup.mjs must run on a bare clone BEFORE `npm install`,
// so it cannot depend on any package (e.g. cross-spawn). shell:true lets Windows
// resolve npm/where via npm.cmd, and macOS/Linux resolve npm/which on PATH.
const SHELL = process.platform === "win32";

function log(msg) {
  process.stdout.write(msg + "\n");
}

function runSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: SHELL, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${res.status}`);
  }
}

function tryProbeClaude() {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  try {
    const r = spawnSync(cmd, ["claude"], {
      encoding: "utf-8",
      timeout: 2000,
      shell: SHELL,
    });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).find((l) => l.trim());
      if (first && fs.existsSync(first.trim())) return first.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

function findClaudePath() {
  if (
    process.env.CLAUDE_CLI_PATH &&
    fs.existsSync(process.env.CLAUDE_CLI_PATH)
  ) {
    return process.env.CLAUDE_CLI_PATH;
  }

  const home = os.homedir();
  const candidates = [];

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    candidates.push(
      path.join(appData, "npm", "claude.cmd"),
      path.join(appData, "npm", "claude.exe"),
      path.join(localAppData, "Programs", "claude", "claude.exe")
    );
  } else {
    candidates.push(
      path.join(home, ".local/bin/claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
      path.join(home, ".npm-global/bin/claude")
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  return tryProbeClaude();
}

// Recursively copy files from src into dest, skipping any that already exist.
function copyDirIfMissing(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) count += copyDirIfMissing(s, d);
    else if (!fs.existsSync(d)) {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

function seedDataFiles() {
  const dataDir = path.join(ROOT, "data");
  const uploadsDir = path.join(ROOT, "public", "uploads");
  const exportsDir = path.join(dataDir, "exports");
  const fontCacheDir = path.join(dataDir, ".font-cache");
  const brandsDir = path.join(dataDir, "brands");

  for (const dir of [dataDir, uploadsDir, exportsDir, fontCacheDir, brandsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Install bundled seed assets (brand profiles, logo, icons) on first run.
  // data/ and public/uploads/ are gitignored, so the repo ships them under seed/.
  const seedDir = path.join(ROOT, "seed");
  const copiedUploads = copyDirIfMissing(path.join(seedDir, "uploads"), uploadsDir);
  const copiedBrands = copyDirIfMissing(path.join(seedDir, "brands"), brandsDir);
  if (copiedUploads) log(`  Installed ${copiedUploads} seed asset(s) into public/uploads`);
  if (copiedBrands) log(`  Installed ${copiedBrands} brand profile(s) into data/brands`);

  const genericBrand = {
    name: "",
    colors: {
      primary: "#1a1a2e",
      secondary: "#16213e",
      accent: "#e94560",
      background: "#ffffff",
      surface: "#f5f5f5",
    },
    fonts: { heading: "Inter", body: "Inter" },
    customFonts: [],
    logoPath: null,
    styleKeywords: [],
    createdAt: "",
    updatedAt: "",
  };

  // Active brand: prefer the bundled seed/brand.json, else a neutral default.
  const brandPath = path.join(dataDir, "brand.json");
  if (!fs.existsSync(brandPath)) {
    const seedBrand = path.join(seedDir, "brand.json");
    if (fs.existsSync(seedBrand)) {
      fs.copyFileSync(seedBrand, brandPath);
      log("  Created data/brand.json (from seed)");
    } else {
      fs.writeFileSync(brandPath, JSON.stringify(genericBrand), "utf-8");
      log("  Created data/brand.json");
    }
  }

  const seeds = {
    "carousels.json": { carousels: [] },
    "templates.json": { templates: [] },
    "staged-actions.json": { actions: [] },
    "style-presets.json": { presets: [] },
  };

  for (const [name, contents] of Object.entries(seeds)) {
    const filePath = path.join(dataDir, name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(contents), "utf-8");
      log(`  Created ${path.relative(ROOT, filePath)}`);
    }
  }
}

function writeEnvLocal(claudePath) {
  const envPath = path.join(ROOT, ".env.local");
  let existing = "";
  try {
    existing = fs.readFileSync(envPath, "utf-8");
  } catch {
    // file doesn't exist yet
  }

  const lines = existing
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("CLAUDE_CLI_PATH="));

  lines.push(`CLAUDE_CLI_PATH=${claudePath}`);

  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
}

async function main() {
  log("🎠 Setting up Open Carrusel...");
  log("");

  log(
    "📦 Installing dependencies (this may take a moment — Puppeteer downloads Chromium ~300MB)..."
  );
  runSync("npm", ["install"]);
  log("");

  log("📁 Creating data directories...");
  seedDataFiles();
  log("");

  // Genera los presets de avatar desde los ADN versionados (30x/avatars/*).
  // Sin esto el selector "Elegí un avatar" queda vacío en un clon nuevo, porque
  // data/style-presets.json está gitignored y no viaja con el repo.
  log("🎭 Preparando avatares de 30x...");
  try {
    const r = await importAvatars({ quiet: true });
    log(`  ✅ ${r.imported} avatar(es) listos`);
  } catch (err) {
    log(`  ⚠️  No se pudieron preparar los avatares: ${err?.message ?? err}`);
  }
  log("");

  log("🔍 Looking for Claude CLI...");
  const claudePath = findClaudePath();
  if (claudePath) {
    log(`  ✅ Found Claude CLI at: ${claudePath}`);
    writeEnvLocal(claudePath);
  } else {
    log("  ⚠️  Claude CLI not found.");
    log("  The app will run without AI features.");
    log(
      "  To enable AI: install Claude CLI from https://docs.anthropic.com/en/docs/claude-code"
    );
    log("  Then set CLAUDE_CLI_PATH in .env.local");
    if (process.platform === "win32") {
      log("  On Windows, run `where claude` to find the path (likely ...\\npm\\claude.cmd).");
    }
  }
  log("");

  if (process.env.OC_SETUP_NO_DEV) {
    log("✅ Setup complete. (Dev server start skipped — caller will handle it.)");
    return;
  }

  log("🚀 Starting Open Carrusel...");
  log("  Open http://localhost:3000 in your browser");
  log("");
  runSync("npm", ["run", "dev"]);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
