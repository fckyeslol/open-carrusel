import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

/**
 * On Windows, .cmd shims route through cmd.exe which has an 8191-char command line limit.
 * This parses the .cmd file to find the actual .exe, so we can spawn via CreateProcess
 * directly (32767-char limit — enough for long prompts + system prompts).
 */
export function resolveDirectExecutable(claudePath: string): string {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(claudePath)) {
    return claudePath;
  }
  try {
    const content = fs.readFileSync(claudePath, "utf-8");
    // Matches lines like: "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
    const match = content.match(/"(?:%dp0%\\)([^"\r\n]+\.exe)"/i);
    if (match) {
      const resolved = path.join(path.dirname(claudePath), match[1]);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    // fall through
  }
  return claudePath;
}

function buildCandidates(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");

    candidates.push(
      path.join(appData, "npm", "claude.cmd"),
      path.join(appData, "npm", "claude.exe"),
      path.join(localAppData, "Programs", "claude", "claude.exe"),
      path.join(home, "AppData", "Roaming", "npm", "claude.cmd")
    );
  } else {
    candidates.push(
      path.join(home, ".local/bin/claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
      path.join(home, ".npm-global/bin/claude")
    );
  }

  return candidates;
}

function probePath(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? ["claude"] : ["-v", "claude"];
    const result = spawnSync(cmd, args, {
      encoding: "utf-8",
      shell: process.platform !== "win32",
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) {
      const first = result.stdout.split(/\r?\n/).find((l) => l.trim());
      if (first && fs.existsSync(first.trim())) return first.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

export function findClaudePath(): string | null {
  if (process.env.CLAUDE_CLI_PATH && fs.existsSync(process.env.CLAUDE_CLI_PATH)) {
    return process.env.CLAUDE_CLI_PATH;
  }
  for (const candidate of buildCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return probePath();
}

export function getClaudePath(): string {
  const found = findClaudePath();
  if (found) return found;
  throw new Error(
    "Claude CLI not found. Install it from https://docs.anthropic.com/en/docs/claude-code or set CLAUDE_CLI_PATH in .env.local"
  );
}

export function isClaudeAvailable(): boolean {
  return findClaudePath() !== null;
}
