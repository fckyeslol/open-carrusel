#!/usr/bin/env bash
# Deploya el SERVICIO DE RENDER a Cloud Run. Chrome vive acá y no en la instancia de
# la app, que está pineada a min=max=1 y comparte sus 4Gi con Node y un subproceso Claude.
#
#   IMAGE=us-east1-docker.pkg.dev/PROJ/open-carrusel/render:abc123 bash deploy/render-deploy.sh
#
# ⚠ ORDEN DE DEPLOY: este servicio va ANTES que la app. La app nueva lo necesita (lee
# RENDER_SERVICE_URL); la app vieja simplemente lo ignora. Al revés habría una ventana en
# la que la app apunta a un servicio que todavía no existe.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/gcp.env ] && source deploy/gcp.env

: "${IMAGE:?Falta IMAGE (la imagen a deployar)}"
: "${PROJECT_ID:?Falta PROJECT_ID}"
: "${REGION:?Falta REGION}"
: "${RUNTIME_SA_EMAIL:?Falta RUNTIME_SA_EMAIL}"
RENDER_SERVICE="${RENDER_SERVICE:-open-carrusel-render}"

# Por qué esta config, parámetro por parámetro:
#
# --concurrency=1: UNA request de render por instancia. Es el corazón del diseño: hace que
#   Cloud Run sea el semáforo de Chrome, así que del lado hosteado no hace falta
#   BROWSER_MAX_PAGES, ni reaper por inactividad, ni reciclado cada N páginas. Un render a
#   2160×2700 quiere la instancia entera.
#
# --min-instances=0: escala a cero cuando nadie genera. El cold start (~5-10s, la imagen
#   trae Chrome) lo paga solo el primer render de una ráfaga, y se puede evitar del todo
#   con el ping a /warmup que la app hace al reclamar un job. Contra 30-70 renders por
#   carrusel de 20-40 minutos, es ruido.
#
# --max-instances=3: la app ya serializa las generaciones en un solo carril, así que un
#   render a la vez es lo normal. El margen es para lo que NO pasa por el carril: el
#   re-export al aprobar un pedido y las descargas por lámina desde el editor.
#
# --memory=2Gi --cpu=1: un Chrome renderizando una lámina entra cómodo. Si aparecieran
#   OOM, subir memoria acá es barato y NO le toca nada a la app.
#
# --no-allow-unauthenticated: auth por IAM. La app manda un ID token de su service
#   account y Cloud Run lo valida ANTES de que la request llegue al contenedor. Es más
#   fuerte que un secreto compartido: el token es de corta duración y se revoca quitando
#   el rol, sin rotar nada.
#
#   ⚠ Ojo con la alternativa que parece más simple: `--ingress=internal` NO alcanza acá.
#   Una Cloud Run llamando a otra por su URL pública no cuenta como tráfico interno salvo
#   que salga por un VPC connector con --vpc-egress=all-traffic, y la app no tiene VPC
#   configurada. Con ingress=internal y sin VPC, las llamadas de la app se rechazarían.
#   Por eso: ingress abierto + IAM. X-Internal-Token queda igual como segunda barrera.
#
# --timeout=120: un render tarda segundos. Un timeout corto hace que un Chrome colgado se
#   corte solo en vez de retener la instancia.
gcloud run deploy "$RENDER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$RUNTIME_SA_EMAIL" \
  --execution-environment=gen2 \
  --min-instances=0 --max-instances=3 \
  --concurrency=1 \
  --cpu=1 --memory=2Gi --cpu-boost \
  --timeout=120 \
  --no-allow-unauthenticated \
  --set-secrets="INTERNAL_API_TOKEN=INTERNAL_API_TOKEN:latest"

# La app se autentica como invoker. Sin esto, todas sus requests dan 403.
gcloud run services add-iam-policy-binding "$RENDER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/run.invoker" \
  --quiet

URL="$(gcloud run services describe "$RENDER_SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"

echo "✓ Servicio de render deployado: $RENDER_SERVICE ($REGION)"
echo "  URL: $URL"
echo
echo "Para que la app lo use, seteá RENDER_SERVICE_URL en su deploy:"
echo "  RENDER_SERVICE_URL=$URL bash deploy/cloudrun-deploy.sh"
echo
echo "Verificá la paridad de fuentes ANTES de mandar tráfico real:"
echo "  RENDER_SERVICE_URL=$URL node scripts/render-parity.mjs"
