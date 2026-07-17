// Crop the fire dove from the user's existing flyer + crop the new Ronald portrait.
const sharp = require("sharp");
const path = require("path");

const FLYER = "C:/Users/mateo/Downloads/sembradoresdefecolombia_1780262463_3909446416967408615_1042259261.jpg";
const RON_SRC = path.join(process.cwd(), "ronald2-src.jpg");
const OUT = path.join(process.cwd(), "public", "uploads");

async function crop(src, frac, out) {
  const m = await sharp(src).metadata();
  const left = Math.round(frac.L * m.width);
  const top = Math.round(frac.T * m.height);
  const width = Math.round(frac.W * m.width);
  const height = Math.round(frac.H * m.height);
  await sharp(src).extract({ left, top, width, height }).jpeg({ quality: 92 }).toFile(out);
  console.log(`${path.basename(out)}: src ${m.width}x${m.height} -> ${width}x${height} @ (${left},${top})`);
}

(async () => {
  // fire dove from the flyer (orange flames blend with the poster bg)
  await crop(FLYER, { L: 0.17, T: 0.105, W: 0.64, H: 0.193 }, path.join(OUT, "dove-fire.jpg"));
  // Ronald: clean studio portrait, head + crossed arms
  await crop(RON_SRC, { L: 0.08, T: 0.10, W: 0.84, H: 0.72 }, path.join(OUT, "ronald.jpg"));
})().catch((e) => { console.error(e.message); process.exit(1); });
