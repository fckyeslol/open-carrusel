# Plan de migración — Carruseles 30x: de Canva a Open Carrusel

> **Decisión tomada (2026-07-17):** jubilar el pipeline de Canva (`30x-carousel-pipeline`) y basar
> los carruseles de 30x en **Open Carrusel** (`C:\Users\mateo\open-carrusel`), la app que ya
> construimos para Sembradores de Fe. HTML/CSS → Puppeteer → PNG. WYSIWYG. Sin API de Canva.

---

## 1. Qué queremos (requisitos del usuario)

1. **Base = Open Carrusel**, no Canva.
2. **Cada diseñadora corre su worker local** (la app + su Claude Code + su login de Prewave).
3. **La ingesta sigue siendo la actual**: la cola `agent_jobs` de Prewave (`GET/PATCH /agent-jobs`),
   alimentada por "Generar 30x" desde el board de Producción/Diseño. A cada diseñadora le llegan
   SUS jobs (scope por JWT, ya implementado en `api/src/routers/agent-jobs.ts`).
4. **O la diseñadora pega una URL de un referente de Instagram** y se genera ese carrusel, dentro
   de la plataforma.
5. **Que funcione también como un Canva**: agregar imágenes, degradados, editar fuentes, tamaños,
   todo — edición visual completa.

## 2. Por qué esto encaja casi sin fricción

- **Worker local ya es el modelo de Open Carrusel.** El chat (`src/app/api/chat/route.ts`) hace
  `spawn` de la **Claude Code CLI local** de quien corre la app (`--allowedTools Bash,WebFetch,Read`,
  `--max-budget-usd 1.00`). Cero API keys compartidas, cero facturación por asiento. Cada diseñadora
  ya tiene Claude Code (hoy corre el worker de Canva con él).
- **El LLM escribe HTML/CSS** (lo que sabe hacer) y **ve el resultado** (preview = export, contrato
  único `wrapSlideHtml`). Es exactamente lo que el pipeline de Canva no podía.
- **La ingesta actual no se toca**: Open Carrusel se vuelve el "worker" que drena la misma cola.

## 3. Arquitectura objetivo

```
  ┌─────────────── PREWAVE (sin cambios en la ingesta) ───────────────┐
  │  Board Producción / Diseño → "Generar 30x" → cola agent_jobs      │
  │  GET /agent-jobs?status=pending  (scope por JWT de la diseñadora)  │
  └───────────────────────────────┬───────────────────────────────────┘
                                   │  (poll con su token)
                    ┌──────────────▼───────────────┐
                    │   OPEN CARRUSEL (local)       │
                    │   worker de cada diseñadora   │
                    │                               │
   URL IG manual ──►│  1. Ingesta (cola + manual)   │
                    │  2. Descarga slides referente │
                    │  3. Genera copy fiel + HTML   │◄── brand por avatar (adn.json)
                    │     (Claude local)            │
                    │  4. EDITOR tipo Canva         │
                    │     (imágenes/degradados/     │
                    │      fonts/tamaños)           │
                    │  5. Export PNG (Puppeteer)    │
                    └──────────────┬────────────────┘
                                   │  writeback + assets
  ┌────────────────────────────────▼──────────────────────────────────┐
  │  PREWAVE: PATCH /agent-jobs/:id done + assets a GCS                 │
  │  → flujo de aprobación y publicación ACTUAL (Metricool)            │
  └────────────────────────────────────────────────────────────────────┘
```

Dos puntos de integración con Prewave: **entrada** (cola, ya existe) y **salida** (writeback + GCS,
reusar lo actual). Todo lo del medio vive en Open Carrusel, local.

---

## 4. Fases

### Fase 0 — Decisiones y preparación
- Confirmar las decisiones abiertas (ver §6).
- Fork/rebrand de `open-carrusel` a un repo de 30x (o rama). Mantener MIT/estructura.
- `npm install` + `npm run doctor` en la máquina de una diseñadora piloto (Isabella) para validar
  que Puppeteer + Chrome local + Claude CLI arrancan (ya hay `findChrome` y workarounds de Windows).

