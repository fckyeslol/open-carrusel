# Guía · Generar carruseles 30x con IA (para diseñadoras)

## ¿Qué es esto?

En el board de **Producción** (`prewave.oracle30x.co/produccion`) y en el de **Diseño**
(`prewave.oracle30x.co/diseno`), los carruseles que traen un **referente de Instagram o TikTok**
tienen un botón **"Generar 30x"**. Al apretarlo, una IA baja ese carrusel de referencia, lo reconstruye con el
formato 30x y te deja un **borrador en Canva** listo para que lo ajustes y lo apruebes.

> Desde Producción es el camino **preferido**: ese carrusel ya sabe de qué avatar es (columna del avatar en
> el kanban), así que la IA carga su ADN directo. Desde Diseño (solicitudes viejas del webhook de Slack) la
> IA todavía tiene que inferir el avatar por el programa — puede fallar si no lo reconoce.

**Importante:** la IA no genera sola en la nube. Corre un "**worker**" **en tu computadora**. Si tu worker no está
prendido, el trabajo queda encolado esperando. Por eso esta guía: dejar tu worker listo y prendido.

---

## PARTE 1 · Setup (una sola vez, ~30 min)

> **Antes de empezar, asegurate de tener:** una cuenta con **plan de Claude** · acceso a la cuenta de
> **Canva de 30x** · una cuenta de **Instagram** · y **Git** y **Python** instalados (gratis:
> [git-scm.com](https://git-scm.com) · [python.org](https://python.org)).
> Sin Git no podés clonar el repo; sin Python el worker falla a mitad.

### 1. Instalar Claude Code
Necesitás Claude Code y una cuenta/plan de Claude. Descarga e instrucciones: **https://claude.com/code**
> Si te trabás acá, pedí ayuda a Mateo/IT — es el paso más técnico.

### 2. Conectar Canva (cuenta de 30x)
En Claude, conectá el **conector de Canva** e iniciá sesión con la **cuenta de Canva de 30x**
(la misma donde están las plantillas). Sin esto, la IA no puede crear ni editar diseños.
> ⚠️ Este login **caduca cada ~90 días**. Si un día falla, volvé a conectarlo (ver Problemas comunes).

### 3. Instalar el navegador (Playwright) y loguearte en Instagram
La IA necesita un navegador propio para bajar las slides del referente.
- Instalá el **MCP de Playwright** en Claude *(comando típico: `claude mcp add playwright npx @playwright/mcp@latest` — confirmá con Mateo/IT)*.
- **Abrí ese navegador una vez e iniciá sesión en Instagram.** La sesión queda guardada.
> ⚠️ Si no estás logueada en IG, las descargas fallan (Instagram bloquea a los no logueados).

### 4. Clonar el repo del pipeline
Ahí viven las plantillas, la lógica y los scripts. Abrí una terminal, ubicate donde quieras guardarlo y corré:

```
git clone https://github.com/fckyeslol/30x-carousel-pipeline.git
```
> Más adelante, para traer actualizaciones: `git pull` dentro de esa carpeta.

### 5. Acceso a la cola — con TU usuario de Prewave
Entrás con **tu mismo usuario del board**. No hay claves compartidas: tu worker solo verá **tus** trabajos.

En la terminal, dentro de la carpeta `30x-carousel-pipeline`, corré:

```
python scripts/login.py
```

Te va a pedir tu email y tu contraseña de Prewave. **La contraseña no se ve mientras la escribís** — es a
propósito: escribí a ciegas y dale enter. Listo, no hay que copiar ni pegar nada más.

> 🔐 **Corré este comando vos, en tu terminal — no se lo pidas a Claude.** Así tu contraseña no queda escrita
> en el chat ni en el historial de la terminal. (Aunque se lo pidas, Claude no puede: su terminal no es
> interactiva y no podría escribirla.)
>
> Tu token queda guardado en el archivo `.prewave-token`, que **git ignora** — no se sube a ningún lado.
> **Dura 30 días**: cuando la cola empiece a dar 401, volvés a correr lo mismo.
>
> ⚠️ Si te dice **"tu cuenta entra con Google, no tiene contraseña"**: avisale a Mateo.

**Todo lo demás se lo podés pedir a Claude Code.** Una vez que este comando te dijo "OK", abrí Claude Code
en esa carpeta y pedile que prenda tu worker (Parte 2).

---

## PARTE 2 · Prender tu worker (cada vez que vas a trabajar)

1. Abrí **Claude Code** dentro de la carpeta `30x-carousel-pipeline`.
2. Pegá esto y dale enter (toma tu token solo, del paso 5):

```
/loop 20m Worker de carruseles 30x: usá scripts/queue_client.py (toma mi token solo)
para listar los jobs pendientes: esa cola YA viene acotada a MIS trabajos.
Si no hay pendientes, no hagas nada. Por cada job pendiente: PATCH status=processing;
construí el carrusel siguiendo AGENT.md — la REFERENCIA es el molde (bajá sus slides y leé
su estructura) y el ADN del avatar es la máquina (tipografía, paleta, voz); esculpí sobre el
lienzo del avatar, en español, SIN inventar datos ni cifras, y commiteá la transacción;
cerrá con PATCH {status:"done", resultUrl:"<link de Canva>"} o
{status:"failed", error:"<motivo>"} si falla.
```

3. Listo: tu worker revisa la cola **cada 20 minutos** y genera lo que haya.
   - **Mientras esa ventana esté abierta**, el worker vive. Si la cerrás, se apaga.
   - Si preferís no dejarlo prendido, podés pegar el mismo texto **sin** el `/loop 20m` para que procese la cola una sola vez, cuando vos quieras.

---

## PARTE 3 · El flujo de trabajo

1. En **`/produccion`** (preferido) o en **`/diseno`**, un carrusel con referente muestra el botón **"Generar 30x"**.
2. Alguien lo aprieta → el trabajo se **encola**.
3. Tu worker lo toma (en el próximo ciclo) → la tarjeta pasa a **"generando"**.
4. Cuando termina, en la tarjeta aparece **"Ver 30x"** con el link del borrador en Canva.
5. **Vos abrís el Canva, ajustás lo que haga falta, y aprobás.** La IA hace el borrador; vos decidís.

**Qué hace la IA (y qué no):** transpone el contenido del referente al formato 30x, en español, **sin inventar
datos ni cifras**. No decide por vos: siempre queda un borrador para tu revisión.

---

## Problemas comunes

| Síntoma | Qué pasa / qué hacer |
|---|---|
| Aprieto "Generar 30x" y no pasa nada | **No hay ningún worker prendido.** Prendé el tuyo (Parte 2) |
| La cola me da **401** | Tu token venció (dura 30 días). Corré `python scripts/login.py` otra vez |
| Veo trabajos que no son míos | No debería pasar: la cola ya viene acotada a los tuyos. Avisá |
| Canva da error / pide login | El conector caducó (pasa cada ~90 días). Reconectá Canva con la cuenta 30x |
| No baja el referente de Instagram | Tu navegador de Playwright no está logueado en IG. Abrilo e iniciá sesión |
| El job quedó en **"failed"** | Mirá el motivo en el error. Suele ser: referencia que no es carrusel, o alguno de los dos puntos de arriba |
| El diseño salió con la marca equivocada | Todavía no están cargadas las plantillas por avatar (ver Límites) |

---

## Límites actuales (para que no te sorprendan)

- **Solo Cinthya y Guillermo tienen ADN cargado.** Un job de otro avatar queda en la cola sin procesar.
- **Los fondos de los lienzos todavía están en blanco** (falta pintarlos de `#F6F5F0` una vez).
- **Referencias tipográficas sí, infografías no.** El lienzo solo tiene bloques de texto: un referente que
  sea una grilla de recuadros, tablas o calendarios **no se puede replicar**.
- **No es 100% automático:** requiere tu worker prendido, y re-conectar Canva cada ~90 días.
- **Referentes muy elaborados** (gráficos, timelines, ilustraciones) no se reproducen tal cual: la IA transpone
  el **contenido**, no los gráficos personalizados.

---

## Ayuda

Cualquier duda o si algo falla: **Mateo**. Si el problema es de la solicitud/board, es Prewave; si es del
borrador en Canva, es el molde/plantilla.
