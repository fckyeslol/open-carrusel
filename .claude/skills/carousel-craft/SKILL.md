---
name: carousel-craft
description: Usar al generar, revisar o corregir láminas de carrusel en este proyecto. Cierra el loop de generación — renderiza cada lámina a PNG, la mira, detecta defectos contra el ADN del avatar y corrige antes de seguir. Cubre fidelidad al referente, identidad de marca, legibilidad en feed y tells de IA. No aplica a trabajo de backend ni a la UI de la app.
allowed-tools:
  - Bash(node scripts/slide-check.mjs *)
  - Read
---

# carousel-craft

Genera láminas con verificación visual en el loop, en vez de escribir HTML a ciegas.

## El problema que resuelve

El pipeline por defecto es abierto: el agente lee el referente, escribe HTML contra
`POST /api/carousels/{id}/slides` y sigue de largo. Nunca ve el resultado. La lámina
solo se rasteriza al exportar, cuando ya nadie corrige nada.

Toda una clase de defectos vive únicamente en el render: texto que se desborda,
contraste que colapsa al comprimir, una fuente que no se pudo inlinear y salió en
fuente de sistema, una imagen que no resolvió. Ninguno es visible en el HTML.

## El ciclo

Por cada lámina, en este orden:

1. **Escribir** la lámina (`POST .../slides`).
2. **Revisar**: `node scripts/slide-check.mjs <carouselId> <slideId>`
   Renderiza el PNG con el mismo motor que la entrega final y corre el detector.
3. **Mirar**: `Read` sobre la ruta del PNG que imprimió el paso 2. No es opcional.
   Un screenshot que no leíste no cuenta.
4. **Criticar** contra `reference/critica-lamina.md` — leelo la primera vez de cada
   sesión.
5. **Corregir** lo material (`PUT .../slides/{slideId}`) y volver al paso 2.
6. Recién ahí, pasar a la lámina siguiente.

No comprimas el ciclo generando las 10 láminas y revisando al final: un error
estructural en la lámina 1 se propaga a las 10 y arreglarlo cuesta 10 veces más.

## Leer la salida de slide-check

Tres niveles:

- `✗ error` — **bloquea**. La lámina sale rota: texto cortado, imagen que no
  carga, `<script>` que el sandbox mata en silencio, dimensión fuera del lienzo.
  No sigas con esto pendiente.
- `! warning` — defecto de diseño real, pero puede tener una lectura. Resolvelo o
  justificalo.
- `~ advisory` — **deriva del ADN**: un color o una fuente fuera de la identidad
  del avatar. Es la señal más específica de 30x y la que más se escapa a ojo,
  porque el color del referente "se siente bien" mientras lo estás mirando.

El exit code es 0 si pasa y 2 si hay bloqueantes.

Un resultado limpio nunca prueba que la lámina esté bien — solo que no encontró
defectos mecánicos. La calidad la juzgás vos mirando el PNG.

## Requisitos

- Dev server levantado (`npm run dev`). El script habla con la API local.
- El carrusel debe tener `stylePresetId`. Sin preset el detector corre en modo
  genérico y juzga por gusto en vez de contra la identidad del avatar — y va a
  marcar la tipografía de marca como "fuente trillada".
