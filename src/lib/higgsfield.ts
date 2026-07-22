/**
 * Generación nativa de imágenes con la API Cloud de Higgsfield.
 *
 * Envuelve el SDK oficial `@higgsfield/client` con lo que necesita 30x: mapear
 * el formato del carrusel al tamaño de Soul más cercano, generar con el modelo
 * text→image (opcionalmente con una imagen de referencia), y devolver los bytes
 * ya descargados para que el endpoint los pase por el mismo pipeline de `sharp`
 * que usan las subidas.
 *
 * Credenciales: `HF_API_KEY` + `HF_API_SECRET` en el entorno
 * (https://cloud.higgsfield.ai/api-keys). Si faltan, `isHiggsfieldConfigured()`
 * devuelve false y toda la feature queda deshabilitada sin romper el resto.
 */
// Los helpers (SoulQuality, SoulSize, …) se re-exportan desde el índice raíz del
// SDK; NO se importan de "@higgsfield/client/helpers" porque ese subpath no está
// declarado en el campo "exports" del paquete y no resuelve bajo moduleResolution moderno.
import {
  HiggsfieldClient,
  SoulQuality,
  SoulSize,
  BatchSize,
  seed as makeSeed,
  strength as clampStrength,
} from "@higgsfield/client";
import type { AspectRatio } from "@/types/carousel";

/** Endpoint text→image del modelo Soul v2 (el recomendado para fotos/fondos). */
const SOUL_ENDPOINT = "/v1/text2image/soul";

/**
 * Tamaño de Soul más cercano a cada formato del carrusel. Soul no ofrece el
 * ratio exacto de Instagram, así que generamos en el más próximo (o un poco más
 * grande) y el endpoint hace el recorte fino a las dimensiones exactas con sharp.
 * - 9:16 (0.5625) empata EXACTO con PORTRAIT_1152x2048.
 * - 4:5 (0.8) no existe: PORTRAIT_1536x2048 (0.75) es el más cercano, se cubre-recorta.
 * - 1:1 → SQUARE_1536x1536.
 */
const SIZE_BY_RATIO: Record<AspectRatio, (typeof SoulSize)[keyof typeof SoulSize]> = {
  "1:1": SoulSize.SQUARE_1536x1536,
  "4:5": SoulSize.PORTRAIT_1536x2048,
  "9:16": SoulSize.PORTRAIT_1152x2048,
};

export type ImageQuality = "sd" | "hd";

export interface GenerateImageOptions {
  /** Descripción de la imagen a generar. Requerido. */
  prompt: string;
  /** Formato del carrusel; define el tamaño de generación. Default "4:5". */
  aspectRatio?: AspectRatio;
  /** "hd" = 1080p (default), "sd" = 720p (más rápido/barato). */
  quality?: ImageQuality;
  /**
   * ID de una "SoulId" (referencia de personaje/estilo ya creada en la cuenta,
   * ver `crearSoulId`). Mantiene consistente un avatar entre imágenes. Opcional.
   */
  customReferenceId?: string;
  /** Fuerza de la SoulId, 0–1 (default 1). Solo aplica con customReferenceId. */
  customReferenceStrength?: number;
  /** ID de un estilo de Soul (`listarEstilos`). Opcional. */
  styleId?: string;
  /** Fuerza del estilo, 0–1 (default 0.8). Solo aplica con styleId. */
  styleStrength?: number;
  /** Semilla para reproducibilidad (0–1.000.000). Opcional. */
  seed?: number;
}

export interface GeneratedImage {
  /** URL cruda (full-res) devuelta por Higgsfield. */
  url: string;
  /** Bytes de la imagen ya descargados desde esa URL. */
  bytes: Buffer;
  /** Content-type reportado al descargar (ej. "image/jpeg"). */
  contentType: string;
  /** Semilla efectiva usada (útil para reproducir el resultado). */
  seed: number;
}

/** Error de la generación con un mensaje apto para mostrar al usuario. */
export class HiggsfieldError extends Error {
  constructor(
    message: string,
    /** Código HTTP sugerido para la respuesta del endpoint. */
    readonly status: number = 502
  ) {
    super(message);
    this.name = "HiggsfieldError";
  }
}

