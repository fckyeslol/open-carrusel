// Crop Ronald (right side, blue shirt, hands raised) from the candid stage photo
// into a portrait for the assembly flyer frame.
const sharp = require("sharp");
const path = require("path");
const SRC = process.argv[2] || "/tmp/ronald-src.jpg";
const OUT = path.join(process.cwd(), "public", "uploads", "ronald.jpg");

// crop fractions tuned to Ronald's head+torso (he's center-right)
const L = 0.42, T = 0.09, W = 0.40, H = 0.66;

(async () => {
  const img = sharp(SRC);
  const m = await img.metadata();
  const left = Math.round(L * m.width);
  const top = Math.round(T * m.height);
  const width = Math.round(W * m.width);
  const height = Math.round(H * m.height);
  await sharp(SRC).extract({ left, top, width, height }).jpeg({ quality: 90 }).toFile(OUT);
  console.log(`source ${m.width}x${m.height} -> crop ${width}x${height} @ (${left},${top}) -> ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
