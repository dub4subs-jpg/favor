FROM node:20-slim

# System deps for Puppeteer, ffmpeg, faster-whisper, edge-tts
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    git \
    tmux \
    openssh-client \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

# Python packages (faster-whisper for local transcription, edge-tts for voice)
RUN pip3 install --break-system-packages faster-whisper edge-tts 2>/dev/null || \
    pip3 install faster-whisper edge-tts

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create data directories
RUN mkdir -p data auth-state knowledge state

# Data persistence
VOLUME ["/app/data", "/app/auth-state", "/app/knowledge"]

# Notify API port
EXPOSE 3099

# Health check
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3099/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "favor.js"]
