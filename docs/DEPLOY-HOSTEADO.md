# Modo hosteado — deploy y operación

Un servidor central corre la app; cada diseñadora entra por navegador y conecta
**su** Claude (token de su seat del plan Team). El consumo de cada generación
sale de la cuota de la cuenta dueña del token — el server no necesita API key.

```
Diseñadora (navegador) ──HTTPS──▶ Caddy ──▶ Next.js (HOSTED_MODE=1)
                                              │ spawn claude con
                                              │ CLAUDE_CODE_OAUTH_TOKEN=<su token>
                                              ▼
                                       proceso claude (paga SU seat)
                                              │ Python/urllib + X-Internal-Token
                                              ▼
                                       API loopback (láminas, review, export)
```

## Requisitos

- VPS Linux con Docker + Docker Compose (2 GB RAM mínimo; Puppeteer + Claude CLI
  corren adentro). 4 GB recomendado si van a generar varias a la vez.
- Un dominio apuntando al VPS (registro A). Caddy emite el TLS solo.
- Cada diseñadora: un seat del plan Claude Team **con acceso a Claude Code**.

## Primer deploy

```bash
git clone https://github.com/Hainrixz/open-carrusel.git
cd open-carrusel

# Genera .env.hosted con secretos frescos y tu dominio (en un paso):
npm run hosted:setup -- carruseles.30x.com

# Levanta app + Caddy (TLS automático):
npm run hosted:up
```

Comandos de operación (todos envuelven docker compose):

| Comando | Qué hace |
|---|---|
| `npm run hosted:up` | Construye y levanta (o aplica cambios) |
| `npm run hosted:down` | Baja todo |
| `npm run hosted:logs` | Mira los logs de la app en vivo |
| `npm run users -- <cmd>` | Gestión de usuarias (ver abajo) — corre en el server host |

### Prueba go/no-go del token (hacela ANTES de invitar a nadie)

En tu compu corré `claude setup-token`, copiá el token, y en el server:

```bash
docker compose -f docker-compose.hosted.yml exec app \
  sh -c 'CLAUDE_CODE_OAUTH_TOKEN=PEGAR_TOKEN claude -p "Respondé solo: ok" --output-format text'
```

Si imprime `ok`, el modelo completo funciona. Si falla con error de auth,
revisá que el token esté completo y que la cuenta tenga acceso a Claude Code.

## Alta de diseñadoras

```bash
docker compose -f docker-compose.hosted.yml exec app \
  node scripts/users.mjs add valentina --nombre "Valentina"
```

Imprime una contraseña temporal. Pasásela por un canal seguro junto con la URL y
la [guía de conexión](GUIA-CONECTAR-CLAUDE.md). Al entrar, la app le pide
cambiar la contraseña; después en **Mi cuenta** (`/cuenta`) corre
`claude setup-token` en su compu y pega el token.

Otros comandos: `list`, `reset <usuaria>`, `remove <usuaria>`.

## Auto-update

El server se actualiza solo cuando pusheás a `main`:

```bash
chmod +x deploy/update.sh
crontab -e
# agregar:
*/5 * * * * /ruta/al/repo/deploy/update.sh >> /var/log/open-carrusel-update.log 2>&1
```

## La cola 30x (/agent-jobs)

Los jobs de la cola no tienen usuaria logueada. Para que corran en modo
hosteado, poné en `.env.hosted` un `CLAUDE_TEAM_OAUTH_TOKEN` (un
`claude setup-token` de la cuenta que deba pagar esas generaciones;
`CLAUDE_RUNNER_OAUTH_TOKEN` sigue funcionando como nombre legacy) y
reiniciá: `docker compose -f docker-compose.hosted.yml up -d`.

**Fallback por límite (varias cuentas).** Si una sola cuenta no aguanta el
volumen, configurá VARIAS: cuando una llega a su límite de uso el sistema la
pone en cooldown (~5h, `CLAUDE_TOKEN_COOLDOWN_MIN`) y rota a la siguiente sola,
tanto en la cola como en el editor. Formas de listarlas:

```
# varias en una línea (coma):
CLAUDE_TEAM_OAUTH_TOKEN=tok_cuentaA,tok_cuentaB
# o numeradas (una por variable):
CLAUDE_TEAM_OAUTH_TOKEN_1=tok_cuentaA
CLAUDE_TEAM_OAUTH_TOKEN_2=tok_cuentaB
```

En Cloud Run cada cuenta extra es un secreto en Secret Manager; apuntá
`SHARED_CLAUDE_SECRET_2=CLAUDE_TEAM_OAUTH_TOKEN_2` (variable de repo) al nombre
del secreto y el deploy lo monta solo (ver `deploy/cloudrun-deploy.sh`).

