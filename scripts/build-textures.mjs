/**
 * Hornea la librería de texturas de material una sola vez.
 *
 * El agente venía reinventando el grano de papel con feTurbulence en cada
 * generación: caro (se comía el presupuesto de 8 min), inconsistente y siempre
 * un poco flojo. Estas texturas se generan una vez, a resolución completa y sin
 * presión de tiempo, y se aplican como overlay — empatan al instante.
 *
 * Se centran en gris 128 para que funcionen con mix-blend-mode: overlay sobre
 * CUALQUIER color de fondo: oscurecen donde la textura es <128 y aclaran donde es
 * >128, preservando el color base. Así una misma textura sirve sobre el rojo de
 * una lámina y el navy de la siguiente.
 *
 * NOTA sobre "real": son procedurales, no fotos. Para reemplazarlas por fotos con
 * licencia, dejá un PNG en public/textures/ y sumá su entrada al manifest — el
 * resto del sistema las trata igual.
 *
 * Uso: node scripts/build-textures.mjs
 */

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const W = 1080;
const H = 1350;
const DIR = path.resolve(process.cwd(), 'public', 'textures');

/** Capa de noise gaussiano gris, centrada en 128, con contraste opcional. */
function capaNoise(width, height, sigma, contraste = 1) {
  let img = sharp({
    create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma } },
  }).greyscale();
  // linear(a,b) = a*px + b. Expandir alrededor de 128 sube el contraste del grano
  // sin correr el centro, para que el overlay siga preservando el color base.
  if (contraste !== 1) img = img.linear(contraste, 128 * (1 - contraste));
  return img.png().toBuffer();
}

/**
 * Cada textura = grano fino (a resolución completa) + moteado (noise chico
 * escalado y difuminado, que da la variación de densidad del papel real).
 */
const TEXTURAS = [
  {
    slug: 'papel-fino',
    nombre: 'Papel fino',
    uso: 'Papel de imprenta liso, afiche mate. Grano sutil y parejo.',
    sigmaGrano: 22,
    contrasteGrano: 1.6,
    opacidadMoteado: 0.1,
  },
  {
    slug: 'carton',
    nombre: 'Cartón',
    uso: 'Cartón crudo, papel reciclado, afiche callejero. Grano apretado y marcado.',
    sigmaGrano: 45,
    contrasteGrano: 2.2,
    opacidadMoteado: 0.18,
  },
  {
    slug: 'papel-rugoso',
    nombre: 'Papel rugoso',
    uso: 'Papel artesanal, tela, superficie con fibra direccional.',
    sigmaGrano: 34,
    contrasteGrano: 1.9,
    opacidadMoteado: 0.14,
    fibra: true,
  },
];

async function construir(t) {
  const grano = await capaNoise(W, H, t.sigmaGrano, t.contrasteGrano);

  // Moteado suave y tenue: solo insinúa variación de densidad. Si pesa mucho,
  // tapa el grano fino y la textura se ve como acuarela en vez de papel.
  const chico = await capaNoise(Math.round(W / 8), Math.round(H / 8), 45);
  const moteado = await sharp(chico).resize(W, H, { kernel: 'cubic' }).blur(6).png().toBuffer();

  let img = sharp(grano).composite([
    { input: moteado, blend: 'overlay', opacity: t.opacidadMoteado },
  ]);

  // Fibra: un leve estirón horizontal del blur del grano da dirección, como las
  // hebras de un papel artesanal.
  if (t.fibra) {
    const base = await img.png().toBuffer();
    const hebras = await sharp(base).blur(2).png().toBuffer();
    img = sharp(base).composite([{ input: hebras, blend: 'soft-light', opacity: 0.5 }]);
  }

  const salida = path.join(DIR, `${t.slug}.png`);
  await img.greyscale().png({ compressionLevel: 9 }).toFile(salida);
  return { slug: t.slug, nombre: t.nombre, uso: t.uso, archivo: `/textures/${t.slug}.png` };
}

await mkdir(DIR, { recursive: true });
const manifest = [];
for (const t of TEXTURAS) {
  manifest.push(await construir(t));
  console.log(`✓ ${t.slug}.png`);
}

await writeFile(
  path.join(DIR, 'manifest.json'),
  JSON.stringify({ generadas: '2026-07-21', procedurales: true, texturas: manifest }, null, 2),
);
console.log(`\n${manifest.length} texturas en public/textures/`);
