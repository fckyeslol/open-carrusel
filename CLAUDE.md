# Open Carrusel

AI-powered Instagram carousel builder. Next.js 16 + React 19 + TypeScript + Tailwind v4.

## Architecture

- **Frontend**: React app at localhost:3000 with chat panel (left), carousel preview (center), slide filmstrip (bottom)
- **AI Agent**: Claude CLI spawned as subprocess via `/api/chat`, communicates through SSE streaming
- **Storage**: JSON files in `/data/` with async-mutex locking and atomic writes
- **Export**: Puppeteer screenshots HTML slides to PNG at exact Instagram dimensions
- **Slides**: Full HTML documents rendered in sandboxed iframes. `wrapSlideHtml()` in `src/lib/slide-html.ts` is the shared rendering contract between preview and export.

## Key Files

- `src/lib/chat-system-prompt.ts` — Dynamic system prompt (injects brand config + carousel context)
- `src/lib/slide-html.ts` — `wrapSlideHtml()` wraps slide body HTML into full documents
- `src/lib/quality/` — Slide quality engine. Vendored impeccable detector (`engine/`, Apache-2.0,
  do not edit) plus the 30x adaptation layer: `slide-profile.mjs` (which rules apply to a slide),
  `design-system.mjs` (avatar ADN → design system, so drift is measured against the avatar's real
  palette instead of generic taste), `slide-rules.mjs` (30x-specific failure modes)
- `scripts/slide-check.mjs` — Renders a slide to PNG and lists its defects. Closes the generation
  loop: the agent renders, reads the PNG, fixes, and re-checks before moving on
- `src/lib/slide-editor.ts` — `EDITOR_RUNTIME`: the ~2000-line editor injected into the
  preview iframe (selection, drag with smart guides, groups, layers, text ranges, effects).
  It lives inside a `String.raw` template, so **TypeScript does not check it** — a stray
  backtick silently breaks the build and a logic error only shows up by hand. Verify with
  `node scripts/check-editor.mjs`, which loads the real runtime in Chromium and drives the
  mouse. Add a check there for anything you change
- `src/lib/strip-slide-background.mjs` — background stripping for "PNG sin fondo". Standalone
  because it runs inside the Puppeteer page (`page.evaluate`)
- `src/lib/data.ts` — JSON storage with proper async-mutex and atomic writes
- `src/lib/carousels.ts` — Carousel and slide CRUD with version history
- `src/lib/claude-path.ts` — Portable Claude CLI discovery
- `30x/avatars/<slug>/assets/` — Per-avatar brand assets (`logo/`, `fotos/`, `fondos/`,
  `referencias/`), versioned in git. Drop files in; `scripts/import-avatars.mjs` picks them up on
  next launch (sets `logoPath`, lists asset URLs in the preset's designRules). Served at
  `/avatar-assets/<slug>/<kind>/<file>` by `src/app/avatar-assets/[slug]/[...file]/route.ts`

## API Routes

All at localhost:3000:

- `POST /api/chat` — Claude CLI subprocess + SSE streaming
- `GET/POST /api/carousels` — List/create carousels
- `GET/PUT/DELETE /api/carousels/[id]` — Single carousel
- `POST /api/carousels/[id]/slides` — Add slide
- `PUT/DELETE /api/carousels/[id]/slides/[slideId]` — Update/delete slide
- `PUT /api/carousels/[id]/slides` — Reorder slides (body: { slideIds: [...] })
- `POST /api/carousels/[id]/slides/[slideId]/undo` — Undo slide change
- `POST /api/carousels/[id]/slides/[slideId]/review` — Render slide to PNG + run the quality detector
- `POST /api/carousels/[id]/export?slide=N` — Export one slide as direct PNG (2160px wide, 1-based index; defaults to slide 1). The UI downloads every slide as a separate .png — there is no ZIP export
- `GET/PUT /api/brand` — Brand configuration
- `GET/POST /api/templates` — Templates
- `POST /api/upload` — Image upload (PNG/JPG/WebP only, max 10MB)
- `POST /api/remove-bg` — Remove background from an /uploads/ image (local ONNX model, returns new transparent PNG)
- `POST /api/image-fx` — Bake a raster effect into an /uploads/ image (currently `pixelate`; returns a new PNG). Every other editor effect is CSS/SVG so preview and export match — this one exists because SVG filters have no downsampling primitive
- `GET /api/fonts` — Google Fonts list
- `GET /avatar-assets/{slug}/{kind}/{file}` — Serve per-avatar brand assets from `30x/avatars/`

## Conventions

- Components max ~300 lines per file
- Use `cn()` from `src/lib/utils.ts` for class merging
- Types in `src/types/`, libs in `src/lib/`, components in `src/components/`
- All data mutations go through `src/lib/data.ts` (never direct fs writes for JSON)
- iframe slides always use `sandbox=""` attribute (no JavaScript execution)
- The Claude subprocess gets `--allowedTools Bash WebFetch` and uses curl to call local API routes

## Instagram Dimensions

- 1:1 = 1080x1080 (square)
- 4:5 = 1080x1350 (portrait, recommended)
- 9:16 = 1080x1920 (story)
- Max 10 slides per carousel

## Slide HTML Rules

Slides store body-level HTML only (no `<html>`, `<head>`, `<!DOCTYPE>`). The `wrapSlideHtml()` function adds the full document structure, font loading, and dimension constraints. Slides should:

- Use inline styles or `<style>` tags
- Reference images as `/uploads/{filename}` paths
- Use Google Font family names in font-family declarations
- NOT contain `<script>` tags (enforced by iframe sandbox)
- Target the carousel's aspect ratio dimensions
