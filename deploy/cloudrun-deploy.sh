#!/usr/bin/env bash
# Deploya una imagen ya construida a Cloud Run con la config correcta para esta
# app stateful. Lo usa GitHub Actions y también sirve para deploy manual.
#
#   IMAGE=us-east1-docker.pkg.dev/PROJ/open-carrusel/app:abc123 bash deploy/cloudrun-deploy.sh
#
# Config vía env vars (CI las pasa; en local se leen de deploy/gcp.env si existe).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/gcp.env ] && source deploy/gcp.env

: "${IMAGE:?Falta IMAGE (la imagen a deployar)}"
: "${PROJECT_ID:?Falta PROJECT_ID}"
: "${REGION:?Falta REGION}"
: "${SERVICE:?Falta SERVICE}"
: "${APP_DOMAIN:?Falta APP_DOMAIN}"
: "${BUCKET_DATA:?Falta BUCKET_DATA}"
: "${BUCKET_UPLOADS:?Falta BUCKET_UPLOADS}"
: "${RUNTIME_SA_EMAIL:?Falta RUNTIME_SA_EMAIL}"

# ⚠ min=max=1 es OBLIGATORIO, no un tuning: la 'DB' son archivos JSON con lock
# por proceso. 2+ instancias corromperían el store. No lo cambies sin migrar a
# una DB real primero.
#
# Secretos: AUTH_SECRET + INTERNAL_API_TOKEN siempre. El token central de Claude
# (que paga la cola/fallback) se inyecta solo si SHARED_CLAUDE_SECRET trae el
# nombre del secreto (ej. CLAUDE_TEAM_OAUTH_TOKEN) — así el CI no necesita permiso
# para leer secretos y el script sigue sirviendo para deploys sin token central.
SECRETS="AUTH_SECRET=AUTH_SECRET:latest,INTERNAL_API_TOKEN=INTERNAL_API_TOKEN:latest"
if [ -n "${SHARED_CLAUDE_SECRET:-}" ]; then
  SECRETS="${SECRETS},${SHARED_CLAUDE_SECRET}=${SHARED_CLAUDE_SECRET}:latest"
fi
# Cuentas de Claude ADICIONALES para el fallback por límite (ver claude-tokens.ts):
# seteá SHARED_CLAUDE_SECRET_2=CLAUDE_TEAM_OAUTH_TOKEN_2 (y _3, _4, _5) apuntando a
# secretos que existan en Secret Manager. Cada uno se monta como env con su mismo
# nombre, que es justo lo que escanea el pool de tokens.
for i in 2 3 4 5; do
  var="SHARED_CLAUDE_SECRET_${i}"
  name="${!var:-}"
  if [ -n "$name" ]; then
    SECRETS="${SECRETS},${name}=${name}:latest"
  fi
done
# Cookie de sesión de Instagram: sin ella el scraping del referente falla desde
# Cloud Run (IP de datacenter que IG trata como bot → solo baja el logo). Se monta
# solo si ADD_IG_SESSIONID=1 y el secreto IG_SESSIONID existe en Secret Manager,
# así el script sigue sirviendo para deploys sin la cookie. Ver docs/DEPLOY-HOSTEADO.md.
if [ "${ADD_IG_SESSIONID:-}" = "1" ]; then
  SECRETS="${SECRETS},IG_SESSIONID=IG_SESSIONID:latest"
fi
# Proxy residencial para el scraping: hace que la request salga por una IP de casa
# (la condición que IG no bloquea), sin cookie ni cuenta. Recomendado sobre la
# cookie. Se monta si ADD_IG_PROXY=1 y existe el secreto IG_PROXY (http://user:pass@host:port).
if [ "${ADD_IG_PROXY:-}" = "1" ]; then
  SECRETS="${SECRETS},IG_PROXY=IG_PROXY:latest"
fi
# Proxies ADICIONALES para el fallback por caída del proveedor (ver src/lib/ig-proxies.ts):
# poné ADD_IG_PROXY_2=1 (y _3, _4, _5) y creá el secreto IG_PROXY_2 en Secret Manager.
# Cada uno se monta como env con su mismo nombre, que es justo lo que escanea el pool.
# Existe porque un solo proveedor ya demostró ser punto único de falla (2026-07-28:
# Litport devolviendo 500 a todo CONNECT tumbó la ingesta del hosteado).
for i in 2 3 4 5; do
  var="ADD_IG_PROXY_${i}"
  if [ "${!var:-}" = "1" ]; then
    SECRETS="${SECRETS},IG_PROXY_${i}=IG_PROXY_${i}:latest"
  fi
done

ENV_VARS="HOSTED_MODE=1,DOMAIN=${APP_DOMAIN},CLAUDE_CLI_PATH=/usr/local/bin/claude,CLAUDE_CONFIG_BASE=/tmp/claude-config,AVATAR_ASSETS_DIR=/app/public/uploads/avatar-assets"

