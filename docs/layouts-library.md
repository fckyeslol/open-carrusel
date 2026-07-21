# Biblioteca de Layouts — Carruseles 30x

> Catálogo consolidado de los moldes de lámina del sistema de diseño 30x en Canva.
> Es el *registry* que el pipeline (referente IG → reconstruir en formato 30x → Canva) usa para
> mapear cada slide de un referente a un layout y rellenarlo vía el MCP de Canva.
>
> Fuente: análisis de la cuenta de Canva 30x (2026-07-08). Cuenta reconectada = 30x (brand kit `Inter`, id `kAHMA2FKdfA`).
> Formato base de todos: **1080×1350 px (4:5 vertical)**.

---

## 1. Cómo lo usa el pipeline

1. **Descargar** las slides del carrusel referente (Playwright + JSON embebido `carousel_media`; ver research).
2. **Clasificar** cada slide leyéndola con visión → asignarle un `layout_id` de esta biblioteca (ver §5).
3. **Ensamblar** la secuencia de layouts (portada → cuerpos → cierre) y elegir el **molde maestro** que la contenga.
4. **Duplicar** el molde (`copy-design`), abrir `start-editing-transaction`, **rellenar por rol de campo**
   (`replace_text` / `update_fill`), `commit`.
5. El diseñador ajusta y aprueba.

> **Nota sobre IDs de elementos:** los `element_id` son específicos de cada diseño y **cambian al duplicar**.
> Por eso la biblioteca documenta **roles de campo** (semánticos), no IDs. El pipeline re-resuelve los IDs
> tras `start-editing-transaction` haciendo match por el texto/posición de cada rol.

---

## 2. Mobiliario de marca (fijo en casi toda lámina)

| Elemento | Valor / nota |
|---|---|
| Logo | Imagen "30X" (arriba-izq o centrado abajo) |
| Handle | **⚠️ inconsistente hoy** — normalizar por programa (ver §6) |
| Tagline | **⚠️ inconsistente** — varía por pilar (ver §6) |
| Resaltado | Barra/subrayado **verde lima** sobre palabra clave (marca de agua del sistema) |
| Tipografía | Brand kit `Inter` (la API NO permite cambiar familia → el molde ya la trae) |
| Nº de página | Algunos formatos lo muestran ("1 / 7") |

---

## 3. Moldes maestros disponibles (para duplicar)

| Molde | design_id | Págs | Contiene |
|---|---|---|---|
| **30X Carousel Studio — Multipliers** | `DAHOwdu6BnM` | 6 | KIT: portada + dato + comparativo + principio + proceso + cierre |
| Carrusel Multipliers · 30x | `DAHOtxP-Dpk` | 7 | Serie de datos/estadísticas + fuentes |
| Reunión "Nunca digas / Di" | `DAHOV4jYR94` | 8 | Portada guía + 5 comparativos ✕✓ + insight + CTA |
| IA burbuja (BoE) · v2 | `DAHOuNLeAHQ` | 7 | Editorial de datos con **placeholders de imagen + notas de arte** |
| Programa Inmersivo CDMX | `DAHORqXRR0o` | 4 | Evento presencial (fechas, speakers, agenda) |
| multipliers_carouselFlyer | `DAHKz2-ofYY` | 1 | Flyer suelto |

---

## 4. Catálogo de layouts

Cada layout: **propósito · molde fuente (design_id : página) · campos (rol → ejemplo) · elementos fijos**.

### L1 · Portada (cover)
- **Propósito:** primera lámina — gancho + promesa + "desliza".
- **Molde:** `DAHOV4jYR94:1` (guía) · alt `DAHOwdu6BnM:1` (Multipliers).
- **Campos:**
  - `kicker` → categoría · "Guía · Psicología", "Alerta de mercados · 30x"
  - `titulo_grande` → 1 palabra/frase fuerte · "MENTE.", "REUNIÓN."
  - `subtitulo` → promesa · "Cómo influir sin que lo noten."
  - `bajada` → alcance/nº · "7 formas comprobadas de guiar una conversación."
  - `cta_swipe` → "Desliza →"
