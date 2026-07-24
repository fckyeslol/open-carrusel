#!/usr/bin/env bash
# Auto-update del server hosteado: trae main y reconstruye solo si hay cambios.
# Programalo con cron (cada 5 min está bien — si no hay commits nuevos, no hace nada):
#   */5 * * * * /ruta/al/repo/deploy/update.sh >> /var/log/open-carrusel-update.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."

git fetch origin main

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "[$(date -Is)] Actualizando: $LOCAL → $REMOTE"
git merge --ff-only origin/main
docker compose -f docker-compose.hosted.yml up -d --build
echo "[$(date -Is)] Listo."
