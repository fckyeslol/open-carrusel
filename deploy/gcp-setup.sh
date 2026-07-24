#!/usr/bin/env bash
# Infra base de GCP para Open Carrusel — se corre UNA vez (idempotente en su
# mayoría; los "already exists" son inofensivos). Crea:
#   - Artifact Registry (imágenes)
#   - Buckets GCS de estado (data + uploads)
#   - Secret Manager (AUTH_SECRET, INTERNAL_API_TOKEN) con valores generados
#   - Service account de runtime (con acceso a los buckets y secretos)
#   - Workload Identity Federation + service account de CI (para GitHub Actions,
#     sin llaves JSON de larga vida)
#
# Uso:
#   cp deploy/gcp.env.example deploy/gcp.env   # y completar
#   bash deploy/gcp-setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."
source deploy/gcp.env

: "${PROJECT_ID:?Falta PROJECT_ID en deploy/gcp.env}"
: "${GITHUB_REPO:?Falta GITHUB_REPO en deploy/gcp.env}"

echo "▶ Proyecto: $PROJECT_ID | Región: $REGION"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "▶ Habilitando APIs…"
gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com compute.googleapis.com \
  iamcredentials.googleapis.com

echo "▶ Artifact Registry: $AR_REPO"
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker --location="$REGION" \
  --description="Open Carrusel images" 2>/dev/null || echo "  (ya existía)"

echo "▶ Buckets GCS de estado"
for b in "$BUCKET_DATA" "$BUCKET_UPLOADS"; do
  gcloud storage buckets create "gs://$b" --location="$REGION" \
    --uniform-bucket-level-access 2>/dev/null || echo "  (gs://$b ya existía)"
done

echo "▶ Secretos (AUTH_SECRET, INTERNAL_API_TOKEN)"
gen() { node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"; }
create_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    echo "  ($name ya existía — no lo piso)"
  else
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic
    echo "  ✓ $name creado"
  fi
}
create_secret AUTH_SECRET "$(gen)"
create_secret INTERNAL_API_TOKEN "$(gen)"
# Opcional: token de worker para la cola 30x. Descomentá y pegá un setup-token:
# create_secret CLAUDE_RUNNER_OAUTH_TOKEN "PEGAR_TOKEN"

echo "▶ Service account de runtime: $RUNTIME_SA"
RUNTIME_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts create "$RUNTIME_SA" \
  --display-name="Open Carrusel runtime" 2>/dev/null || echo "  (ya existía)"
# Lectura/escritura en los buckets de estado.
for b in "$BUCKET_DATA" "$BUCKET_UPLOADS"; do
  gcloud storage buckets add-iam-policy-binding "gs://$b" \
    --member="serviceAccount:${RUNTIME_EMAIL}" --role=roles/storage.objectAdmin >/dev/null
done
# Acceso a los secretos.
for s in AUTH_SECRET INTERNAL_API_TOKEN; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${RUNTIME_EMAIL}" --role=roles/secretmanager.secretAccessor >/dev/null
done

echo "▶ Service account de CI: $CI_SA"
CI_EMAIL="${CI_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts create "$CI_SA" \
  --display-name="Open Carrusel CI (GitHub Actions)" 2>/dev/null || echo "  (ya existía)"
# Permisos para construir imagen y deployar.
for role in roles/run.admin roles/artifactregistry.writer roles/cloudbuild.builds.editor \
            roles/storage.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${CI_EMAIL}" --role="$role" >/dev/null
done

echo "▶ Workload Identity Federation (GitHub → CI SA, sin llaves)"
POOL=github
PROVIDER=github-provider
gcloud iam workload-identity-pools create "$POOL" --location=global \
  --display-name="GitHub Actions" 2>/dev/null || echo "  (pool ya existía)"
POOL_ID=$(gcloud iam workload-identity-pools describe "$POOL" --location=global --format='value(name)')
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${GITHUB_REPO}'" 2>/dev/null \
  || echo "  (provider ya existía)"
# Solo el repo indicado puede impersonar la CI SA.
gcloud iam service-accounts add-iam-policy-binding "$CI_EMAIL" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${GITHUB_REPO}" >/dev/null

PROVIDER_RESOURCE="${POOL_ID}/providers/${PROVIDER}"

cat <<EOF

✓ Infra base lista.

Cargá estos valores en GitHub → Settings → Secrets and variables → Actions:

  Variables (Variables tab):
    GCP_PROJECT_ID   = ${PROJECT_ID}
    GCP_REGION       = ${REGION}
    CLOUD_RUN_SERVICE= ${SERVICE}
    AR_REPO          = ${AR_REPO}
    APP_DOMAIN       = ${APP_DOMAIN}
    BUCKET_DATA      = ${BUCKET_DATA}
    BUCKET_UPLOADS   = ${BUCKET_UPLOADS}
    RUNTIME_SA_EMAIL = ${RUNTIME_EMAIL}

  Secrets (Secrets tab):
    WIF_PROVIDER     = ${PROVIDER_RESOURCE}
    CI_SERVICE_ACCOUNT = ${CI_EMAIL}

Siguiente: hacé el primer deploy (push a main o corré deploy/cloudrun-deploy.sh),
y después bash deploy/gcp-loadbalancer.sh para el LB + DNS.
EOF