- **Fijos:** logo 30X, foto de fondo (opcional, `update_fill`).

### L2 · Dato / estadística
- **Propósito:** lámina de credibilidad con número grande + fuente.
- **Molde:** `DAHOtxP-Dpk:2` · alt `DAHOwdu6BnM:2`.
- **Campos:**
  - `stat` → número gigante · "75%", "US$ 5 billones"
  - `stat_desc` → qué mide · "de los ejecutivos le atribuye su éxito a un mentor."
  - `cuerpo` → desarrollo · (párrafo de contexto)
  - `fuente` → "Fuentes: Olivet Nazarene University · CNBC/SurveyMonkey"
- **Fijos:** logo, handle, tagline.

### L3 · Comparativo ✕ / ✓
- **Propósito:** contraste "no digas X / di Y" (o mal hábito vs bueno). El más fuerte del sistema.
- **Molde:** `DAHOV4jYR94:2–6` (5 slots).
- **Campos:**
  - `header_l1` + `header_l2` → contexto en 2 líneas · "cuando alguien" / "se disculpa"
  - `label_mal` → "✕ Nunca digas" (fijo)
  - `label_bien` → "✓ Di" (fijo)
  - `frase_mal` → ejemplo malo (columna izq) · "Está bien."
  - `frase_bien` → ejemplo bueno (columna der) · "Ya me lo imaginé."
  - `sublabel` (opc.) → micro-remate · "La disculpa pierde su peso"
- **Fijos:** logo, barras verdes, foto ×2 (opcional por columna).

### L4 · Principio / quote
- **Propósito:** frase-tesis del contenido.
- **Molde:** `DAHOwdu6BnM:4`.
- **Campos:**
  - `quote` → "No es networking. Es aprender de quienes ya lo lograron."
  - `desarrollo` → párrafo de respaldo
- **Fijos:** logo, handle, tagline.

### L5 · Proceso 01/02/03
- **Propósito:** pasos numerados (cómo entrar / cómo hacerlo).
- **Molde:** `DAHOwdu6BnM:5`.
- **Campos:**
  - `titulo` → "Cómo entrar" · `subtitulo` → "Tres pasos para un año adentro."
  - `paso[1..3].num` → "01" / "02" / "03"
  - `paso[1..3].titulo` → "Aplicá al proceso"
  - `paso[1..3].desc` → "Formulario corto. No es para todos."
- **Fijos:** logo, handle, tagline.

### L6 · Tip de un bloque (single-tip)
- **Propósito:** una técnica/consejo con cuerpo (cuando NO es comparación).
- **Molde:** `DAHOS_C5pck` (Carrusel Ventas, 15 págs) — cover p1 + **13 slots single-tip** (p2–14) + CTA p15.
  Es el molde de más slots del sistema → ideal para carruseles largos de tips.
- **Campos:** `titulo_tip` · `cuerpo` · `remate?` (el original usa patrón "Si le vendes a X… véndele Y").

### L7 · Editorial con imagen (data + foto dirigida)
- **Propósito:** lámina editorial oscura con foto temática. El más "pipeline-ready" (trae placeholders).
- **Molde:** `DAHOuNLeAHQ` / `DAHOtxgZ338` (todas sus páginas).
- **Campos:**
  - `nota_arte` → dirección de la imagen · "tablero de bolsa / velas rojas y verdes, tono editorial oscuro"
  - `img_slot` → placeholder (`update_fill`; tokens "Replace/Edit" en el molde)
  - `num_pagina` → "1 / 7"
  - `kicker` → "Alerta de mercados · 30x"
  - `hook`/`cuerpo` · `fuente`
- **Fijos:** logo, tagline "Aprende · Conecta · Crece".

### L8 · Cierre / CTA
- **Propósito:** última lámina — remate + llamado + follow.
- **Molde:** `DAHOV4jYR94:8` · alt `DAHOwdu6BnM:6`.
- **Campos:**
  - `remate_l1` + `remate_l2` → "Las palabras pasan." / "La percepción se queda."
  - `cta` → "Síguenos y guarda" / "Aplicá al proceso →"
  - `handle` → (normalizar, §6)
