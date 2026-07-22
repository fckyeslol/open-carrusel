# 🎠 Cómo generar tus carruseles con IA (guía súper simple)

Tu computadora va a armar sola los carruseles que te asignan en Prewave. Vos solo los
**revisás** y los **entregás**. Esta guía te lleva de la mano, paso por paso. No hay que saber nada de programación. 💛

> Hay **dos partes**:
> - **Parte 1 — Instalar (UNA sola vez).** Es la parte técnica. **Lo ideal es que te la deje lista Mateo/IT.** Si la hacés vos, seguí los pasos tal cual.
> - **Parte 2 — Usar (todos los días).** Es un doble clic. Facilísimo.

---

## 📦 Lo que hay que tener (una vez)

1. **Google Chrome** → si no lo tenés: https://www.google.com/chrome (botón azul "Descargar").
2. **Node.js** (versión LTS) → https://nodejs.org → botón grande de la izquierda ("LTS"). Descargar y **Siguiente → Siguiente → Instalar**.
3. **Claude Code** (la IA que dibuja los carruseles) + tu cuenta de Claude → **Mateo te da la cuenta**. Instalación abajo (Parte 1, paso 2).
4. **Git** → https://git-scm.com/downloads → descargar e instalar (Siguiente → Siguiente). Sirve para que el programa **se actualice solo** con las mejoras de Mateo.
5. **La carpeta del proyecto** (`open-carrusel`) → **Mateo te la pasa** (o el link para bajarla). Guardala en un lugar fácil, por ejemplo el **Escritorio**.
6. **Tu token** (una clave larga) → **Mateo te la pasa**. Es como tu llave: solo vos ves tus carruseles.

---

## 🛠️ PARTE 1 · Instalar (una sola vez, ~20 min)

> 👉 Si Mateo ya te dejó la compu lista, **saltá a la Parte 2**.

### Paso 1 — Instalá Node y Chrome
Descargá e instalá los dos de la lista de arriba (1 y 2). Node es "Siguiente → Siguiente → Instalar".

### Paso 2 — Instalá Claude Code e iniciá sesión
1. Abrí **PowerShell** (botón Inicio → escribí `PowerShell` → Enter).
2. Copiá y pegá esto y dale Enter:
   ```
   npm install -g @anthropic-ai/claude-code
   ```
   Esperá a que termine (un par de minutos).
3. Ahora escribí y Enter:
   ```
   claude
   ```
   Se va a abrir para **iniciar sesión** — usá la **cuenta de Claude que te dio Mateo**. Cuando entres, escribí `/exit` y Enter para salir.

> 🆘 Si te trabás acá, es el paso más técnico: pedile ayuda a Mateo/IT. Es una sola vez.

### Paso 3 — Preparar la carpeta del proyecto
1. Abrí la carpeta `open-carrusel` que te pasó Mateo.
2. En la barra de arriba (donde dice la ruta), hacé clic, escribí `powershell` y Enter. Se abre una ventana negra **ya parada en esa carpeta**.
3. Copiá y pegá esto y Enter (tarda unos minutos, descarga cosas — es normal):
   ```
   npm run setup
   ```
   Cuando veas que dice algo como **"Ready"** y `http://localhost:3000`, ¡ya quedó instalado! Podés cerrar esa ventana.

### Paso 4 — Conectar las actualizaciones (una sola vez)
Esto hace que cada vez que abras el programa, **traiga solo** las mejoras de Mateo. Abrí PowerShell en la carpeta (como en el Paso 3), copiá y pegá esta línea y Enter:
```
git init -b main && git remote add origin https://github.com/fckyeslol/open-carrusel.git && git fetch origin main && git reset --hard origin/main
```
> 🔒 Tranquila: esto **no borra tus carruseles ni tus imágenes** (quedan a salvo). Solo pone el código al día.
> Si Mateo te pasó la carpeta ya conectada (clonada), saltá este paso.

### Paso 5 — Dejá el acceso directo a mano
En la carpeta vas a ver un archivo **`Abrir-Carruseles`**. Hacé **clic derecho → Enviar a → Escritorio (crear acceso directo)**. Así lo tenés siempre a un clic.

---

## ▶️ PARTE 2 · Usar (todos los días)

### 1. Doble clic en **`Abrir-Carruseles`** (el del Escritorio).
Se abre una ventana negra. **Dejala abierta** (es el motor). Primero **se pone al día solo** (verás "Buscando actualizaciones… ✅") y en ~10 segundos **se abre Chrome solo** en la página correcta.

> ✨ **No tenés que actualizar nada a mano.** Cada vez que abrís el programa, trae solas las mejoras de Mateo. Si no hay internet, igual abre con la versión que ya tenés.

### 2. Tu acceso ya viene puesto ✅
La carpeta que te pasó Mateo **ya trae tu acceso adentro** — no tenés que pegar ningún token.

> ¿Ves arriba a la derecha el botón **"Conectar Prewave"** pidiéndote un token? Solo en ese caso:
> pegá el token que te dio Mateo y apretá **Guardar** (queda guardado para siempre, no lo repetís).

### 3. ¡Listo! Tus carruseles se arman solos
- Aparecen agrupados por avenger (Cinthya, Guillermo, etc.).
- Cada uno pasa por: **En cola → Bajando → Generando → Renderizando → Listo para QA**.
- No toques nada; la compu trabaja sola.

### 4. Revisá y entregá
- Cuando uno diga **"Listo para QA"**, apretá **"Abrir para QA"**, mirá que esté bien (podés ajustarlo).
- Después **entregalo en Prewave** como siempre (subir el diseño en tu tablero). La app **no** entrega por vos: vos aprobás.

### Al terminar el día
Cerrá la ventana negra. Mañana: doble clic de nuevo. 🌙

---

## 🚦 ¿Algo se ve raro?

Abrí PowerShell en la carpeta (como en el Paso 3) y probá:

- **`npm run prewave:check`** → te dice si tu token funciona.
  - ✅ verde + un número = todo bien, tenés esos carruseles.
  - ❌ **401** = tu token venció (dura **30 días**) → pedile uno nuevo a Mateo.
- **`npm run doctor`** → revisa que Node, Chrome y todo esté OK.

| Lo que ves | Qué hacer |
|---|---|
| No se abre Chrome solo | Abrí Chrome y andá a `http://localhost:3000/30x` a mano |
| Dice "Conectá tu token" | Apretá "Conectar Prewave" y pegá tu token otra vez |
| Un carrusel quedó en **rojo** | Apretá **"Reintentar"**. Si sigue, avisá a Mateo |
| Cerré la ventana negra sin querer | Doble clic en `Abrir-Carruseles` otra vez |

---

## 🆘 Ayuda
Cualquier cosa que no salga: **escribile a Mateo**. Nada se rompe — siempre se puede reintentar. 💪
