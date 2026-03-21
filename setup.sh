#!/bin/bash
# Favor — One-Command Setup
# Clone the repo and run: bash setup.sh
# It handles everything — installs, config, and launches your bot.

set -e

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║         FAVOR — Setup Script          ║"
echo "  ║      Your AI WhatsApp Companion       ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ─── Install Node.js if missing ───
if ! command -v node &> /dev/null; then
    echo "[*] Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt install -y nodejs > /dev/null 2>&1
    echo "[✓] Node.js installed"
else
    echo "[✓] Node.js $(node -v)"
fi

# ─── Install build tools if missing ───
if ! command -v make &> /dev/null; then
    echo "[*] Installing build tools..."
    apt install -y build-essential python3 > /dev/null 2>&1
    echo "[✓] Build tools installed"
else
    echo "[✓] Build tools"
fi

# ─── Install pm2 if missing ───
if ! command -v pm2 &> /dev/null; then
    echo "[*] Installing pm2..."
    npm install -g pm2 > /dev/null 2>&1
    echo "[✓] pm2 installed"
else
    echo "[✓] pm2 $(pm2 -v 2>/dev/null)"
fi

# ─── Install npm dependencies ───
echo "[*] Installing dependencies..."
npm install --silent 2>&1 | tail -1
echo "[✓] Dependencies installed"

# ─── Create directories ───
mkdir -p data auth-state
echo "[✓] Directories created"