- **Fijos:** logo, ícono guardar.

### L9 · Insight / transición
- **Propósito:** lámina puente antes del cierre (una idea grande).
- **Molde:** `DAHOV4jYR94:7`.
- **Campos:** `headline` → "No es lo que dices. Es cómo lo dices." · `sub` → bajada.

### L10 · Evento / Inmersivo
- **Propósito:** promo de evento presencial.
- **Molde:** `DAHORqXRR0o` (4 págs).
- **Campos:** `fechas` ("29-31 JULIO") · `sede` ("CDMX") · `speakers[]` · `agenda[]` (Hot Seats, Networking…) · `negacion` ("NO ES un evento") · `cta` ("Comenta:").

---

## 5. Clasificador: slide del referente → layout

| Señal en la slide del referente | Layout |
|---|---|
| Es la 1ª, título grande + "swipe/desliza" | **L1** |
| Número/porcentaje dominante + fuente | **L2** |
| Dos columnas o patrón "no digas/di", "antes/después" | **L3** |
| Frase entre comillas centrada, tono tesis | **L4** |
| Lista "1. / 2. / 3." de pasos | **L5** |
| Consejo único con párrafo (sin contraste) | **L6** |
| Foto protagonista + dato editorial | **L7** |
| Última, "sígueme/guarda/link" | **L8** |
| Idea puente entre cuerpo y cierre | **L9** |
| Fechas + lugar + agenda | **L10** |

**Ajuste de conteo (REGLA CONFIRMADA 2026-07-08):**
- `copy-design` con `page_numbers` **puede SUBSETear y REORDENAR** cualquier combinación de páginas
  (verificado: `[1,2,7,8]` → diseño limpio de 4 págs en el orden dado).
- **NO puede repetir/duplicar** una página: `page_numbers` con un número repetido (`[1,2,2,7,8]`) **falla**
  con error engañoso "Design not found".
- La API de edición (`perform-editing-operations`) **no tiene** operación de añadir/duplicar/eliminar página.
- **Implicación:** el conteo se fija al copiar, subseteando hacia abajo. **No se puede exceder el nº de slots
  del molde elegido.** → Mantener moldes maestros con **slots generosos** por layout (p. ej. un comparativo
  con 7–8 slots) y recortar. Si un referente necesita más slots de los que hay, hoy se condensa el contenido.

---

## 6. Normalización de marca (PENDIENTE — decisión del usuario)

Hoy los carruseles mezclan identidades. El pipeline debe fijar, **por programa/avatar**, un valor canónico:

| Campo | Valores encontrados en la cuenta | Canónico → (definir) |
|---|---|---|
| Handle | @30xmultipliers · @crece30x · @crececon30x · @andresbilbao · @andres_bilbao0 | ? |
| Tagline | "No es para todos. Es para quien quiere más" · "Aprende · Conecta · Crece" · "El contenido pasa. El conocimiento se queda." | ? |
| CTA | "Aplicá al proceso →" · "Síguenos y guarda" · "Link en la bio" | ? |
| Voz | voseo AR (vos/aplicá/seguinos) mezclado con tuteo/neutral | ? |

> Recomendación: mapear (programa → handle + tagline + CTA + voz) en una tabla de config que el pipeline
> aplique automáticamente al rellenar L1/L8, para que la salida sea consistente sin depender del molde origen.

---

## 7. Huecos identificados

- ~~**L6 (tip de un bloque)** no tiene molde limpio~~ **RESUELTO:** `DAHOS_C5pck` (Ventas) sirve de master single-tip con 13 slots.
- **Conteo variable** (RESUELTO parcialmente): se subsetea con `copy-design`, pero **no se puede duplicar
  una página**. Acción → construir moldes maestros con slots de sobra por layout (comparativo, dato, tip)
  para poder recortar a cualquier longitud sin tener que duplicar.
- **Resaltado por-palabra** (verde) se pierde con `replace_text` → definir cómo re-aplicarlo (`format_text` colorea todo el elemento; hace falta separar la palabra clave en su propio elemento en los moldes).
