/**
 * Espejo en .mjs de DIMENSIONS de src/types/carousel.ts.
 *
 * Existe porque scripts/slide-check.mjs corre con node directo y no puede importar
 * TypeScript. La fuente de verdad sigue siendo carousel.ts; este archivo la copia.
 *
 * Si divergen, el chequeo de lienzo miente. Por eso el orquestador valida la
 * paridad al arrancar (ver verificarParidadDeDimensiones en check-slide.mjs).
 */

export const DIMENSIONES = {
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '9:16': { width: 1080, height: 1920 },
};

export const MAX_SLIDES = 20;
