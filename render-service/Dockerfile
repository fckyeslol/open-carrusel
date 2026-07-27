# Servicio de render de Open Carrusel — solo Chrome, sin dominio.
#
# ⚠️ El BUILD CONTEXT es la RAÍZ DEL REPO, no este directorio:
#     docker build -f render-service/Dockerfile .
# Es a propósito: así se copia src/lib/slide-render-contract.mjs desde su lugar real y
# no hay una segunda copia que se pueda desincronizar. Ese archivo es el único código
# que comparten la app y este servicio.
FROM node:20-bookworm-slim

# ⚠️ PARIDAD DE FUENTES — los paquetes de acá deben ser EXACTAMENTE los mismos que en
# el Dockerfile de la app (fonts-liberation, fonts-noto-core, fonts-noto-color-emoji).
#
# Las Google Fonts viajan inlineadas como base64 dentro del HTML del payload, pero los
# FALLBACKS del sistema no viajan. Si esta imagen tuviera otras fuentes, los exports se
# verían distintos del preview y el bug aparecería recién en producción, en láminas ya
# entregadas. El test scripts/render-parity.mjs compara local vs remoto byte a byte
# justamente para cazar esto.
#
# El resto son las libs que necesita el Chrome que baja Puppeteer. No hace falta python3,
# git ni el Claude CLI: este servicio no corre agentes.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
    libdrm2 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxkbcommon0 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY render-service/package.json ./
# Sin lockfile propio a propósito: las versiones están pineadas por rango y la paridad
# real la verifica el test, no el lock. `npm install` baja además el Chromium de Puppeteer.
RUN npm install --omit=dev

COPY render-service/server.mjs ./
# El contrato del seam y el script de "sin fondo", desde su ubicación real en el repo — no
# copias. slide-render-contract.mjs re-exporta strip-slide-background.mjs, así que los DOS
# tienen que estar, y planos en el mismo directorio para que el import relativo resuelva.
COPY src/lib/slide-render-contract.mjs src/lib/strip-slide-background.mjs ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.mjs"]
