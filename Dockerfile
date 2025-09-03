# Dockerfile - Fly.io optimized for Node + Chromium
FROM node:18-slim

# Installer Chromium et dépendances nécessaires pour Puppeteer / wppconnect
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
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Définir le répertoire de travail
WORKDIR /app

# Copier les fichiers package.json / package-lock.json et installer les dépendances
COPY package*.json ./
RUN npm install --production

# Copier le reste de l'application
COPY . .

# Variable d'environnement pour Puppeteer / wppconnect
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Exposer le port de l'application
EXPOSE 8080

# Commande de démarrage
CMD ["node", "index.js"]