# Zona horaria del contenedor. Cloud Run arranca en UTC, y eso rompe lo único que
# depende de la hora LOCAL: la ventana nocturna del lote CSV (BATCH_NIGHT_HOUR, default
# 20). En UTC, "las 20:00" caen 15:00 en Colombia — justo en medio de la jornada, que es
# exactamente lo que el lote existe para evitar. Los timestamps guardados no cambian:
# se escriben con toISOString(), que es absoluto.
ENV_VARS="${ENV_VARS},TZ=${APP_TZ:-America/Bogota}"

# Hora de arranque del lote nocturno (0-23, hora local ya fijada por TZ). Opcional:
# la app usa 20:00 si no viene.
if [ -n "${BATCH_NIGHT_HOUR:-}" ]; then
  ENV_VARS="${ENV_VARS},BATCH_NIGHT_HOUR=${BATCH_NIGHT_HOUR}"
fi
# Cooldown de cuenta tras límite (opcional; default 300 min en la app).
if [ -n "${CLAUDE_TOKEN_COOLDOWN_MIN:-}" ]; then
  ENV_VARS="${ENV_VARS},CLAUDE_TOKEN_COOLDOWN_MIN=${CLAUDE_TOKEN_COOLDOWN_MIN}"
fi
# Cooldown de un proxy de Instagram tras caerse (opcional; default 30 min en la app).
if [ -n "${IG_PROXY_COOLDOWN_MIN:-}" ]; then
  ENV_VARS="${ENV_VARS},IG_PROXY_COOLDOWN_MIN=${IG_PROXY_COOLDOWN_MIN}"
fi
# Servicio de render: con esto seteado, Chrome NO se abre en esta instancia — el render
# sale por HTTP (ver src/lib/render.ts). Deployá el servicio PRIMERO (deploy/render-deploy.sh).
# Vaciarlo es el kill switch: vuelve al render en proceso sin revertir código.
if [ -n "${RENDER_SERVICE_URL:-}" ]; then
  ENV_VARS="${ENV_VARS},RENDER_SERVICE_URL=${RENDER_SERVICE_URL}"
fi
# Tamaño del carril de generación. Default 1 en la app: TODO lo pesado (chat, cola 30x,
# resize) pasa por un único carril serializado. Subilo solo si la instancia tiene aire.
if [ -n "${QUEUE_LANE_SIZE:-}" ]; then
  ENV_VARS="${ENV_VARS},QUEUE_LANE_SIZE=${QUEUE_LANE_SIZE}"
fi

# --concurrency=80: requests HTTP simultáneas por instancia. NO bajarlo para
#   "limitar generaciones": la generación pesada ya está capada aparte por el carril de
#   trabajos (src/lib/job-queue.ts, QUEUE_LANE_SIZE, default 1). Con max-instances=1,
#   un concurrency bajo estrangula el tráfico web liviano (chunks JS, polling, SSE)
#   y Cloud Run devuelve 429 "no available instance" hasta para el propio bundle,
#   dejando la app en "Cargando…". Estuvo en 4 y rompía el arranque de la página.
# --memory: sigue en 4Gi A PROPÓSITO en este deploy, aunque Chrome se haya ido al servicio
#   de render y el carril deje UNA generación a la vez.
#
#   Bajarlo a 2Gi es el paso siguiente, NO este: (1) hay que ver primero en las métricas
#   cuánto baja de verdad el uso, y (2) RENDER_SERVICE_URL es el kill switch — si el
#   servicio de render da problemas y se lo vacía, la app vuelve a abrir Chrome localmente,
#   y con 2Gi eso quedaría PEOR que antes del cambio. Un kill switch que empeora las cosas
#   no es un kill switch. Se baja con APP_MEMORY una vez que el render esté probado.
# --no-cpu-throttling: CPU siempre asignada — el subproceso de Claude (hasta
#   8 min) y el streaming SSE necesitan CPU fuera del ciclo request/response.
# --execution-environment gen2: requerido para montar volúmenes GCS.
# --ingress internal-and-cloud-load-balancing: solo el LB llega al servicio;
#   la URL run.app queda bloqueada. La auth real la hace la app (login).
gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$RUNTIME_SA_EMAIL" \
  --execution-environment=gen2 \
  --min-instances=1 --max-instances=1 \
  --concurrency=80 \
  --cpu=2 --memory="${APP_MEMORY:-4Gi}" --cpu-boost --no-cpu-throttling \
  --timeout=3600 \
  --ingress=internal-and-cloud-load-balancing \
  --allow-unauthenticated \
  --set-env-vars="$ENV_VARS" \
  --set-secrets="$SECRETS" \
  --add-volume="name=data,type=cloud-storage,bucket=${BUCKET_DATA}" \
  --add-volume-mount="volume=data,mount-path=/app/data" \
  --add-volume="name=uploads,type=cloud-storage,bucket=${BUCKET_UPLOADS}" \
  --add-volume-mount="volume=uploads,mount-path=/app/public/uploads"

echo "✓ Deploy hecho: $SERVICE ($REGION)"
