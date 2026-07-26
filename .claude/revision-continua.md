# Revisión continua

Procedimiento del agente revisor. Corre solo, cada ~20 min, por tres rutinas
escalonadas (`:09`, `:29`, `:49` — el mínimo de una rutina es horario, por eso
son tres y no una). Todas disparan sobre esta misma sesión y ejecutan lo de acá
abajo, así que el procedimiento se edita en UN lugar.

Rama del revisor: `claude/session-review-agent-m9y214`.

## Marcador de estado

No lleves SHAs escritos a mano: se vuelven mentira en dos rondas y el contenedor
es efímero. La regla es:

> Todo lo ya revisado es ancestro de `origin/claude/session-review-agent-m9y214`.

Al final de cada ronda mergeás la rama revisada en la del revisor, así el
marcador avanza solo y vive en git, que sí sobrevive a un reinicio.

**El marcador avanza al PUSHEAR, no al commitear en local.** Aprovechalo: mergeá
y commiteá apenas resolvés los conflictos, para no perder el trabajo, pero no
pushees hasta haber revisado de verdad. Si pusheás antes, esos commits quedan
marcados como revisados y ninguna ronda futura los va a mirar.

## Ronda

1. `cd /home/user/open-carrusel && git fetch origin --prune`

2. Para cada rama `claude/*` de origin (excluí la del revisor):
   `git rev-list --count origin/claude/session-review-agent-m9y214..<rama>`

   Descartá una rama si:
   - `git diff origin/main <rama>` sale vacío → ya fue squash-mergeada a main;
   - está en la lista de abandonadas de abajo.

3. Si no queda ninguna con commits nuevos: **terminá el turno en silencio.** Sin
   texto, sin resumen, sin "todo en orden". El silencio es la señal de que no
   pasó nada; un mensaje por hora diciendo que no pasó nada es ruido.

4. Si hay: tomá la del commit más reciente (si hay varias, mencionalas y seguí
   con esa). Leé el diff COMPLETO y verificá de verdad, no de palabra:

   - `npm ci` si falta `node_modules`
   - `npx tsc --noEmit`
   - `npx eslint` — hay 14 errores **preexistentes** en archivos que nadie tocó
     (`scripts/*.cjs`, `src/app/cuenta/page.tsx`, `AssignmentThumb.tsx`). No los
     reportes: no son de la rama.
   - `npm run check:editor` si tocaron el editor visual
   - y sobre todo: **probá a mano los casos que sus pruebas NO cubren.** Ahí
     aparecieron los dos bugs reales de la primera ronda; sus 29 verificaciones
     pasaban igual. Escribí un script puppeteer aparte si hace falta.

5. Dejá el marcador al día pase lo que pase:

   ```
   git checkout claude/session-review-agent-m9y214
   git merge origin/<rama>          # conflictos: conservá su intención + tus arreglos
   ```

   Si encontraste algo, arreglalo encima con su prueba. **Toda prueba nueva tiene
   que FALLAR contra el código sin arreglar antes de darla por buena** — si pasa
   en ambos lados, la prueba está mal, no el código. Después:

   ```
   git push -u origin claude/session-review-agent-m9y214
   ```

6. Reportá solo hallazgos verificados, con evidencia (números y salidas reales).
   No abras PR salvo pedido explícito.

## Ramas abandonadas

No las revises: su contenido ya está en `main`, o quedó atrás a propósito.

- `claude/avatar-styles-typography-wtjjxz` — squash-mergeada como PR #1
  (`git diff origin/main` sale vacío).
- `claude/logo-30x-white-box-hedq2z` — versión anterior de un fix que ya está en
  main, y **peor**: pone `X-Content-Type-Options: nosniff` solo en las respuestas
  SVG, mientras que main lo pone en todas. Mergearla sería un retroceso.
- `claude/logo-white-square-0yfm7m` — ya es ancestro de main.