### Bajar el referente desde el server — OBLIGATORIO para la cola

El server baja el referente scrapeando Instagram. Desde una IP de datacenter
(Cloud Run) Instagram lo trata como bot y sirve un muro de login: el scraper
solo consigue el logo de IG y el job falla con "carrusel incompleto". Desde una
IP residencial (la compu de una diseñadora) el post baja completo sin login. Hay
dos formas de darle al server una salida "residencial":

**Opción A — Proxy residencial (RECOMENDADO).** La request sale por una IP de
casa: la condición exacta que ya funciona en local, sin cookie ni cuenta de IG
(no arriesga que IG trabe ninguna cuenta). Contratá un proveedor (Bright Data,
Oxylabs, IPRoyal, Smartproxy/Decodo, etc.) que te da una URL
`http://usuario:pass@host:puerto`. Bajamos solo el HTML/JSON del post (se
bloquean imágenes/CSS en la extracción) para gastar poca banda del proxy.

- **Docker (compose):** `IG_PROXY=http://user:pass@host:puerto` en `.env.hosted`.
- **Cloud Run:**
  ```bash
  printf '%s' 'http://user:pass@gate.proveedor.com:7000' | gcloud secrets create IG_PROXY --data-file=- --replication-policy=automatic
  bash deploy/gcp-setup.sh                        # da acceso al SA de runtime
  ADD_IG_PROXY=1 bash deploy/cloudrun-deploy.sh   # (o ADD_IG_PROXY=1 en deploy/gcp.env)
  ```

**Opción B — Cookie de sesión (`IG_SESSIONID`).** Alternativa sin proxy. Es el
valor de la cookie `sessionid` de una cuenta IG logueada (DevTools → Application
→ Cookies → instagram.com → `sessionid`). ⚠ Usá una cuenta **descartable**, no la
de la marca: IG puede trabar la cuenta al detectar el uso automatizado desde
datacenter. Vence cada tanto → si la ingesta vuelve a fallar, renovala.

- **Docker:** `IG_SESSIONID=<valor>` en `.env.hosted`.
- **Cloud Run:** `gcloud secrets create IG_SESSIONID …` + `bash deploy/gcp-setup.sh`
  + `ADD_IG_SESSIONID=1 bash deploy/cloudrun-deploy.sh`. Renovar:
  `gcloud secrets versions add IG_SESSIONID --data-file=-` y redeploy.

Se pueden combinar (proxy + cookie) para máxima robustez. Tras configurar,
**Reintentá** los jobs que habían fallado por referente incompleto.

## Seguridad — qué protege qué

| Pieza | Qué hace |
|---|---|
| `src/proxy.ts` | Exige sesión en TODA página y ruta API (menos login y assets de imagen) |
| Cookie `oc_session` | Firmada HMAC-SHA256, httpOnly, 30 días |
| Tokens de Claude | AES-256-GCM en reposo (`data/users.json`); solo se descifran al spawn |
| `X-Internal-Token` | Autentica al subproceso de Claude y scripts internos por loopback |
| Contraseñas | scrypt; rate limit de 10 intentos/min por IP en el login |

**Backups**: `data/`, `public/uploads/` y `30x/avatars/` son los volúmenes con
estado — respaldalos. `data/users.json` contiene los tokens cifrados: sin el
`AUTH_SECRET` no sirven, así que respaldá el `.env.hosted` por separado y en
otro lugar.

**Rotación**: si un token se filtra o una diseñadora deja el equipo, ella
regenera con `claude setup-token` (o se le borra la usuaria con `remove`). Si
se filtra `AUTH_SECRET`, generá uno nuevo — todas las sesiones caen y todas
tienen que volver a pegar su token.

## Migración de una diseñadora con repo local

1. Creale la usuaria (arriba) y pasale URL + contraseña temporal.
2. Ella entra, cambia contraseña, conecta su Claude.
3. Su repo local queda como respaldo; puede borrarlo cuando quiera. Los
   carruseles viejos que quiera conservar: exportarlos a PNG antes, o migrar
   `data/` al server a mano.

## Pendiente / límites conocidos

- **ToS**: `claude setup-token` está documentado oficialmente para entornos no
  interactivos (CI), pero el caso "backend que ejecuta en nombre del dueño del
  token" no está escrito explícitamente. Pedir confirmación a Anthropic.
- Los carruseles son un workspace **compartido** (como hoy): cualquier usuaria
  logueada ve todos los carruseles. Separar por usuaria es trabajo futuro.
- Sesiones de chat (`--resume`) viven en el volumen `claude-home`; si se borra,
  las conversaciones activas pierden contexto (los carruseles no se pierden).
