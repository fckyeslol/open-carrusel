# Guía — Generador de carruseles 30x (local, por diseñadora)

Cada diseñadora corre la app en su compu. La app trae **sus** carruseles asignados desde
Prewave (con su token), los **genera solos** con el ADN del avenger, ella hace **QA** y
**entrega en Prewave**. Sin hosting, sin webhooks, sin costo de servidor.

---

## 1. Para las diseñadoras (uso diario)

**Una vez (setup):**
- Tener instalado **Node 20+**, **Google Chrome** y el **Claude CLI** ya logueado (el que usás normalmente). La generación usa tu propia sesión de Claude.
- En la carpeta del proyecto: `npm install` (solo la primera vez).
- Copiá **`.env.example`** a **`.env.local`** (ahí va tu token de Prewave — ver §2).
- Verificá la conexión: **`npm run prewave:check`** (te dice si el token funciona y cuántos carruseles tenés en tu bandeja).

**Cada día:**
1. `npm run dev` y abrí **`http://localhost:3000/30x`**.
2. Si es la primera vez: apretá **Conectar Prewave** y pegá tu token *(si ya te lo dejaron cargado, saltá este paso — ver §2)*.
3. La app trae **sola** tus carruseles asignados, agrupados por avenger, y los va generando:
   *En cola → Bajando referente → Generando → Renderizando → **Listo para QA***.
4. Apretá **Abrir para QA**, revisá/ajustá el carrusel y exportá si querés.
5. **Entregá en Prewave** como siempre (subir el diseño en el tablero de producción). La app **no** entrega por vos — vos aprobás lo que sale.

Si un carrusel falla, sale en rojo con el motivo y un botón **Reintentar**.

## 2. Para ops (pre-cargar el token — opcional, para ahorrarles el paso)

Podés dejar el token de cada una ya cargado en su compu, así se saltan el paso 2:
- En el archivo **`.env.local`** del proyecto, en su máquina:
  ```
  PREWAVE_TOKEN=<el token de ESA diseñadora>
  PREWAVE_API_BASE=https://api.prewave.oracle30x.co/api/v1
  ```
- El token es el **JWT de su sesión de Prewave** y **dura 30 días**. Se obtiene de su sesión
  logueada en Prewave (o pedíselo al equipo de Prewave). Cuando vence, la app muestra
  "Conectá tu token" y hay que renovarlo.
- **Tiene que ser el token de ELLA** (scopea a sus avatares). No compartas uno entre varias:
  cada una ve y genera solo lo suyo.

⚠️ **Seguridad:** un token = poder actuar como esa persona en Prewave. Guardalos con cuidado y
renovalos al vencer.

**Verificar un token/máquina:** `npm run prewave:check`. Responde:
- ✅ conectado + cuántos carruseles tiene en su bandeja,
- ❌ 401 → token vencido/ inválido (renovar),
- ❌ 404 → el endpoint aún no está desplegado en Prewave prod (ver §3).

## 3. Para el dev de Prewave (una tarea, una sola vez)

**Ya implementado** en `api/src/routers/production.ts` (al lado de `/my-queue`), rama
`feat/design-queue-endpoint` desde `company/main`, commit `92968e3b` — 1 archivo, +39 líneas,
read-only. **Pendiente:** push + PR a `company/main` y deploy a prod.

`GET /production/design-queue` devuelve `{ items: ApiBrief[] }` con los carruseles **asignados a
la diseñadora** que necesitan diseño. Filtro real (corregido respecto al plan original — los
carruseles **nunca** están en `por_disenar`, esa es la etapa de diseño de *video* tipo Cora; los
carruseles se trabajan en `por_editar` asignados vía `assignedEditorId`):

- `content_format = 'carrusel'`
- `assigned_editor_id = <su usuario>` (scope por su JWT)
- `status IN ('por_editar', 'por_corregir')` (estados pre-entrega)
- `innerJoin scored_post/raw_post` → solo briefs con post scrapeado (traen `canonical_url` de IG)

- Devuelve `{ items: ApiBrief[] }`. La app usa de cada item: `id`, `avatar.slug`, `avatar.name`
  y `scored_post.raw_post.canonical_url` (el referente de IG a calcar).
- Los imports que usa (`avatars`, `curatedBriefs`, `scoredPosts`, `rawPosts`, `authorities`,
  `sources`, `and`, `eq`, `inArray`, `isNull`, `desc`, `toApiBrief`) **ya existen** en ese archivo.
- Solo trae briefs con post scrapeado (el `innerJoin` de `scored_post`), que son los que tienen
  referente de IG. Los manuales sin referente no aplican al calco automático.

## Flujo completo

```
Prewave (tus carruseles asignados en producción, con su avenger)
   │  la app local jala con el token de la diseñadora (GET /production/design-queue)
   ▼
Open Carrusel local  →  genera solo (ADN del avenger)  →  QA de la diseñadora
   ▼
Prewave  ←  la diseñadora entrega el diseño (flujo normal del tablero)
```

## Variables de entorno (resumen)

| Variable | Dónde | Para qué |
|---|---|---|
| `PREWAVE_TOKEN` | `.env.local` de cada compu | Token JWT de esa diseñadora (30 días). Opcional: si no, lo pega en el panel. |
| `PREWAVE_API_BASE` | `.env.local` | Base de la API de Prewave (default ya correcto). |
| `THIRTYX_MAX_CONCURRENT` | `.env.local` | Cuántos genera en paralelo (default `4`, tope `8`). |
| `CLAUDE_CLI_PATH` | `.env.local` | Solo si el Claude CLI no está en el PATH. |
