// Switch the active Open Carrusel brand.
//   node scripts/switch-brand.mjs sembradores
//   node scripts/switch-brand.mjs mateo
// Brand profiles live in data/brands/<name>.json. Running with no/unknown name
// lists the available profiles. The active brand is data/brand.json.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brandsDir = join(root, "data", "brands");
const target = join(root, "data", "brand.json");

const available = () =>
  existsSync(brandsDir)
    ? readdirSync(brandsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
    : [];

const name = process.argv[2];
if (!name || !existsSync(join(brandsDir, `${name}.json`))) {
  console.log("Usage: node scripts/switch-brand.mjs <name>");
  console.log("Available brands:", available().join(", ") || "(none — add data/brands/<name>.json)");
  process.exit(name ? 1 : 0);
}

const cfg = JSON.parse(readFileSync(join(brandsDir, `${name}.json`), "utf8"));
cfg.updatedAt = new Date().toISOString();
writeFileSync(target, JSON.stringify(cfg, null, 2));
console.log(`Active brand -> "${cfg.name}" (${name}). Refresh the app (or restart dev server) to pick it up.`);
