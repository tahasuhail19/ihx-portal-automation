FROM mcr.microsoft.com/playwright:v1.64.1-jammy

USER root

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DISPLAY=:99 \
    NOVNC_VERSION=1.5.0 \
    WEBSOCKIFY_VERSION=0.12.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      xvfb \
      fluxbox \
      x11vnc \
      python3 \
      python3-pip \
      python3-setuptools \
      ca-certificates \
      curl \
    && python3 -m pip install --no-cache-dir "websockify==${WEBSOCKIFY_VERSION}" \
    && curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
      | tar -xz -C /opt \
    && mv "/opt/noVNC-${NOVNC_VERSION}" /opt/noVNC \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY . .
RUN npm run build -w frontend

ENV HOST=0.0.0.0 \
    PORT=3001 \
    STATIC_DIR=/app/frontend/dist \
    NOVNC_WEB=/opt/noVNC \
    VIEWER_URL=http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=websockify \
    SESSION_TIMEOUT_MS=1800000

EXPOSE 3001 6080

CMD ["node", "backend/src/server.js"]