### Fase 1 — Avatares como brands/presets (el reemplazo del "lienzo")
El corazón de la migración. Cada avatar deja de ser un "lienzo de bloques vacíos" en Canva y pasa a
ser un **StylePreset** de Open Carrusel, derivado de su `adn.json` (ya poblado para los 8 avengers
desde el manual "8 marcas · 1 ADN", Canva `DAHPUborYmg`).

Mapeo `adn.json → StylePreset` (`src/types/style-preset.ts`):
| adn.json | StylePreset / Brand |
|---|---|
| `visual_identity.paleta[]` (hex + rol) | `brand.colors` (primary/secondary/accent/background/surface) |
| `visual_identity.tipografia.familia` | `brand.fonts.heading` / `body` (Google Font) |
| `avatar.name`, logo 30x | `brand.name`, `brand.logoPath` |
| `voice_dna.tono` + `brand.voice` | `brand.styleKeywords` |
| `visual_identity` (firma, rol, fondos) + `voice_dna.do/dont` | `stylePreset.designRules` |
| (nuevo) 1 formato HTML de referencia | `stylePreset.exampleSlideHtml` |

- **Entregable:** un script `import-avatar.mjs` que lee `avatars/<slug>/adn.json` del repo del
  pipeline y genera el `StylePreset` (+ brand) en `data/` de Open Carrusel. Corre para los 8.
- **Multi-marca:** hoy la app es de una marca (`brand.json`). Hay que soportar **varios avatares en
  un install** (una diseñadora trabaja varios). El sistema de `style-presets` ya es la base: cada
  avatar = un preset; el preset activo define el brand. Tarea: que "avatar activo" mande el brand en
  vez del `brand.json` global. (Ver decisión §6.2.)

### Fase 2 — Construir los formatos HTML por avatar (el laburo de diseño real)
Por cada avatar, 3–6 plantillas HTML tipo `public/sdf-slides/formato-1..6.html` (portada, dato, cita,
paso/lista, cierre). Es el trabajo recurrente y el que define la calidad. Se hace UNA vez por avatar.
- Reusar el nivel de `formato-1.html` de SDF (gradientes, fotos enmascaradas, jerarquía tipográfica).
- Empezar por **Cinthya y Guillermo** (ya `ready` en el pipeline, ADN validado).
- Estas plantillas alimentan `stylePreset.exampleSlideHtml` y la galería de templates.

### Fase 3 — Ingesta desde la cola de Prewave (reusar la actual)
Un módulo nuevo en Open Carrusel que drena `agent_jobs` con el JWT de la diseñadora.
- **Login:** reusar el flujo del pipeline (`scripts/login.py` → token). Guardar el token local
  (equivalente a `.prewave-token`). El worker de Canva ya hace esto.
- **Poll:** `GET /agent-jobs?status=pending` → por cada job: `PATCH :id {status:processing}` (claim)
  → crear un `Carousel` en Open Carrusel pre-cargado con: `avatar_slug` → preset del avatar,
  `reference_url` → referencia, y disparar la descarga de slides (Fase 4).
- **Scope:** ya resuelto en el backend — con su JWT solo ve SUS jobs. **No tocar `agent-jobs.ts`.**
  (Nota: el 403 "no es tuyo" que vimos antes es de jobs de Producción donde `createdBy` no cuenta;
  si molesta en la práctica, es un fix aparte y chico — ver §6.5. No bloquea la migración.)
- **UI:** una bandeja "Trabajos pendientes" en Open Carrusel (lista los jobs de la cola).

### Fase 4 — Entrada manual + descarga del referente
- **Campo "Pegar URL de Instagram"** en la app (además de la bandeja de la cola). Pega URL + elige
  avatar → mismo flujo, sin job de cola.
