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

ENV_VARS="HOSTED_MODE=1,DOMAIN=${APP_DOMAIN},CLAUDE_CLI_PATH=/usr/local/bin/claude,CLAUDE_CONFIG_BASE=/tmp/claude-config,AVATAR_ASSETS_DIR=/app/public/uploads/avatar-assets"
# Cooldown de cuenta tras límite (opcional; default 300 min en la app).
if [ -n "${CLAUDE_TOKEN_COOLDOWN_MIN:-}" ]; then
  ENV_VARS="${ENV_VARS},CLAUDE_TOKEN_COOLDOWN_MIN=${CLAUDE_TOKEN_COOLDOWN_MIN}"
fi

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
  --concurrency=4 \
  --cpu=2 --memory=4Gi --cpu-boost --no-cpu-throttling \
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
