/**
 * Render de prueba: toma un formato HTML de avatar y lo screenshotea a PNG con el
 * MISMO motor que usa la app (Puppeteer 1080×1350). Valida fuente + diseño sin
 * levantar el server. Uso: node scripts/render-test.mjs <slug> <archivo.html>
 */
import puppeteer from "puppeteer";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const slug = process.argv[2] || "cinthya";
const file = process.argv[3] || "formato-1-portada.html";
const ROOT = process.cwd();
const htmlPath = path.join(ROOT, "public", "30x-slides", slug, file);
const publicDir = path.join(ROOT, "public");

function findChrome() {
  const local = process.env.LOCALAPPDATA || "";
  const cands = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return cands.find((p) => existsSync(p));
}

const exe = findChrome();
const browser = await puppeteer.launch({
  headless: true,
  ...(exe ? { executablePath: exe } : {}),
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });

let html = await readFile(htmlPath, "utf-8");
// Resolver /uploads/ a file:// para que las imágenes (si existen) carguen.
html = html.replace(/(["'(])\/uploads\//g, `$1file:///${publicDir.replace(/\\/g, "/")}/uploads/`);

await page.setContent(html, { waitUntil: "networkidle2", timeout: 20000 });
await page.evaluate(() => document.fonts.ready).catch(() => {});
const out = path.join(ROOT, `render-${slug}-${file.replace(/\.html$/, "")}.png`);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1350 }, captureBeyondViewport: false });
await browser.close();
console.log("OK →", out);
