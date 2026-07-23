# Crítica de lámina

Cómo mirar una lámina renderizada y decidir si está lista.

Adaptado de la metodología de crítica de [impeccable](https://github.com/pbakaus/impeccable)
(Apache-2.0). Sus heurísticas están escritas para interfaces web con las que alguien
interactúa; una lámina es una imagen que alguien desliza en un feed. Las dimensiones
de abajo son las que aplican a ese medio.

## El norte

**Parecerse lo más posible al referente.** Toda duda se resuelve hacia el referente,
no hacia lo que sería mejor diseño. No estás juzgando si la lámina es buena: estás
juzgando si se parece.

## Antes de criticar

**Leé las dos imágenes, no una.** `slide-check` imprime la ruta del referente y la de
tu render. Abrilas con Read y compará lado a lado. Juzgar la lámina aislada responde
"¿está bien?", que es la pregunta equivocada.

Compará en este orden, porque los defectos de arriba invalidan los de abajo:

1. **Masa y posición** de cada bloque — ¿la silueta general es la misma?
2. **Materialidad** — grano, textura, dobleces, contraste del soporte
3. **Escala relativa** — ¿el elemento dominante domina tanto como en el referente?
4. **Color** — última, porque es lo único que debe diferir

Un screenshot que no leíste no cuenta, y describir lo que *creés* que generaste no
es mirar. La mitad de los defectos que importan —texto que se amontona, una imagen
que tapa el titular, un contraste que colapsa— no existen en el HTML: aparecen
recién al rasterizar.

**El detector es evidencia de defectos, nunca prueba de que la lámina está bien.**
Cero hallazgos y un PNG sin abrir es una lámina sin revisar.

**No inventes defectos para demostrar que iteraste.** Un "primera pasada limpia,
sigo" honesto vale más que un arreglo fabricado.

## Las dimensiones

Puntuá cada una de 0 a 4. Total sobre 24 — o sobre 20 cuando *Materialidad* no
aplica porque el referente no es un objeto fotografiado.

### 1. Fidelidad al referente

La Regla #1 de 30x: el layout lo manda el referente, siempre.

- ¿La composición es la misma? Posición del titular, del bloque de texto, de la
  imagen, del pie.
- ¿El conteo de láminas es 1:1 con el referente, en el mismo orden?
- ¿Agregaste chrome que el referente no tenía? Si el referente no lleva logo,
  kicker ni firma, tu lámina tampoco.
- **¿La silueta de los bloques de texto coincide?** Un bloque parejo en el
  referente que en tu lámina termina en dos líneas cortas ya no es el mismo
  layout, aunque el texto sea correcto. Redistribuí los quiebres.

**0** = inventaste un layout. **4** = alguien que ve las dos las reconoce como la
misma estructura.

### 1b. Materialidad

Solo aplica cuando el usuario pidió **explícitamente** el efecto de textura/grano
en el chat. Si NO lo pidió, la dimensión se evalúa al revés: cualquier grano,
ruido o feTurbulence superpuesto es un **defecto que hay que quitar** — sobre
todo encima de una foto de fondo, donde el grano la ensucia. Sin pedido
explícito, fondo limpio = 4 y lámina con grano = 0.

Cuando sí lo pidió:

- ¿El grano se ve **igual de fuerte** que el referente, o insinuaste una textura
  que a tamaño miniatura desaparece? Una capa de ruido al 5% lee "digital".
- ¿Los dobleces proyectan sombra, o son degradados difusos? Un pliegue sin sombra
  se ve impreso, no plegado.
- ¿El grano es del tipo correcto — moteado uniforme vs fibra direccional?

Esta dimensión no la puede medir el detector. Solo existe si la mirás.

**0** = fondo plano digital. **4** = pasa por el mismo material fotografiado.

### 2. Identidad del avatar

Lo único que cambia respecto del referente es *nuestra* identidad.

- ¿Los colores salen de la paleta del avatar, o te quedaste con los del referente?
  Este es el error más frecuente y el más difícil de ver a ojo: el degradé del
  referente se siente "bien" porque es el que estabas mirando.
- ¿La tipografía es la del ADN?
- ¿La firma y el tratamiento son los del avatar?
- ¿La marca "30x" aparece tipeada como texto? Va SIEMPRE con el logo SVG
  (`/30x/logo-light.svg` fondo oscuro, `/30x/logo-dark.svg` fondo claro,
  `/30x/logo-accent.svg` X lima), nunca en texto plano — ni en la firma ni
  dentro de un titular. El hallazgo `slide-brand-as-text` mide exactamente esto.

Los hallazgos `design-system-color` y `design-system-font` de `slide-check` miden
exactamente esto. No bloquean porque un color fuera de paleta puede ser legítimo
—un overlay sobre foto, un degradé heredado— pero cada uno merece una respuesta
consciente: o lo justificás, o lo corregís.

**0** = es la identidad del referente. **4** = es inequívocamente el avatar.

### 3. Legibilidad en el medio real

La lámina se ve primero como miniatura en un feed, y se desliza rápido.

- ¿El titular se lee a tamaño miniatura? Achicá el PNG mentalmente a 200px de
  ancho: si el titular deja de leerse, no funciona.
- ¿El contraste aguanta? Texto claro sobre foto clara colapsa al comprimir.
- ¿Hay texto crítico dentro de los 108px del borde (la zona segura es un padding
  firme de 108px por lado), donde Instagram superpone su UI?
- ¿Algún texto se desborda o se corta?

**0** = hay que hacer zoom para leerla. **4** = el mensaje entra en un vistazo.

### 4. Fidelidad del contenido

- Cifras, nombres propios, fechas y citas: exactos al referente. Sin redondear,
  sin "mejorar".
- **Idioma: SIEMPRE español.** Sin importar el idioma del referente, el texto de
  la lámina va en español con la voz del avatar. No es una decisión a evaluar: la
  audiencia de 30x es hispanohablante. Lo que se preserva no es el idioma sino la
  SILUETA del bloque — redistribuí los quiebres para que el texto traducido
  conserve la misma forma (mismo número de líneas, anchos parejos si el referente
  los tiene). Una lámina que dejó texto en el idioma original es un error de
  calco, no una fidelidad.
- ¿El texto entra sin recortarse? Si no entra, el problema es el tamaño de fuente
  o el layout, no el texto: no lo mutiles.

**0** = inventaste o alteraste datos. **4** = verificable contra el referente.

### 5. Que no se vea hecha por IA

Los tells que delatan una lámina generada:

- Grillas de tarjetas idénticas; tarjetas dentro de tarjetas.
- Marcadores numerados 01 / 02 / 03.
- Kicker en mayúsculas espaciadas sobre cada sección.
- Texto con degradé.
- Emojis como decoración.
- Espaciado uniforme en todo: mismo padding, mismo margen, misma medida.
- Todo perfectamente centrado y perfectamente simétrico.

El kit de técnicas del system prompt (textura de papel, pincelada rugosa, bloques
sólidos, serif negro gigante) existe para esto. Usalo cuando el referente lo pida.

**0** = plantilla genérica. **4** = pasa por hecha a mano.

## Bandas

Como fracción del total posible:

| % del total | Lectura |
|---|---|
| 90-100% | Excelente. Publicable como está. |
| 70-89% | Buena. Uno o dos ajustes puntuales. |
| 50-69% | Aceptable. Hay trabajo real pendiente. |
| 30-49% | Pobre. Rehacer la lámina. |
| 0-29% | Crítico. Volvé a mirar el referente. |

Sé honesto con el puntaje. Un 4 significa genuinamente excelente. La mayoría de
las primeras pasadas caen entre 55% y 70%.

**Fidelidad al referente y Materialidad no se compensan.** Un 4 en legibilidad no
rescata un 1 en fidelidad: la lámina puede ser bonita y aun así no ser un calco,
que es lo único que se pidió.

## Después de criticar

Corregí lo material y volvé a correr `slide-check` sobre la lámina. Re-inspeccionar
es parte del ciclo, no un extra: un arreglo que no verificaste es una hipótesis.

Si la segunda pasada no mejora el puntaje, decilo en vez de seguir iterando a
ciegas.