- **Descargar slides del referente:** portar el Paso 1 de `AGENT.md` (ya probado): navegar al post,
  leer el JSON embebido (`carousel_media[].image_versions2.candidates[0].url`), bajar las imágenes
  (Python/Node directo, HTTP 200 sin login), guardarlas en `public/uploads/` como `ReferenceImage`.
  Reusa Playwright/Puppeteer que ya está en el stack.
- Soporte TikTok queda como TODO (igual que hoy).

### Fase 5 — Generación (referente → carrusel con el ADN)
El local Claude hace el trabajo, guiado por un system prompt = `AGENT.md` Pasos 2–3 adaptados +
el preset del avatar + reglas de fidelidad.
- **Leer estructura** del referente con visión (Read sobre las imágenes) → spec por lámina.
- **Escribir copy fiel** en español con la voz del avatar (`voice_dna`): cada cifra/dato sobrevive
  exacto (reusar el espíritu del `FIDELITY_FLOOR`/rúbrica de Prewave `domain/script-quality`).
- **Generar los slides HTML** eligiendo/combinando los formatos del avatar (Fase 2) y rellenando.
  Claude edita vía la API de slides que ya existe (`/api/carousels/[id]/slides`, `staged-actions`).
- Resultado: carrusel renderizado en el preview, listo para editar.

### Fase 6 — Editor tipo Canva (lo que falta para "todo")
Open Carrusel ya tiene: preview en vivo, filmstrip reordenable (dnd-kit), undo, versiones por slide,
captions, safe-zones, aspect ratios, upload de imágenes, presets, galería. **Falta cerrar la parte
de edición visual directa** (hoy mucho se hace por chat; queremos controles manuales):
- **Agregar imágenes:** ya existe upload (`/api/upload`) + inline en export. Falta UI de "insertar
  imagen en el slide" (drag a la lámina, posición/tamaño).
- **Degradados:** UI para editar `background`/overlays (radial/linear) del slide. Es CSS; el motor ya
  lo renderiza (los formatos SDF ya usan gradientes). Falta el control visual.
- **Fonts y tamaños:** selector de familia (ya hay `FontSelector`/`/api/fonts`) y de tamaño/peso a
  nivel de bloque seleccionado. Falta edición inline por elemento (click en texto → toolbar).
- **Decisión de alcance:** ¿editor WYSIWYG por-elemento (más trabajo, más "Canva") o edición por
  paneles + chat (más rápido de entregar)? Ver §6.3.

