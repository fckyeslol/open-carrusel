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
  preview iframe (selection, drag with smart guides, groups, layers, text ranges, effects,
  box spacing, photo frames).
  A photo that fills a clipping container (the ADN formats frame them: the round medallion,
  the quote card) pans its `object-position` on drag instead of sliding out of the crop and
  getting cut. `clipFrame()` deliberately ignores the slide root — clipping against the
  canvas edge is correct, not a frame to escape. `unframe` is the escape hatch.
  **A text is one object, like in Canva.** `textHost()` folds inline runs (`<b>`, `<span>`,
  the editor's own `data-oc-rs`) into their paragraph, so clicking a highlighted word selects
  the whole sentence — emphasis is character formatting, applied by marking a range in inline
  edit mode, not a separate element (`Alt`+click still grabs the run). `isTextEl()` counts a
  line that shares its box with an *atomic* child — one with no words of its own, like the
  mandatory 30x logo SVG or a hand-drawn underline — as editable text, and `editText()` marks
  those children `contenteditable="false"` so the caret can't take the logo apart.
  `candidateAt()` still hands a painted child inside a text (that logo, a bar) its own clicks,
  but only off the glyphs — a highlight passing behind the words must not steal the sentence.
  `textAt()` is the double-click drill-down: it reaches a text the click resolved to a
  container, so a double click never does nothing.
  It lives inside a `String.raw` template, so **TypeScript does not check it** — a stray
  backtick silently breaks the build and a logic error only shows up by hand. Verify with
  `npm run check:editor`, which loads the real runtime in Chromium and drives the
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
- `scripts/repalette-carousels.mjs` — Re-paints already-stored carousels when a brand hex is
  corrected in an ADN (reads `visual_identity._paleta_hex_previos`). Dry-run by default
- `src/lib/csv-batch.ts` — Parser for the nightly batch CSV (`URL, Avenger, Diseñadora,
  Higgsfield`). Never throws: every row comes back either usable or skipped-with-a-reason
- `src/lib/batch-intake.ts` — CSV → resolved rows → `Assignment`s. Owns the skip policy:
  no avatar match ⇒ row dropped (nothing to generate with); no designer match ⇒ row still
  generated, owned by whoever uploaded the file
- `src/lib/batch-scheduler.ts` — One-minute tick that dispatches batches whose window
  arrived. Deliberately not a long `setTimeout`: that wouldn't survive a redeploy, and a
  batch silently lost overnight is the worst failure here
- `src/lib/reviews.ts` — Per-designer review counter. One mark per (designer, job, day),
  so the number is auditable instead of a raw click tally
- `src/lib/admin.ts` — `THIRTYX_ADMIN_USERS`: who may see team-wide data (`/revisiones`).
  Defaults to `isabella@30x.com`
- `src/lib/library-folders.ts` — Groups `/biblioteca` into one folder per avenger. Pure, so
  the grouping is tested on its own. The board only shows the 3 most recent `Entregados`
  (`ENTREGADOS_VISIBLES` in `ReviewBoard.tsx`) and links the rest here: that column never
  empties by itself, so uncapped it pushed the rest of the board off screen. The open folder
  travels in `?avenger=`, read server-side in `src/app/biblioteca/page.tsx`

## Review Counter

Designers press **"Revisado"** on a `pending_review` card to log that they reviewed that
carousel. It only feeds the counter: no status change, no Prewave call, the card stays put.
Approving also counts — nobody delivers a carousel without looking at it, so a counter that
depended on the button alone would undercount whoever approves straight away.

- **Idempotent per (designer, job, day).** Pressing twice the same day does not add;
  reviewing the same job tomorrow does, because that is new work. Approving after pressing
  the button still counts once
- **The day is the server's local day** (`America/Bogota` in the deploy — that's what the
  Dockerfile's tzdata is for), same as the nightly batch window. With UTC, everything
  reviewed after 19:00 Bogotá would land on the next day
- Each designer sees her own tally on `/tablero`; `/revisiones` shows the whole team and is
  gated by `admin.ts`. Marks are pruned after 120 days

## Nightly CSV Batch

Designers upload a CSV from `/30x` instead of driving the agent by hand all day. Rows become
regular assignments with `origin: "csv"`, so they reuse the whole existing pipeline —
lane serialization, checkpoints, preemption, retry, the board — with three differences:

- **No Prewave.** CSV jobs have a local synthetic `jobId`, so claim/writeback are skipped
  (`isPrewaveJob` in `thirtyx-runner.ts`). They finish at `done`, not `pending_review`
- **Higgsfield per row.** The Si/No column becomes `Assignment.higgsfield`, which overrides
  the global config when generating (`false` wins; `true` can't conjure missing credentials)
- **Never blocks.** One bad URL fails its own job and the batch keeps going; the batch closes
  when its last row settles, however it settled

Window is `BATCH_NIGHT_HOUR` (default 20:00, server-local). The server must be up at that
hour. `scheduledFor` is stored, so a restart doesn't lose the batch.

## Avatar Identity

Each avatar's identity lives in `30x/avatars/<slug>/adn.json` — the single source of truth. Three
things flow out of it, all keyed by the **directory name** (not `avatar.slug`):

- `scripts/import-avatars.mjs` derives `data/style-presets.json`: `tipografia.familia` →
  `fonts.heading`, optional `tipografia.familia_cuerpo` → `fonts.body` (only Cora Bilbao has two
  families), and `paleta[].rol` → the app's 5 color roles. The declared `rol` wins over any
  luminance/saturation guess, so palette wording matters — see `_TEMPLATE/adn.json`
- `public/30x-slides/<slug>/formato-*.html` are the avatar's reference formats. The importer picks
  the first one as `exampleSlideHtml`, which the system prompt injects as "ADN del avatar". Their
  hardcoded hexes must track the ADN palette or the agent copies stale colors
- `src/lib/quality/design-system.mjs` unions ADN + preset + reference-slide colors and fonts, so
  drift is measured against the avatar's real identity

`#F6F5F0` ("30% White") is the shared base across all mentors and carries ~40% of each piece; the
remaining 60% is the avatar's own 3–4 colors. Font pickers must list all avatar families:
`EDITOR_FONTS` in `src/lib/slide-editor.ts` and `POPULAR_FONTS` in `src/app/api/fonts/route.ts`.

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
- `POST /api/thirtyx/batches` — Upload the nightly CSV. `?preview=1` parses and resolves
  without writing anything (what the UI shows before you confirm); `?run=now` skips the wait
- `GET /api/thirtyx/batches` — List batches with derived progress
- `GET/POST/DELETE /api/thirtyx/batches/[id]` — Detail / run now / cancel (cancel only before it starts)
- `POST /api/thirtyx/assignments/[jobId]/reviewed` — Count this carousel as reviewed today.
  Idempotent; changes nothing else about the assignment
- `GET /api/thirtyx/reviews?days=7|14|30` — Team review dashboard. Admin-only (`admin.ts`)

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
