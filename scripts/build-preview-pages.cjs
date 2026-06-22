// Write each slide of a carousel as a standalone 1080x1350 HTML page under
// public/sdf-slides/ so it can be rendered to PNG by any browser at exact size.
// (Workaround for the in-app Puppeteer screenshot hang on this machine.)
const fs = require("fs");
const path = require("path");
const BASE = process.argv[3] || "http://localhost:3000";
const ID = process.argv[2];
if (!ID) { console.error("usage: node scripts/build-preview-pages.cjs <carouselId> [baseUrl]"); process.exit(1); }

const LINK = `<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&family=Mulish:ital,wght@0,400;0,600;0,700;1,600&display=swap" rel="stylesheet">`;

(async () => {
  const r = await fetch(`${BASE}/api/carousels/${ID}`);
  const c = await r.json();
  const slides = (c.slides || c.carousel?.slides || []).slice().sort((a, b) => a.order - b.order);
  const dir = path.join(process.cwd(), "public", "sdf-slides");
  fs.mkdirSync(dir, { recursive: true });
  slides.forEach((s, i) => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">${LINK}<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:1080px;height:1350px;overflow:hidden}</style></head><body>${s.html}</body></html>`;
    fs.writeFileSync(path.join(dir, `slide-${i + 1}.html`), html);
  });
  console.log(`wrote ${slides.length} pages -> public/sdf-slides/ (serve at ${BASE}/sdf-slides/slide-N.html)`);
})();
