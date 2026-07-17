// Save the assembly flyer (public/sdf-slides/asamblea.html) into the app as a
// 1-slide 4:5 carousel so it lives in the library and exports via the UI.
const fs = require("fs");
const path = require("path");
const BASE = process.argv[2] || "http://localhost:3000";

const FONTS = "https://fonts.googleapis.com/css2?family=Anton&family=Montserrat:wght@600;700;800;900&family=Cormorant+Garamond:ital,wght@0,600;1,600&family=Dancing+Script:wght@600;700&display=swap";

const html = fs.readFileSync(path.join(process.cwd(), "public", "sdf-slides", "asamblea.html"), "utf8");
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].trim();
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1].trim();

// Self-contained slide: own @import for fonts (reliable) + the CSS + the body markup.
const slideHtml = `<style>\n@import url('${FONTS}');\n${css}\n</style>\n${body}`;

async function main() {
  const cRes = await fetch(`${BASE}/api/carousels`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Asamblea — Miércoles 24 de junio", aspectRatio: "4:5" }),
  });
  const c = JSON.parse(await cRes.text());
  const id = c.id || c.carousel?.id;
  if (!id) throw new Error("no carousel id");
  const sRes = await fetch(`${BASE}/api/carousels/${id}/slides`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html: slideHtml, notes: "Flyer asamblea 24 jun — Y RECIBIRÁN PODER" }),
  });
  console.log("carousel:", id, "| add slide:", sRes.ok ? "OK" : "FAIL " + sRes.status);
  console.log("CAROUSEL_URL=" + BASE + "/carousel/" + id);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