/** true si hay credenciales de Higgsfield en el entorno. */
export function isHiggsfieldConfigured(): boolean {
  return Boolean(
    (process.env.HF_API_KEY && process.env.HF_API_SECRET) ||
      process.env.HF_CREDENTIALS ||
      process.env.HF_KEY
  );
}

let cachedClient: HiggsfieldClient | null = null;

function getClient(): HiggsfieldClient {
  if (!isHiggsfieldConfigured()) {
    throw new HiggsfieldError(
      "Higgsfield no está configurado: falta HF_API_KEY / HF_API_SECRET en el entorno.",
      503
    );
  }
  if (!cachedClient) {
    // El SDK lee las credenciales del entorno si no se pasan explícitas.
    cachedClient = new HiggsfieldClient({
      apiKey: process.env.HF_API_KEY,
      apiSecret: process.env.HF_API_SECRET,
    });
  }
  return cachedClient;
}

/**
 * Descarga los bytes de una URL de imagen devuelta por Higgsfield.
 * (Las URLs crudas del CDN son públicas y de un solo uso lógico: las bajamos
 * enseguida para persistir la imagen en nuestro propio /uploads.)
 */
async function downloadImage(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new HiggsfieldError(`No se pudo descargar la imagen generada (HTTP ${res.status}).`);
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType };
}

/**
 * Genera una imagen con Soul y devuelve sus bytes ya descargados.
 * Lanza HiggsfieldError con un status apropiado ante fallos conocidos
 * (sin créditos, NSFW, validación, credenciales).
 */
export async function generarImagen(options: GenerateImageOptions): Promise<GeneratedImage> {
  const prompt = options.prompt?.trim();
  if (!prompt) {
    throw new HiggsfieldError("El prompt de la imagen no puede estar vacío.", 400);
  }

  const client = getClient();
  const ratio = options.aspectRatio ?? "4:5";
  const effectiveSeed = makeSeed(options.seed ?? null);

  const params: Record<string, unknown> = {
    prompt,
    width_and_height: SIZE_BY_RATIO[ratio],
    quality: options.quality === "sd" ? SoulQuality.SD : SoulQuality.HD,
    batch_size: BatchSize.SINGLE,
    seed: effectiveSeed,
  };

  // Referencia de personaje/estilo (SoulId) para mantener consistente al avatar.
  if (options.customReferenceId) {
    params.custom_reference_id = options.customReferenceId;
    params.custom_reference_strength = clampStrength(options.customReferenceStrength ?? 1);
  }

  // Estilo visual predefinido de Soul.
  if (options.styleId) {
    params.style_id = options.styleId;
    params.style_strength = clampStrength(options.styleStrength ?? 0.8);
  }

  let jobSet;
  try {
    jobSet = await client.generate(SOUL_ENDPOINT, params, { withPolling: true });
  } catch (err) {
    // Mapear errores del SDK a mensajes/estados claros.
    const name = (err as Error)?.name || "";
    const msg = (err as Error)?.message || "Error desconocido de Higgsfield.";
    if (name === "AuthenticationError" || name === "CredentialsMissedError") {
      throw new HiggsfieldError("Credenciales de Higgsfield inválidas.", 401);
    }
    // El "sin créditos" llega como NotEnoughCreditsError, o como AccountError
    // desde el polling del job — detectarlo también por mensaje es lo robusto.
    if (name === "NotEnoughCreditsError" || /credit/i.test(msg)) {
      throw new HiggsfieldError("No hay créditos suficientes en la cuenta de Higgsfield.", 402);
    }
    if (name === "ValidationError" || name === "BadInputError") {
      throw new HiggsfieldError(`Higgsfield rechazó el pedido: ${msg}`, 400);
    }
    throw new HiggsfieldError(`Falló la generación en Higgsfield: ${msg}`);
  }

  if (jobSet.isNsfw) {
    throw new HiggsfieldError("La imagen fue marcada como NSFW y no se generó.", 422);
  }
  if (jobSet.isFailed || !jobSet.isCompleted) {
    throw new HiggsfieldError("La generación en Higgsfield no se completó.");
  }

  const rawUrl = jobSet.jobs.find((j) => j.results?.raw?.url)?.results?.raw?.url;
  if (!rawUrl) {
    throw new HiggsfieldError("Higgsfield no devolvió una URL de imagen.");
  }

  const { bytes, contentType } = await downloadImage(rawUrl);
  return { url: rawUrl, bytes, contentType, seed: effectiveSeed };
}
