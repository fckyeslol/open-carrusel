// Worker aislado para quitar fondos con @imgly/background-removal-node.
//
// ¿Por qué un proceso aparte? El paquete trae su propio sharp (0.32.x con su
// libvips/GLib nativo) y Next.js ya carga otro sharp (0.34.x). Dos libvips en
// el mismo proceso colisionan en el registro de tipos de GLib y el proceso
// muere con segfault — llevándose el dev server entero. Corriendo esto como
// subproceso, cada proceso carga UNA sola sharp y un crash del modelo nunca
// mata el servidor.
//
// Uso: node scripts/remove-bg-worker.mjs <inputPath> <outputPath> <mime>
import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath, mime] = process.argv.slice(2);
if (!inputPath || !outputPath || !mime) {
  console.error("uso: node remove-bg-worker.mjs <inputPath> <outputPath> <mime>");
  process.exit(2);
}

try {
  const { removeBackground } = await import("@imgly/background-removal-node");
  const input = await readFile(inputPath);
  const result = await removeBackground(
    new Blob([new Uint8Array(input)], { type: mime }),
    { output: { format: "image/png", quality: 1 } }
  );
  await writeFile(outputPath, Buffer.from(await result.arrayBuffer()));
  process.exit(0);
} catch (error) {
  console.error("remove-bg-worker error:", error?.message ?? error);
  process.exit(1);
}
