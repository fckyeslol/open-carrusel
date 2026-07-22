# Código vendorizado — impeccable

Este directorio es una copia del motor detector de **impeccable**, de Paul Bakaus.

- Fuente: https://github.com/pbakaus/impeccable (`cli/engine/`)
- Licencia: Apache-2.0 (ver `LICENSE` en este mismo directorio)
- Vendorizado el: 2026-07-21

## Por qué está vendorizado y no es una dependencia

El detector de impeccable está afinado para interfaces web: páginas responsive,
estados de hover, motion, longitud de línea para lectura larga. Una lámina de
carrusel es una imagen estática de 1080×1350 donde varias de esas reglas no
aplican, y algunas se vuelven activamente incorrectas (una portada *quiere* un
título de 150px, que `oversized-h1` penalizaría).

Más importante: sus reglas de gusto tipográfico chocan con el brand kit. Corrido
crudo contra `public/30x-slides/cinthya/*.html`, el detector marca `overused-font`
porque la lámina usa Instrument Serif — que es exactamente la tipografía que el
`adn.json` de Cinthya prescribe.

La adaptación vive **fuera** de este directorio, en `src/lib/quality/`:

- `slide-profile.mjs` — qué reglas aplican a una lámina y con qué severidad
- `design-system.mjs` — construye el design system del avatar desde su preset,
  para que las reglas `design-system-*` validen deriva contra el ADN real en vez
  de aplicar gusto genérico
- `slide-rules.mjs` — reglas propias de 30x que impeccable no puede conocer

## Regla de mantenimiento

**No editar archivos dentro de `engine/`.** Toda adaptación va en la capa de
arriba. Eso mantiene el diff contra upstream limpio y permite re-vendorizar con
un `cp -r` cuando haga falta.
