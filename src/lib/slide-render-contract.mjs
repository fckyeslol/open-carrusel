/**
 * CONTRATO DE RENDER — el único código que comparten la app y el servicio de render.
 *
 * El render de una lámina es una función pura de datos serializables:
 *
 *     { html, width, height, scale, transparent } → PNG/PDF
 *
 * porque `prepareRenderableHtml` (src/lib/export-slides.ts) inlinea el CSS de las
 * fuentes y TODAS las imágenes como data: URIs, y el renderer usa `setContent` SIN
 * base URL. El HTML que llega a Chrome no depende del filesystem, así que Chrome
 * puede vivir en otro contenedor.
 *
 * Lo único que NO se serializa son los scripts que corren DENTRO de la página
 * (`page.evaluate`), y son justo los que conocen el contrato del editor. Viven acá
 * para que exista UNA sola fuente de verdad: el Dockerfile del servicio de render usa
 * la raíz del repo como build context y copia este archivo, en vez de duplicarlo.
 *
 * Es .mjs y no .ts a propósito — el servicio de render corre con node directo y no
 * puede importar TypeScript. Es la misma convención que src/lib/quality/*.mjs, que la
 * app ya importa desde rutas TS (ver review/route.ts). Los tipos del seam viven en
 * src/lib/render.ts, donde TS los chequea.
 *
 * ⚠️ Si editás este archivo —o `strip-slide-background.mjs`, que se re-exporta acá— subí
 * CONTRACT_VERSION y redesplegá LAS DOS PARTES. El cliente compara su versión con la que
 * reporta en /_health y avisa si divergen: sin eso, un deploy a medias renderiza distinto
 * sin que nadie se entere.
 */

/**
 * Versión del contrato. Subir en cualquier cambio de comportamiento de los scripts
 * de abajo o de la forma del payload.
 */
export const CONTRACT_VERSION = 3;

/**
 * Timeout de `setContent` para el PNG por lámina. El HTML ya viene autocontenido
 * (nada que bajar de la red), así que esto solo cubre el parseo.
 */
export const SET_CONTENT_TIMEOUT_PNG_MS = 15000;

/** Ídem para el documento multi-lámina del PDF, que es más grande. */
export const SET_CONTENT_TIMEOUT_PDF_MS = 20000;

/** Cuánto se espera a que las fuentes estén listas antes de capturar. */
export const FONTS_READY_TIMEOUT_MS = 10000;

/**
 * Predicado para `page.waitForFunction`: ya no queda ninguna fuente cargando.
 *
 * Sin esto, la captura puede salir con la fuente de fallback y el texto se ve
 * distinto del preview. Si expira, se captura igual con lo que haya cargado — es
 * mejor una lámina con fuente de fallback que ninguna.
 *
 * Antes exigía que TODAS las caras estuvieran `loaded`, y eso no se cumplía nunca: el CSS
 * inlineado de una familia trae ~63 caras (grosor × subset de unicode) y una lámina usa dos
 * o tres. Las que no se usan se quedan en `unloaded` para siempre —el navegador no baja lo
 * que nadie pide, que es justamente la gracia— así que el predicado era falso hasta que
 * expiraba el timeout. Resultado: 10s de espera inútil en CADA export, y ninguna garantía
 * a cambio. Lo correcto es que no quede ninguna EN VUELO: `ready` ya espera a las que
 * arrancaron, y el chequeo de `loading` cubre las que arrancaron después.
 */
export function fontsReadyPredicate() {
  return document.fonts.ready.then(() =>
    ![...document.fonts].some((f) => f.status === "loading")
  );
}

/** Cuánto se espera a que no quede ninguna imagen en vuelo antes de capturar. */
export const IMAGES_READY_TIMEOUT_MS = 20000;

/**
 * Predicado para `page.waitForFunction`: ya no queda ninguna `<img>` en vuelo.
 *
 * NO existía, y esa era la mitad del bug de las fotos que salían vacías o cortadas. El
 * razonamiento de por qué no hacía falta era este: el HTML llega autocontenido (imágenes en
 * data: URI), así que no hay nada que bajar y `domcontentloaded` alcanza. Cierto mientras el
 * inlineado cubra TODO — y no cubría las URLs absolutas, que son como el editor guarda las
 * fotos en 258 láminas de producción. Esas quedaban pidiéndose por red mientras la captura
 * ya se había disparado: `complete=false`, `naturalWidth=0`, PNG de 22KB en vez de 2.3MB.
 * Reproducible 3 de 3 veces, no una carrera de vez en cuando.
 *
 * Espera `complete`, NO `naturalWidth > 0`: `complete` se pone en true tanto si la imagen
 * cargó como si falló, que es justo la condición de "ya no queda nada en vuelo". Exigir que
 * además tenga píxeles dejaría una imagen rota (un 404) colgando hasta que expire el
 * timeout, 20s por lámina, para terminar capturando lo mismo.
 */
export function imagesReadyPredicate() {
  return [...document.querySelectorAll("img")].every((img) => img.complete);
}

/**
 * Fuerza el decodificado de las imágenes antes de capturar, para `page.evaluate`.
 *
 * `complete` dice que los bytes llegaron; `decode()` resuelve cuando la imagen está lista
 * para pintarse. Sin esto quedaba la ventana en la que la captura agarra una foto grande a
 * medio decodificar — que es la que se ve "cortada a la mitad".
 *
 * Cada `decode()` va con su catch: en una imagen que falló, `decode()` RECHAZA, y una
 * promesa rechazada acá abortaría el render de una lámina que igual se puede entregar con
 * el resto de su contenido.
 */
export function decodeImagesInPage() {
  return Promise.all(
    [...document.querySelectorAll("img")].map((img) => img.decode().catch(() => {}))
  ).then(() => undefined);
}

/**
 * Script de "sin fondo" (PNG transparente), para `page.evaluate`.
 *
 * NO se implementa acá: se re-exporta `stripBackgroundInPage` de
 * `strip-slide-background.mjs`, que es la fuente de verdad y ya existía por el mismo
 * motivo que este archivo (corre dentro de la página, así que tiene que ser autocontenida
 * y vivir suelta para poder probarse contra una lámina real con `npm run check:editor`).
 *
 * Se re-exporta en vez de importarse directo en cada lado para que el contrato del seam
 * quede en UN solo lugar: `render.ts` y `render-service/server.mjs` importan todo de acá.
 * Ojo: el Dockerfile del servicio de render tiene que copiar LOS DOS .mjs.
 */
export { stripBackgroundInPage } from "./strip-slide-background.mjs";
