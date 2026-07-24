# Conectar tu Claude — guía para diseñadoras

Ahora Open Carrusel vive en la web: no instalás nada, solo entrás con el
navegador. Una única vez tenés que "conectar tu Claude" para que puedas generar
carruseles. Son 5 minutos.

## 1. Entrá por primera vez

1. Abrí la dirección que te pasó Mateo (ej: `https://carruseles.30x.com`).
2. Poné tu **usuario** y la **contraseña temporal** que te llegó.
3. La app te va a pedir que cambies la contraseña por una tuya. Hacelo.

## 2. Sacá tu token de Claude

El "token" es una llave que le dice al sistema que use TU cuenta de Claude para
generar (así el gasto sale de tu seat del equipo, no de otro lado).

1. En tu compu, abrí una **terminal**:
   - **Windows**: buscá "PowerShell" en el menú inicio y abrilo.
   - **Mac**: buscá "Terminal" (Cmd + Espacio, escribí "Terminal").
2. Escribí este comando y apretá Enter:

   ```
   claude setup-token
   ```

3. Se te abre el navegador. Logueate con tu cuenta del **equipo** (la misma con
   la que usás Claude).
4. Cuando termine, la terminal te muestra una **llave larga** (empieza con letras
   y números). Copiala entera.

> ¿No tenés el comando `claude`? Instalá Claude Code primero (una vez):
> en la terminal pegá `npm install -g @anthropic-ai/claude-code` y volvé al paso 2.

## 3. Pegá el token en la web

1. En Open Carrusel, arriba, entrá a **Mi cuenta**.
2. En "Tu Claude", pegá la llave que copiaste.
3. Dale a **Conectar mi Claude**. Debe aparecer **Conectado** en verde.

¡Listo! Ya podés generar carruseles como siempre.

## Preguntas rápidas

**¿Tengo que hacer esto cada vez?** No. Una sola vez. La llave dura como un año.

**¿Es seguro pegar mi token ahí?** Sí. Se guarda cifrado y solo se usa para tus
generaciones. Nadie —ni Mateo— puede leerlo.

**Me dice "Todavía no conectaste tu Claude" al generar.** Te falta el paso 3, o
la llave venció. Volvé a "Mi cuenta" y pegá una llave nueva (repetí el paso 2).

**¿Se me cerró la sesión?** Volvé a entrar con tu usuario y contraseña. Tu Claude
sigue conectado, no hay que repetir el token.
