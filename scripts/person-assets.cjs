// Pull the best photos of a named person from the Sembradores asset catalog
// (face-recognition tagged) into the carousel app's uploads, ready to drop into
// slides. Usage: node scripts/person-assets.cjs "<Nombre>" [N]
const fs = require("fs");
const path = require("path");

const CATALOG = "C:/Users/mateo/sembradores-catalog/index.json";
const q = process.argv[2];
const N = parseInt(process.argv[3], 10) || 8;

if (!q) { console.error('Uso: node scripts/person-assets.cjs "<Nombre>" [N]'); process.exit(1); }

const { assets } = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const people = [...new Set(assets.flatMap((a) => a.persons || []))].sort();

// resolve the name (exact, then case-insensitive, then substring)
const ql = q.toLowerCase();
const person =
  people.find((p) => p.toLowerCase() === ql) ||
  people.find((p) => p.toLowerCase().includes(ql)) ||
  people.find((p) => p.toLowerCase().split(/\s+/)[0] === ql);
if (!person) {
  console.error(`Persona "${q}" no encontrada.\nDisponibles: ${people.join(", ")}`);
  process.exit(1);
}

// candidates: images of that person, best first (clear portraits > sim > resolution)
let mine = assets.filter((a) => a.type === "image" && (a.persons || []).includes(person));
mine.sort((a, b) => {
  const portA = a.faceCount === 1 ? 1 : 0, portB = b.faceCount === 1 ? 1 : 0;
  const simA = (a.personSims && a.personSims[person]) || 0;
  const simB = (b.personSims && b.personSims[person]) || 0;
  return (portB - portA) || (simB - simA) || (b.size - a.size);
});
mine = mine.slice(0, N);

const slug = person.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dir = path.join(process.cwd(), "public", "uploads", "persons", slug);
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const out = [];
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    try {
      const res = await fetch(`https://drive.google.com/thumbnail?id=${a.id}&sz=w1600`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2000) throw new Error("thumb too small");
      fs.writeFileSync(path.join(dir, `${i + 1}.jpg`), buf);
      out.push({
        file: `/uploads/persons/${slug}/${i + 1}.jpg`,
        description: a.description || a.name,
        category: a.category,
        faces: a.faceCount,
        sim: (a.personSims && a.personSims[person]) || null,
      });
    } catch (e) {
      console.error(`  ! skip ${a.id}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ person, images: out }, null, 2));
  console.log(`${person}: ${out.length} fotos -> public/uploads/persons/${slug}/`);
  out.forEach((o, i) => console.log(`  ${i + 1}. ${o.file}  (${o.faces} caras${o.sim != null ? ", sim " + o.sim : ""}) ${(o.description || "").slice(0, 50)}`));
})().catch((e) => { console.error(e.message); process.exit(1); });
