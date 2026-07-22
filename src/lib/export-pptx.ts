import PptxGenJS from "pptxgenjs";
import { getBrowser, prepareRenderableHtml } from "./export-slides";
import type { Slide, AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

/**
 * Export "contenido-first" a .pptx para editar en Canva.
 *
 * La lámina se renderiza en Puppeteer EXACTAMENTE igual que para el PNG (mismo
 * `prepareRenderableHtml`), pero en vez de hacer screenshot leemos el DOM ya
 * maquetado y reconstruimos cada bloque como OBJETO editable: cajas de texto,
 * imágenes colocadas, rectángulos de color y el fondo. Canva importa el .pptx y
 * conserva esos objetos como editables — texto de verdad, no una imagen aplanada.
 *
 * Lo que NO se reproduce (tradeoff consciente del modo contenido-first): degradados,
 * texturas, sombras y CSS decorativo fino. Eso lo rearma la diseñadora en Canva.
 */

const PX_PER_INCH = 96;
const PT_PER_PX = 0.75; // 72/96

const px2in = (px: number): number => px / PX_PER_INCH;
const px2pt = (px: number): number => px * PT_PER_PX;

type Align = "left" | "center" | "right" | "justify";

interface ExtractedText {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontFamily: string;
  fontSizePx: number;
  bold: boolean;
  italic: boolean;
  color: string; // RRGGBB
  align: Align;
  lineHeightPx: number | null;
  letterSpacingPx: number;
  pad: { top: number; right: number; bottom: number; left: number };
}

interface ExtractedImage {
  dataUri: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ExtractedRect {
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SlideExtraction {
  background: { color: string | null; image: string | null };
  rects: ExtractedRect[];
  images: ExtractedImage[];
  texts: ExtractedText[];
}

/**
 * Función que corre DENTRO de la página (page.evaluate). Debe ser autocontenida:
 * no puede referenciar nada del scope de Node. Devuelve una estructura serializable.
 */
function extractSlideDom(): SlideExtraction {
  // OJO: esta función se serializa y corre en el navegador (page.evaluate). No
  // puede referenciar constantes ni helpers del módulo Node — todo va acá dentro.
  const FULL_BLEED_AREA_RATIO = 0.92; // hijo que cubre ~todo el lienzo = fondo
  const W = document.body.clientWidth;
  const H = document.body.clientHeight;
  const INLINE = new Set(["inline", "inline-block", "contents"]);

  const solidHex = (color: string): string | null => {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    const [r, g, b] = parts;
    const a = parts.length > 3 ? parts[3] : 1;
    if (a < 0.99) return null; // semitransparente: no lo tratamos como relleno sólido
    const hex = (n: number) =>
      Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return (hex(r) + hex(g) + hex(b)).toUpperCase();
  };

  const dataUrlFromBg = (bg: string): string | null => {
    const m = bg.match(/url\(\s*["']?(data:[^"')]+)["']?\s*\)/i);
    return m ? m[1] : null;
  };

  const isVisible = (cs: CSSStyleDeclaration): boolean =>
    cs.display !== "none" &&
    cs.visibility !== "hidden" &&
    parseFloat(cs.opacity || "1") > 0.01;

  const resolvedParentBg = (el: Element): string | null => {
    let node: Element | null = el.parentElement;
    while (node) {
      const col = solidHex(getComputedStyle(node).backgroundColor);
      if (col) return col;
      node = node.parentElement;
    }
    return null;
  };

  // ── Fondo del lienzo: body o el primer hijo full-bleed ──────────────────────
  const bodyCs = getComputedStyle(document.body);
  let bgColor = solidHex(bodyCs.backgroundColor);
  let bgImage = dataUrlFromBg(bodyCs.backgroundImage);
  const skip = new Set<Element>();
  for (const child of Array.from(document.body.children)) {
    const r = child.getBoundingClientRect();
    if (r.width * r.height >= FULL_BLEED_AREA_RATIO * W * H) {
      const ccs = getComputedStyle(child);
      if (!isVisible(ccs)) continue;
      const col = solidHex(ccs.backgroundColor);
      const img = dataUrlFromBg(ccs.backgroundImage);
      if (col) bgColor = col;
      if (img) {
        bgImage = img;
        skip.add(child); // ya viaja como fondo del slide
      }
    }
  }

  const rects: ExtractedRect[] = [];
  const images: ExtractedImage[] = [];
  const texts: ExtractedText[] = [];

  // ── Pasada visual: imágenes + rectángulos de color (recorre todo) ───────────
  const visualWalk = (el: Element): void => {
    const cs = getComputedStyle(el);
    if (!isVisible(cs)) return;
    const rect = el.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    if (w > 2 && h > 2) {
      // <img> con fuente inline (data:)
      if (el.tagName === "IMG") {
        const src = (el as HTMLImageElement).src;
        if (src && src.startsWith("data:")) {
          images.push({ dataUri: src, x: rect.x, y: rect.y, w, h });
        }
      }
      // background-image data: (excepto el full-bleed ya usado como fondo)
      if (!skip.has(el)) {
        const bgImg = dataUrlFromBg(cs.backgroundImage);
        if (bgImg) {
          images.push({ dataUri: bgImg, x: rect.x, y: rect.y, w, h });
        }
        // Rectángulo de color: relleno sólido que difiere del fondo del padre.
        const col = solidHex(cs.backgroundColor);
        if (col && !bgImg && col !== resolvedParentBg(el)) {
          rects.push({ color: col, x: rect.x, y: rect.y, w, h });
        }
      }
    }
    for (const child of Array.from(el.children)) visualWalk(child);
  };
  for (const child of Array.from(document.body.children)) visualWalk(child);

  // ── Pasada de texto: se detiene en el bloque de texto más profundo ──────────
  const textWalk = (el: Element): void => {
    const cs = getComputedStyle(el);
    if (!isVisible(cs)) return;

    let hasBlockTextChild = false;
    for (const child of Array.from(el.children)) {
      const ccs = getComputedStyle(child);
      if (!INLINE.has(ccs.display) && (child as HTMLElement).innerText?.trim()) {
        hasBlockTextChild = true;
        break;
      }
    }

    const ownText = (el as HTMLElement).innerText?.trim() ?? "";
    if (ownText && !hasBlockTextChild) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 2 && rect.height > 2) {
        const weight = parseInt(cs.fontWeight, 10) || 400;
        const family = (cs.fontFamily.split(",")[0] || "")
          .trim()
          .replace(/['"]/g, "");
        const rawAlign = cs.textAlign;
        const align: Align =
          rawAlign === "center"
            ? "center"
            : rawAlign === "right" || rawAlign === "end"
              ? "right"
              : rawAlign === "justify"
                ? "justify"
                : "left";
        const lh = parseFloat(cs.lineHeight);
        const ls = parseFloat(cs.letterSpacing);
        let text = (el as HTMLElement).innerText;
        if (cs.textTransform === "uppercase") text = text.toUpperCase();
        else if (cs.textTransform === "lowercase") text = text.toLowerCase();

        texts.push({
          text,
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          fontFamily: family,
          fontSizePx: parseFloat(cs.fontSize) || 16,
          bold: weight >= 600,
          italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
          color: solidHex(cs.color) ?? "000000",
          align,
          lineHeightPx: Number.isFinite(lh) ? lh : null,
          letterSpacingPx: Number.isFinite(ls) ? ls : 0,
          pad: {
            top: parseFloat(cs.paddingTop) || 0,
            right: parseFloat(cs.paddingRight) || 0,
            bottom: parseFloat(cs.paddingBottom) || 0,
            left: parseFloat(cs.paddingLeft) || 0,
          },
        });
      }
      return; // hoja de texto: no seguir bajando
    }
    for (const child of Array.from(el.children)) textWalk(child);
  };
  for (const child of Array.from(document.body.children)) textWalk(child);

  return { background: { color: bgColor, image: bgImage }, rects, images, texts };
}

/** Renderiza una lámina y extrae sus objetos editables. */
async function extractSlide(
  slideHtml: string,
  aspectRatio: AspectRatio
): Promise<SlideExtraction> {
  const { width, height } = DIMENSIONS[aspectRatio];
  const fullHtml = await prepareRenderableHtml(slideHtml, aspectRatio);
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(fullHtml, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page
      .waitForFunction(
        () =>
          document.fonts.ready.then(() =>
            [...document.fonts].every((f) => f.status === "loaded")
          ),
        { timeout: 10000 }
      )
      .catch(() => {});
    return (await page.evaluate(extractSlideDom)) as SlideExtraction;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Vuelca una extracción a una lámina PptxGenJS (orden z: fondo → rects → imágenes → texto). */
function renderSlideToPptx(pptx: PptxGenJS, extraction: SlideExtraction): void {
  const slide = pptx.addSlide();

  if (extraction.background.image) {
    slide.background = { data: extraction.background.image };
  } else if (extraction.background.color) {
    slide.background = { color: extraction.background.color };
  }

  for (const r of extraction.rects) {
    slide.addShape(pptx.ShapeType.rect, {
      x: px2in(r.x),
      y: px2in(r.y),
      w: px2in(r.w),
      h: px2in(r.h),
      fill: { color: r.color },
    });
  }

  for (const img of extraction.images) {
    slide.addImage({
      data: img.dataUri,
      x: px2in(img.x),
      y: px2in(img.y),
      w: px2in(img.w),
      h: px2in(img.h),
    });
  }

  for (const t of extraction.texts) {
    slide.addText(t.text, {
      x: px2in(t.x),
      y: px2in(t.y),
      w: px2in(t.w),
      h: px2in(t.h),
      fontFace: t.fontFamily || undefined,
      fontSize: px2pt(t.fontSizePx),
      bold: t.bold,
      italic: t.italic,
      color: t.color,
      align: t.align,
      valign: "top",
      charSpacing: t.letterSpacingPx ? px2pt(t.letterSpacingPx) : undefined,
      lineSpacingMultiple: t.lineHeightPx
        ? Math.max(0.5, t.lineHeightPx / t.fontSizePx)
        : undefined,
      margin: [
        px2pt(t.pad.top),
        px2pt(t.pad.right),
        px2pt(t.pad.bottom),
        px2pt(t.pad.left),
      ],
      wrap: true,
    });
  }
}

/**
 * Exporta un carrusel completo a un .pptx (una lámina por slide) listo para
 * importar en Canva como diseño editable.
 */
export async function exportCarouselToPptx(
  slides: Slide[],
  aspectRatio: AspectRatio,
  onProgress?: (current: number, total: number) => void
): Promise<Buffer> {
  const { width, height } = DIMENSIONS[aspectRatio];

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "OC", width: px2in(width), height: px2in(height) });
  pptx.layout = "OC";

  // Serial: concurrencia de páginas Puppeteer puede deadlockear en Windows (mismo
  // motivo que el export PNG). Una lámina a la vez es lo confiable.
  for (let i = 0; i < slides.length; i++) {
    const extraction = await extractSlide(slides[i].html, aspectRatio);
    renderSlideToPptx(pptx, extraction);
    onProgress?.(i + 1, slides.length);
  }

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}
