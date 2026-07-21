# Carruseles 30x — mapa del proyecto

Todo el sistema de carruseles de 30x vive en **esta carpeta** (`C:\Users\mateo\30x-carruseles`).
Reemplaza al pipeline de Canva, que quedó muerto.

## Arrancar

```bash
npm install     # solo la primera vez
npm run dev     # http://localhost:3000
```

Panel de 30x: `http://localhost:3000/30x`

## Qué hay dónde

| Carpeta | Qué es |
|---|---|
| `src/` | La app (Next.js). El editor visual está en `src/lib/slide-editor.ts` + `src/components/editor/VisualEditor.tsx` |
| `src/lib/chat-system-prompt.ts` | **La regla del CALCO.** Lo que hace que el carrusel se parezca al referente |
| `src/lib/prewave.ts` | Cliente de la cola `agent_jobs` de producción |
| `src/lib/instagram.ts` | Descarga el referente de IG |
| `30x/avatars/<slug>/adn.json` | **Identidad de cada mentor**: fuente, paleta, voz. Fuente de verdad |
| `30x/scripts/` | Generadores del calco (`build_calco.py`) + `content.json` con el contenido extraído |
| `public/30x-slides/` | Formatos de referencia por avatar + los 3 layouts de calco validados |
| `public/uploads/` | Fotos de los mentores y assets de marca. **Fuera de git a propósito** (pesan) |
| `30x/brand-kit/` | Fuentes (Inter/Archivo), logos, paleta, degradados, referencias, universo gráfico, brandbook y podcasts. 520 MB, **fuera de git** |
| `data/style-presets.json` | Presets generados desde los `adn.json` (`node scripts/import-avatars.mjs`) |
| `docs/` | Plan de migración y guías |

## Lo que NO está acá (a propósito)

- **Fotos crudas del evento 30X** (270 archivos, 1.23 GB) → siguen en
  `OneDrive\Desktop\prewave\30x-brand-kit\Claude Mateo\CONTENIDO MEDIA`.
  No son brand kit: es material de un shoot, a 20-36 MB por foto. El resto del
  brand kit sí está acá en `30x/brand-kit/`.
- **Pipeline viejo de Canva** → `C:\Users\mateo\30x-carousel-pipeline`. Muerto; solo se conserva
  porque de ahí salieron los `adn.json` (ya copiados acá).

## Regla #1 del diseño

El referente manda **todo el layout**. Lo único que se sustituye es la fuente, la paleta,
el logo, la firma y la voz del avatar. Los "formatos" de ejemplo son referencia de
**identidad**, no moldes de layout.
