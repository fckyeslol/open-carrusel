# Open Carrusel — imagen del modo hosteado.
# Un solo contenedor con: Next.js (build de producción), Claude CLI (el
# subproceso agéntico), Chromium/Puppeteer (render de láminas) y Python 3
# (los snippets de API que corre el agente).
FROM node:20-bookworm-slim

# Dependencias de sistema:
#  - chromium libs: lo que el Chrome que baja Puppeteer necesita para arrancar
#  - fuentes: render fiel de láminas (Noto cubre acentos/emoji)
#  - python3: el agente usa urllib para TODAS las llamadas a la API
#  - git + ca-certificates + curl: utilitarios básicos del agente
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 \
    fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
    libdrm2 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxkbcommon0 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Claude CLI global: el mismo binario para todos los spawns; cada spawn se
# autentica con el CLAUDE_CODE_OAUTH_TOKEN de la usuaria (inyectado por env).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV CLAUDE_CLI_PATH=/usr/local/bin/claude

EXPOSE 3000

# Shell-form para honrar $PORT: Cloud Run inyecta PORT=8080 (y lo espera); en
# compose/VM queda en 3000. El loopback del subproceso usa el mismo process.env.PORT.
# -H 0.0.0.0: en Cloud Run lo alcanza el Load Balancer; en compose, Caddy.
#
# Antes de arrancar sembramos los presets desde los ADN commiteados
# (30x/avatars/<slug>/adn.json → data/style-presets.json). Va en el CMD, no en el
# build, porque `data/` es un volumen montado en runtime: generarlo en build queda
# tapado por el mount vacío del host. El script es idempotente (upsert por id) y no
# usa red, así que re-correrlo en cada arranque solo refresca los avatares sin pisar
# ediciones. `|| true`: si el sembrado falla, igual levantamos el server.
CMD ["sh", "-c", "node scripts/import-avatars.mjs || true; npx next start -H 0.0.0.0 -p ${PORT:-3000}"]
