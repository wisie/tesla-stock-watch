FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dumb-init \
    fluxbox \
    fonts-liberation \
    gnupg \
    locales \
    novnc \
    procps \
    xdotool \
    websockify \
    wget \
    x11vnc \
    xvfb \
  && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      install -m 0755 -d /etc/apt/keyrings \
      && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-linux.gpg \
      && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update \
      && apt-get install -y --no-install-recommends google-chrome-stable; \
    else \
      apt-get install -y --no-install-recommends chromium; \
    fi \
  && sed -i 's/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/' /etc/locale.gen \
  && locale-gen en_AU.UTF-8 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev
RUN chmod +x docker-entrypoint.sh scripts/vnc-warmup.sh

ENV NODE_ENV=production \
    PORT=3000 \
    DEPLOYMENT_MODE=docker \
    TESLA_DATA_DIR=/data/tesla-state \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    CHROME_USER_DATA_DIR=/data/chrome-profile \
    DISPLAY=:99 \
    LANG=en_AU.UTF-8 \
    LC_ALL=en_AU.UTF-8 \
    TZ=Australia/Melbourne

EXPOSE 3000 6080

ENTRYPOINT ["dumb-init", "--", "./docker-entrypoint.sh"]
