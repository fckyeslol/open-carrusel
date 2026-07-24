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
 * una lámina y el navy de la siguiente. Esto vale igual para el grano, los
 * puntos del halftone, las líneas de la cuadrícula y los pliegues del papel: todo
 * queda anclado en 128 y solo desvía donde hay materia.
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
const FECHA = '2026-07-23';

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

/** Guarda un buffer como PNG gris comprimido y devuelve la entrada del manifest. */
async function guardar(img, meta) {
  const salida = path.join(DIR, `${meta.slug}.png`);
  // img puede ser un Buffer (SVG/PNG) o un pipeline Sharp ya armado.
  const pipe = Buffer.isBuffer(img) ? sharp(img) : img;
  await pipe.greyscale().png({ compressionLevel: 9 }).toFile(salida);
  return { slug: meta.slug, nombre: meta.nombre, uso: meta.uso, archivo: `/textures/${meta.slug}.png` };
}

// ─── Texturas de grano ──────────────────────────────────────────────────────
// Grano fino (a resolución completa) + moteado (noise chico escalado y difuminado,
// que da la variación de densidad del papel real). `opacidadMoteado: 0` = grano puro.
const GRANO = [
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
  {
    slug: 'granulado',
    nombre: 'Granulado',
    uso: 'Grano de película parejo y fino, sin moteado. Efecto foto/impreso limpio.',
    sigmaGrano: 30,
    contrasteGrano: 1.8,
    opacidadMoteado: 0,
  },
];

async function construirGrano(t) {
  const grano = await capaNoise(W, H, t.sigmaGrano, t.contrasteGrano);

  let img = sharp(grano);

  // Moteado suave y tenue: solo insinúa variación de densidad. Si pesa mucho,
  // tapa el grano fino y la textura se ve como acuarela en vez de papel.
  if (t.opacidadMoteado > 0) {
    const chico = await capaNoise(Math.round(W / 8), Math.round(H / 8), 45);
    const moteado = await sharp(chico).resize(W, H, { kernel: 'cubic' }).blur(6).png().toBuffer();
    img = sharp(grano).composite([{ input: moteado, blend: 'overlay', opacity: t.opacidadMoteado }]);
  }

  // Fibra: un leve estirón horizontal del blur del grano da dirección, como las
  // hebras de un papel artesanal.
  if (t.fibra) {
    const base = await img.png().toBuffer();
    const hebras = await sharp(base).blur(2).png().toBuffer();
    img = sharp(base).composite([{ input: hebras, blend: 'soft-light', opacity: 0.5 }]);
  }

  return guardar(img, t);
}

// ─── Papel arrugado ─────────────────────────────────────────────────────────
// Campo de altura suave → emboss (luz de facetas centrada en 128) + grano fino.
// El emboss usa un kernel de suma 0 con offset 128: las zonas planas quedan en 128
// (overlay neutro) y solo los pliegues suben/bajan. Da papel estrujado, no ruido.
async function construirArrugado() {
  const chico = await capaNoise(Math.round(W / 6), Math.round(H / 6), 55);
  const campo = await sharp(chico).resize(W, H, { kernel: 'cubic' }).blur(10).png().toBuffer();

  const facetas = await sharp(campo)
    .convolve({ width: 3, height: 3, kernel: [-2, -1, 0, -1, 0, 1, 0, 1, 2], scale: 1, offset: 128 })
    .linear(1.5, 128 * (1 - 1.5)) // más contraste en los pliegues, sin correr el centro
    .png()
    .toBuffer();

  const grano = await capaNoise(W, H, 16, 1.4);
  const img = sharp(facetas).composite([{ input: grano, blend: 'overlay', opacity: 0.45 }]);

  return guardar(img, {
    slug: 'papel-arrugado',
    nombre: 'Papel arrugado',
    uso: 'Papel estrujado: pliegues y facetas con luz suave. Superficie de papel manipulado.',
  });
}

// ─── Halftone ───────────────────────────────────────────────────────────────
// Grilla regular de puntos más oscuros que 128: con overlay oscurecen el centro de
// cada punto y dejan el fondo intacto → trama de impresión CMYK.
async function construirHalftone() {
  const paso = 22;
  const r = 5.5;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#808080"/>
    <defs>
      <pattern id="h" width="${paso}" height="${paso}" patternUnits="userSpaceOnUse">
        <circle cx="${paso / 2}" cy="${paso / 2}" r="${r}" fill="#5a5a5a"/>
      </pattern>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#h)"/>
  </svg>`;

  return guardar(Buffer.from(svg), {
    slug: 'halftone',
    nombre: 'Halftone',
    uso: 'Trama de puntos de impresión (CMYK/riso). Da aire retro-editorial e impreso.',
  });
}

// ─── Frost ──────────────────────────────────────────────────────────────────
// Niebla difusa de baja frecuencia (la difusión del vidrio escarchado) + destellos
// cristalinos dispersos. Los destellos van en `screen`: el negro es identidad, así
// que la niebla queda centrada en 128 (overlay neutro) y solo los puntos aclaran.
async function construirFrost() {
  const chico = await capaNoise(Math.round(W / 10), Math.round(H / 10), 60);
  const niebla = await sharp(chico)
    .resize(W, H, { kernel: 'cubic' })
    .blur(4)
    .linear(1.6, 128 * (1 - 1.6)) // manchas suaves visibles, sin correr el centro
    .png()
    .toBuffer();

  // Destellos: puntos claros aislados (threshold alto sobre noise fino) sobre negro.
  const sparkle = await sharp(await capaNoise(W, H, 80)).threshold(205).blur(0.6).png().toBuffer();

  const img = sharp(niebla).composite([{ input: sparkle, blend: 'screen', opacity: 0.55 }]);

  return guardar(img, {
    slug: 'frost',
    nombre: 'Frost',
    uso: 'Vidrio escarchado: difusión nebulosa con destellos cristalinos. Superficie fría y traslúcida.',
  });
}

// ─── Cuadrícula ─────────────────────────────────────────────────────────────
// Grilla técnica de líneas finas apenas más oscuras que 128 → cuaderno/blueprint
// sutil sobre cualquier color.
async function construirCuadricula() {
  const paso = 54;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#808080"/>
    <defs>
      <pattern id="g" width="${paso}" height="${paso}" patternUnits="userSpaceOnUse">
        <path d="M ${paso} 0 L 0 0 0 ${paso}" fill="none" stroke="#585858" stroke-width="1.5"/>
      </pattern>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
  </svg>`;

  return guardar(Buffer.from(svg), {
    slug: 'cuadricula',
    nombre: 'Cuadrícula',
    uso: 'Grilla técnica de líneas finas (cuaderno/blueprint). Estructura sutil de fondo.',
  });
}

// ─── Build ──────────────────────────────────────────────────────────────────
await mkdir(DIR, { recursive: true });

const manifest = [];
for (const t of GRANO) manifest.push(await construirGrano(t));
manifest.push(await construirArrugado());
manifest.push(await construirHalftone());
manifest.push(await construirFrost());
manifest.push(await construirCuadricula());

for (const t of manifest) console.log(`✓ ${t.slug}.png`);

await writeFile(
  path.join(DIR, 'manifest.json'),
  JSON.stringify({ generadas: FECHA, procedurales: true, texturas: manifest }, null, 2),
);
console.log(`\n${manifest.length} texturas en public/textures/`);
