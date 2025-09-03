FROM node:18-bullseye

WORKDIR /app

COPY package*.json ./

# Installer dépendances système et npm modules
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    curl \
    unzip \
    build-essential \
    python3 \
    g++ \
    git \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

RUN npm install --production --unsafe-perm

COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 8080

CMD ["node", "index.js"]
