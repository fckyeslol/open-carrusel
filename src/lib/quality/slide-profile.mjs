/**
 * Perfil de lámina — qué reglas del detector de impeccable aplican a un carrusel.
 *
 * El detector está afinado para páginas web. Una lámina es una imagen estática de
 * 1080×1350: no hay scroll, ni hover, ni breakpoints, ni lector de pantalla. Correr
 * las 46 reglas crudas produce mayoría de falsos positivos.
 *
 * Cada apagado de abajo lleva su razón. Si una regla no tiene razón, va encendida.
 */

/** Interacción y motion — imposibles en una imagen rasterizada a PNG. */
const OFF_SIN_INTERACCION = {
  'bounce-easing': 'No hay animación en una lámina; el sandbox además bloquea JS.',
  'image-hover-transform': 'No hay puntero sobre una imagen de Instagram.',
  'layout-transition': 'No hay transiciones: la lámina se rasteriza en un solo frame.',
};

/** Métricas de página larga que en un lienzo fijo disparan siempre. */
const OFF_LIENZO_FIJO = {
  'line-length':
    'Pide 65-75ch. A 1080px de ancho con cuerpo de 40px el máximo real ronda 27ch, ' +
    'así que marcaría cada lámina. La legibilidad acá la cubren tiny-text y low-contrast.',
  'skipped-heading':
    'Jerarquía semántica de headings. La lámina termina siendo un PNG: no hay lector ' +
    'de pantalla ni SEO que la consuma. La jerarquía visual la cubre flat-type-hierarchy.',
  'body-text-viewport-edge':
    'Reemplazada por la regla propia safe-margin, que es más estricta (108px) y está ' +
    'calibrada al recorte de Instagram.',
};

/** Reglas que contradicen lo que una lámina debe ser. */
const OFF_CONTRADICE_BRIEF = {
  'oversized-h1':
    'Penaliza títulos gigantes. Una portada de carrusel los pide: el system prompt ' +
    'pide 150px+ y se lee a tamaño miniatura en el feed.',
  'single-font':
    'Varios avatares mandan una sola familia por ADN (Cinthya: Instrument Serif en ' +
    'todo). Es una decisión de marca, no un descuido.',
  'tight-leading':
    'Exige interlineado ≥1.3, calibrado para cuerpo de 16px. Una lámina está dominada ' +
    'por display de 100-150px, donde 0.9-1.0 es lo correcto y deliberado. Encendida ' +
    'dispara en casi toda lámina y ahoga los hallazgos reales.',
  'cramped-padding':
    'Marca contenedores con texto y padding casi nulo contra un fondo visible. El div ' +
    'raíz de toda lámina es exactamente eso —1080×1350 con fondo y sin inset, porque ' +
    'ES el lienzo, no una tarjeta— así que dispara en el 100% de las láminas. El ' +
    'padding de las tarjetas internas se juzga mirando el PNG.',
};

/**
 * Reglas de gusto tipográfico y cromático que se apagan SOLO cuando hay un ADN
 * cargado. Su trabajo lo hacen mejor las design-system-*, que validan deriva contra
 * la paleta real del avatar en vez de aplicar gusto genérico.
 *
 * Sin ADN quedan encendidas: son la única red que queda.
 */
const OFF_SI_HAY_ADN = {
  'overused-font':
    'Marca Instrument Serif como fuente trillada, pero es la tipografía prescrita en ' +
    'el adn.json de Cinthya. Con ADN cargado esto lo cubre design-system-font, que ' +
    'penaliza desviarse de la fuente de marca en vez de la fuente en sí.',
  'ai-color-palette':
    'Con ADN cargado, la deriva de paleta la mide design-system-color contra los hex ' +
    'reales del avatar.',
  'cream-palette':
    'El #F6F5F0 de todos los avatares cae en la banda cream que la regla llama slop, ' +
    'pero es el "30% White" del brand kit de 30x. Con ADN cargado manda el ADN.',
};

/**
 * Criterio de severidad: **bloquea lo roto, advierte lo discutible.**
 *
 * Bloqueante = la lámina sale mal publicada y no hay lectura del diseño que lo
 * justifique: texto cortado, imagen que no carga, contraste ilegible.
 *
 * Las design-system-* quedan como advertencia a propósito, aunque sean el hallazgo
 * más valioso del sistema (deriva de identidad, la Regla #1 de 30x). Un color
 * fuera de paleta puede ser legítimo —un overlay sobre foto, un degradé heredado
 * del referente— y la propia regla lo admite: "may be legitimate". Bloquear ahí
 * haría que el agente pelee contra decisiones válidas en vez de corregir defectos.
 *
 * Las reglas 30x traen su propia severidad y no pasan por acá.
 */
const BLOQUEANTES = new Set([
  'text-overflow',
  'clipped-overflow-container',
  'broken-image',
  'low-contrast',
  'gray-on-color',
  'tiny-text',
]);

/**
 * Construye el perfil activo.
 *
 * @param {{ hasDesignSystem?: boolean }} opciones
 * @returns {{ ignoredRules: Map<string,string>, isBlocking: (id: string) => boolean }}
 */
export function buildSlideProfile({ hasDesignSystem = false } = {}) {
  const ignoredRules = new Map([
    ...Object.entries(OFF_SIN_INTERACCION),
    ...Object.entries(OFF_LIENZO_FIJO),
    ...Object.entries(OFF_CONTRADICE_BRIEF),
    ...(hasDesignSystem ? Object.entries(OFF_SI_HAY_ADN) : []),
  ]);

  return {
    ignoredRules,
    isBlocking: (id) => BLOQUEANTES.has(id),
  };
}

/** Filtra hallazgos crudos del engine según el perfil. */
export function applySlideProfile(findings, profile) {
  return findings
    .filter((f) => !profile.ignoredRules.has(f.antipattern))
    .map((f) => ({
      ...f,
      severity: profile.isBlocking(f.antipattern) ? 'error' : f.severity || 'warning',
    }));
}

/** Para diagnóstico: por qué una regla no corrió. */
export function explainIgnored(ruleId, profile) {
  return profile.ignoredRules.get(ruleId) || null;
}
