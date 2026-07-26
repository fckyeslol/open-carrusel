# Assets de este Avenger

Soltá acá los archivos de marca del avatar. Quedan versionados en git: se guardan
para siempre y le llegan a todo el equipo con `git pull`. El sistema los detecta
solo al arrancar la app (`npm run abrir`) — no hay que configurar nada.

## Qué va en cada carpeta

| Carpeta        | Qué poner                                                  | Cómo lo usa el sistema |
| -------------- | ---------------------------------------------------------- | ---------------------- |
| `logo/`        | Logo o firma visual del mentor (1 archivo ideal)           | Logo del preset del avatar |
| `fotos/`       | Retratos del mentor                                        | FONDO 3 — FOTO MENTOR en las láminas |
| `fondos/`      | Fondos de marca: texturas, degradés, planos                | Fondos de lámina (FONDO 1, 2 y 4) |
| `referencias/` | Carruseles/diseños ya publicados del mentor (PNG/JPG)      | Calibrar estilo al generar |

## Reglas

- Formatos: PNG, JPG, WebP, GIF o SVG.
- Nombres sin espacios ni tildes (`retrato-oficina.jpg`, no `Retrato Oficina.jpg`).
- Tamaño razonable: exportá a ≤ 2000px de lado y ≤ 5 MB por archivo — esto viaja
  por git, no subas originales de cámara.
- Para que llegue al equipo: commit + push a `main`.

Dentro de las láminas cada archivo queda disponible en la URL
`/avatar-assets/<slug>/<carpeta>/<archivo>` (p. ej.
`/avatar-assets/cinthya/fotos/retrato-oficina.jpg`).