### Fase 7 — Salida: writeback + publicación (reusar lo actual)
- **Export:** ya existe (`/api/carousels/[id]/export` → ZIP de PNGs 1080×1350).
- **Subir assets a GCS:** reusar el patrón de signed-URL de Prewave (memoria: "Media upload to GCS —
  signed URL directo al bucket"). Pedir signed URLs y subir los PNGs.
- **Writeback a la cola:** `PATCH /agent-jobs/:id {status:done, resultUrl:<assets>}`.
- **⚠️ Confirmar el contrato de adjuntar assets al brief.** `AGENT.md` dice
  `POST /production/:brief_id/design` con `editorId`, pero eso **no existe en código** (verificado);
  el mecanismo real es `PATCH /agent-jobs/:id done`. Hay que confirmar cómo los PNGs se vuelven los
  assets de diseño del brief para que el **flujo de aprobación + publicación ACTUAL** (revisión →
  Metricool) los tome. Tarea de investigación acotada en Prewave (`routers/production.ts`,
  `drive-assets`, cómo hoy un carrusel manual adjunta sus imágenes).
- **Publicación:** NO reinventar. Dejar que el pipeline de publicación actual (GCS + Metricool,
  `providers/social`) publique, igual que un carrusel manual hoy.

### Fase 8 — Empaquetado para diseñadoras
- **Setup de un comando:** `npm run setup` (ya existe `scripts/setup.mjs`) + `doctor` que verifique
  Claude CLI, Chrome, token de Prewave.
- **Guía** (reemplaza `GUIA-DISENADORAS`): arrancar la app, login, bandeja de trabajos, pegar URL,
  editar, exportar/entregar.
- **Actualización de fuentes/marca:** documentar cómo se re-importan avatares si cambia un ADN.

### Fase 9 — Rollout y jubilación de Canva
- **Piloto** con Isabella + Cinthya/Guillermo: 5–10 carruseles reales, comparar contra Canva.
- Cuando la calidad convence: apagar el enqueue hacia el worker de Canva y apuntar la cola al nuevo.
- Archivar `30x-carousel-pipeline` (dejar el extractor de IG documentado, ya portado).

---

## 5. Qué se reusa vs qué se construye

**Se reusa tal cual (0 trabajo):**
- Motor de render Puppeteer→PNG, contrato WYSIWYG, fonts base64, sRGB, workarounds Windows.
- Chat con Claude local, budget cap, streaming.
- Editor base: filmstrip, undo, versiones, captions, safe-zones, aspect ratios, upload, export ZIP.
- Ingesta Prewave `agent_jobs` (cola + scope por JWT) — **sin tocar el backend**.
- Descarga de referente IG (portar de `AGENT.md`, ya probado).
- Publicación (GCS signed-URL + Metricool) — el flujo actual.

**Se construye:**
- Import `adn.json → StylePreset` (8 avatares) + multi-marca en un install.
- Formatos HTML por avatar (3–6 c/u) — **el laburo de diseño recurrente**.
- Módulo de ingesta desde la cola + bandeja de trabajos + login local.
- Entrada manual de URL + disparo de generación.
- System prompt de generación (estructura fiel + voz + formatos).
- Controles de edición visual: imágenes, degradados, fonts/tamaños por elemento.
- Writeback done + subida de assets + (confirmar) adjuntar al brief.

## 6. Decisiones abiertas (necesito tu OK)

1. **Repo:** ¿fork nuevo `30x-carrusel-studio` o rama sobre `open-carrusel`? (Recomiendo fork nuevo,
   privado, para no mezclar con el de Sembradores.)
2. **Multi-marca:** confirmar que una diseñadora maneja **varios avatares en un mismo install**
   (preset activo = avatar). Alternativa (peor): un install por avatar. (Recomiendo multi-avatar.)
3. **Alcance del editor:** ¿WYSIWYG por-elemento completo (click en cualquier texto/imagen → toolbar
   de font/tamaño/color/posición, tipo Canva de verdad) o v1 con paneles + chat y after iteramos?
   El primero es más trabajo; el segundo entrega antes. (Recomiendo v1 rápido, luego el WYSIWYG.)
4. **Publicación:** confirmar que reusamos el flujo actual (writeback → aprobación → Metricool) y NO
   publicamos desde la app. (Recomiendo reusar; es tu requisito de "ingesta actual", lo extiendo a
   la salida.)
5. **El 403 de la cola** (jobs de Producción donde `createdBy` no cuenta como dueño): ¿lo arreglamos
   de una en `agent-jobs.ts` (que quien encola pueda cerrar), o lo dejamos porque en el flujo real la
   diseñadora que trabaja el job es la asignada/revisora? (Recomiendo el fix chico, por las dudas.)
6. **Dónde "vive" para la diseñadora:** local-first (cada una en su máquina, tu pedido) — confirmado.
   ¿Querés además que en algún momento sea una superficie desplegada dentro de Prewave, o queda local?

## 7. Orden sugerido de ejecución (para ver valor rápido)

1. **POC (1–2 días):** Fase 1 (Cinthya) + Fase 2 (2–3 formatos Cinthya) + Fase 5 manual con una URL
   → comparar PNG vs Canva. **Sin cola todavía.** Es el "¿esto se ve bien?" que destraba todo.
2. Fase 3 + 4 (ingesta cola + entrada manual) → una diseñadora ya trabaja end-to-end.
3. Fase 6 (editor Canva) en paralelo, iterativo.
4. Fase 7 (writeback/publicación) → cierra el círculo con Prewave.
5. Fase 8 + 9 (empaquetado + rollout + apagar Canva).
```
