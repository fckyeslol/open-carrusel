// Formatos aceptados por /api/upload, para los `accept` de los inputs de archivo.
// Mantener en sync con las magic bytes de src/app/api/upload/route.ts.

/** Imágenes raster que el backend procesa con Sharp. */
export const RASTER_IMAGE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/avif,image/tiff," +
  ".png,.jpg,.jpeg,.webp,.gif,.avif,.tif,.tiff";

/** Raster + SVG (el backend sanitiza el SVG y lo guarda tal cual). */
export const IMAGE_ACCEPT = `${RASTER_IMAGE_ACCEPT},image/svg+xml,.svg`;

/** Texto para mostrar en la UI junto a los uploaders de imágenes. */
export const IMAGE_FORMATS_LABEL = "PNG, JPG, WebP, GIF, AVIF, TIFF o SVG";
