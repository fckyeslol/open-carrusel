#!/usr/bin/env bash
# HTTPS Load Balancer global delante de Cloud Run — el "nginx administrado":
# IP estática + certificado TLS gestionado por Google + redirección HTTP→HTTPS.
# Corré esto DESPUÉS del primer deploy del servicio (el NEG lo necesita).
#
#   bash deploy/gcp-loadbalancer.sh
#
# Al final imprime la IP para el record DNS. El certificado se aprovisiona solo
# cuando el DNS ya apunta a esa IP (puede tardar 15-60 min).
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/gcp.env

: "${PROJECT_ID:?}"; : "${REGION:?}"; : "${SERVICE:?}"; : "${APP_DOMAIN:?}"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "▶ IP estática global: $LB_IP_NAME"
gcloud compute addresses create "$LB_IP_NAME" --global 2>/dev/null || echo "  (ya existía)"

echo "▶ Serverless NEG → Cloud Run ($SERVICE)"
gcloud compute network-endpoint-groups create "$NEG_NAME" \
  --region="$REGION" --network-endpoint-type=serverless \
  --cloud-run-service="$SERVICE" 2>/dev/null || echo "  (ya existía)"

echo "▶ Backend service"
gcloud compute backend-services create "$BACKEND_NAME" \
  --global --load-balancing-scheme=EXTERNAL_MANAGED 2>/dev/null || echo "  (ya existía)"
gcloud compute backend-services add-backend "$BACKEND_NAME" \
  --global --network-endpoint-group="$NEG_NAME" \
  --network-endpoint-group-region="$REGION" 2>/dev/null || echo "  (backend ya agregado)"

echo "▶ Certificado gestionado para $APP_DOMAIN"
gcloud compute ssl-certificates create "$CERT_NAME" \
  --domains="$APP_DOMAIN" --global 2>/dev/null || echo "  (ya existía)"

echo "▶ URL map + proxy HTTPS + forwarding rule (443)"
gcloud compute url-maps create "$URLMAP_NAME" \
  --default-service="$BACKEND_NAME" 2>/dev/null || echo "  (ya existía)"
gcloud compute target-https-proxies create oc-https-proxy \
  --url-map="$URLMAP_NAME" --ssl-certificates="$CERT_NAME" 2>/dev/null || echo "  (ya existía)"
gcloud compute forwarding-rules create oc-https-fr \
  --global --target-https-proxy=oc-https-proxy --ports=443 \
  --address="$LB_IP_NAME" --load-balancing-scheme=EXTERNAL_MANAGED 2>/dev/null \
  || echo "  (ya existía)"

echo "▶ Redirección HTTP(80) → HTTPS"
gcloud compute url-maps import oc-redirect --global --quiet 2>/dev/null <<'YAML' || echo "  (ya existía)"
name: oc-redirect
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
YAML
gcloud compute target-http-proxies create oc-http-proxy \
  --url-map=oc-redirect 2>/dev/null || echo "  (ya existía)"
gcloud compute forwarding-rules create oc-http-fr \
  --global --target-http-proxy=oc-http-proxy --ports=80 \
  --address="$LB_IP_NAME" --load-balancing-scheme=EXTERNAL_MANAGED 2>/dev/null \
  || echo "  (ya existía)"

IP=$(gcloud compute addresses describe "$LB_IP_NAME" --global --format='value(address)')
cat <<EOF

✓ Load Balancer listo.

╔═══════════════════════════════════════════════════════════════╗
║  PASO DNS — creá este record donde administrás ${APP_DOMAIN}:
║
║     Tipo:   A
║     Nombre: ${APP_DOMAIN}
║     Valor:  ${IP}
║     TTL:    300
╚═══════════════════════════════════════════════════════════════╝

Cuando el DNS propague, Google emite el certificado TLS solo (15-60 min).
Verificá el estado con:
  gcloud compute ssl-certificates describe ${CERT_NAME} --global --format='value(managed.status)'
(pasa de PROVISIONING a ACTIVE cuando está listo)
EOF