# ─── Copy knowledge templates ───
KNOWLEDGE_DIR="./knowledge"
for f in "$KNOWLEDGE_DIR"/*.example.md; do
    base=$(basename "$f" .example.md)
    target="$KNOWLEDGE_DIR/$base.md"
    [ ! -f "$target" ] && cp "$f" "$target"
done
echo "[✓] Knowledge files ready"

# ═══════════════════════════════════════════
#  INTERACTIVE CONFIG — no manual editing!
# ═══════════════════════════════════════════

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │         Let's set up your bot!                  │"
echo "  │     Answer a few questions and you're done.     │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# ─── Bot name ───
read -p "  What do you want to name your bot? (default: Favor): " BOT_NAME
BOT_NAME="${BOT_NAME:-Favor}"

# ─── Phone number ───
echo ""
echo "  Your WhatsApp number (with country code, e.g. +13055551234)"
read -p "  Phone number: " PHONE_NUMBER
if [ -z "$PHONE_NUMBER" ]; then
    echo "  [!] Phone number is required. You can edit config.json later."
    PHONE_NUMBER="+1XXXXXXXXXX"
fi

# ─── OpenAI API key ───
echo ""
echo "  Get your API key from: https://platform.openai.com/api-keys"
read -p "  OpenAI API key: " OPENAI_KEY
if [ -z "$OPENAI_KEY" ]; then
    echo "  [!] OpenAI key is required for the bot to work."
    echo "  [!] You can add it later: nano config.json"
    OPENAI_KEY="YOUR_OPENAI_API_KEY"
fi

# ─── Gemini API key (optional but recommended) ───
echo ""
echo "  (Optional) Get a free Gemini key from: https://aistudio.google.com/apikey"
read -p "  Gemini API key (press Enter to skip): " GEMINI_KEY
GEMINI_KEY="${GEMINI_KEY:-}"

# ─── Brave Search API key (optional) ───
echo ""
echo "  (Optional) Get a free Brave key from: https://brave.com/search/api/"
read -p "  Brave Search API key (press Enter to skip): " BRAVE_KEY
BRAVE_KEY="${BRAVE_KEY:-}"

# ─── Security phrase ───
echo ""
echo "  Pick a secret word — say this to your bot to prove you're the owner."
read -p "  Security phrase (default: changeme): " SEC_PHRASE
SEC_PHRASE="${SEC_PHRASE:-changeme}"

# ─── Generate vault secret ───
VAULT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)

# ─── Write config.json ───
cat > config.json << CONFIGEOF
{
  "identity": {
    "name": "${BOT_NAME}",
    "tagline": "Always in your favor.",
    "personality": "companion",
    "tone": "friendly, helpful, direct"
  },
  "model": {
    "provider": "openai",
    "id": "gpt-4o",
    "maxTokens": 2048,
    "contextWindow": 128000
  },
  "fallbackModel": {
    "provider": "openai",
    "id": "gpt-4o-mini",
    "maxTokens": 2048
  },
  "api": {
    "anthropicBaseUrl": "https://api.anthropic.com",
    "openaiApiKey": "${OPENAI_KEY}",
    "geminiApiKey": "${GEMINI_KEY}",
    "braveApiKey": "${BRAVE_KEY}",
    "kimiApiKey": ""
  },
  "whatsapp": {
    "enabled": true,
    "dmPolicy": "allowlist",
    "operatorNumber": "${PHONE_NUMBER}",
    "securityPhrase": "${SEC_PHRASE}",
    "allowFrom": [
      "${PHONE_NUMBER}"
    ],
    "trustedContacts": [],
    "allowGroups": false,
    "selfChatMode": true,
    "mediaMaxMb": 50,
    "debounceMs": 0,
    "credentialsDir": "./auth-state"
  },
  "memory": {
    "backend": "sqlite",
    "dbPath": "./data/favor.db",
    "maxSessionHistory": 40,
    "contextPruning": {
      "enabled": true,
      "maxMessages": 30
    }
  },
  "compaction": {
    "model": "gemini-2.5-flash",
    "threshold": 30,
    "keepRecent": 12,
    "summaryTokens": 512
  },
  "vault": {
    "secret": "${VAULT_SECRET}"
  },
  "knowledge": {
    "dir": "./knowledge"
  },
  "laptop": {
    "enabled": false,
    "user": "your-username",
    "host": "your-laptop-ip",
    "port": 22,
    "connectTimeout": 5000,
    "execTimeout": 15000
  },
  "screenAwareness": {
    "enabled": false,
    "intervalMs": 180000,
    "lastContext": ""
  },
  "service": {
    "autoRestart": true,
    "maxRestartAttempts": 10,
    "restartDelayMs": 5000,
    "heartbeatIntervalMs": 1800000
  }
}
CONFIGEOF

echo ""
echo "[✓] config.json created for ${BOT_NAME}"

# ─── Set Gemini env var if provided ───
if [ -n "$GEMINI_KEY" ]; then
    if ! grep -q "GEMINI_API_KEY" ~/.bashrc 2>/dev/null; then
        echo "export GEMINI_API_KEY=\"${GEMINI_KEY}\"" >> ~/.bashrc
        export GEMINI_API_KEY="${GEMINI_KEY}"
        echo "[✓] GEMINI_API_KEY saved to environment"
    fi
fi

# ─── Claude Code check ───
echo ""
if command -v claude &> /dev/null; then
    echo "[✓] Claude Code found"
else
    echo "[i] Claude Code not installed (optional — adds coding/engineering ability)"
    echo "    Install later: curl -fsSL https://claude.ai/install.sh | sh"
fi

# ═══════════════════════════════════════════
#  LAUNCH
# ═══════════════════════════════════════════

echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║                 Setup Complete!                   ║"
echo "  ║                                                   ║"
echo "  ║  Your bot '${BOT_NAME}' is ready to launch.            "
echo "  ║                                                   ║"
echo "  ║  Starting now — a QR code will appear below.      ║"
echo "  ║                                                   ║"
echo "  ║  Open WhatsApp > Settings > Linked Devices        ║"
echo "  ║  > Link a Device > Scan the QR code               ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""

read -p "  Press Enter to start ${BOT_NAME}..." _

# First run — show QR code
node favor.js &
BOT_PID=$!

echo ""
echo "  Scan the QR code above with WhatsApp."
echo "  After scanning, press Enter to finish setup."
echo ""
read -p "  Press Enter after you've scanned the QR code..." _

# Kill the foreground process and set up pm2
kill $BOT_PID 2>/dev/null
sleep 2

BOT_PM2_NAME=$(echo "$BOT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
pm2 start favor.js --name "${BOT_PM2_NAME}" --restart-delay 20000
pm2 save
pm2 startup 2>/dev/null || true

echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║              ${BOT_NAME} is LIVE!                       "
echo "  ║                                                   ║"
echo "  ║  Send a message on WhatsApp and your bot          ║"
echo "  ║  will reply. It runs 24/7 automatically.          ║"
echo "  ║                                                   ║"
echo "  ║  Useful commands:                                 ║"
echo "  ║    pm2 logs ${BOT_PM2_NAME}          — see live logs      "
echo "  ║    pm2 restart ${BOT_PM2_NAME}       — restart bot        "
echo "  ║    pm2 stop ${BOT_PM2_NAME}          — stop bot           "
echo "  ║    nano config.json          — edit settings      ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""
