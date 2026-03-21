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
#  INTERACTIVE CONFIG
# ═══════════════════════════════════════════

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │         Let's set up your bot!                  │"
echo "  │     Answer a few questions and you're done.     │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# ─── Personal or Business? ───
echo "  What are you using this bot for?"
echo ""
echo "    1) Personal — just for me (only I can message it)"
echo "    2) Business — customers can message it too"
echo ""
read -p "  Enter 1 or 2 (default: 1): " USE_MODE
USE_MODE="${USE_MODE:-1}"

if [ "$USE_MODE" = "2" ]; then
    DM_POLICY="open"
    ALLOW_GROUPS=true
    PERSONALITY="business assistant"
    echo ""
    echo "  [✓] Business mode — anyone can message your bot"
else
    DM_POLICY="allowlist"
    ALLOW_GROUPS=false
    PERSONALITY="companion"
fi

# ─── Bot name ───
echo ""
if [ "$USE_MODE" = "2" ]; then
    read -p "  What's your business name? (this is your bot's name): " BOT_NAME
else
    read -p "  What do you want to name your bot? (default: Favor): " BOT_NAME
fi
BOT_NAME="${BOT_NAME:-Favor}"

# ─── Business info (if business mode) ───
BUSINESS_TAGLINE="Always in your favor."
if [ "$USE_MODE" = "2" ]; then
    echo ""
    read -p "  One-line description of your business: " BUSINESS_TAGLINE
    BUSINESS_TAGLINE="${BUSINESS_TAGLINE:-Always in your favor.}"

    echo ""
    echo "  What tone should your bot use with customers?"
    echo ""
    echo "    1) Professional — formal, polished"
    echo "    2) Friendly — warm, casual but professional"
    echo "    3) Fun — upbeat, uses personality"
    echo ""
    read -p "  Enter 1, 2, or 3 (default: 2): " TONE_CHOICE
    case "$TONE_CHOICE" in
        1) BOT_TONE="professional, polished, formal" ;;
        3) BOT_TONE="fun, upbeat, personable" ;;
        *) BOT_TONE="friendly, helpful, professional" ;;
    esac
else
    BOT_TONE="friendly, helpful, direct"
fi

# ─── Staff numbers (business mode) ───
STAFF_NUMBERS=""
STAFF_JSON="[]"
if [ "$USE_MODE" = "2" ]; then
    echo ""
    echo "  Add staff phone numbers — they get access to business tools"
    echo "  (memory, scheduling, messaging, etc.) but NOT server admin."
    echo "  Enter one per line. Press Enter on a blank line when done."
    echo ""
    STAFF_ARRAY=()
    while true; do
        read -p "  Staff number (or Enter to finish): " STAFF_NUM
        [ -z "$STAFF_NUM" ] && break
        STAFF_ARRAY+=("\"$STAFF_NUM\"")
    done
    if [ ${#STAFF_ARRAY[@]} -gt 0 ]; then
        STAFF_JSON="[$(IFS=,; echo "${STAFF_ARRAY[*]}")]"
        echo "  [✓] ${#STAFF_ARRAY[@]} staff member(s) added"
    else
        echo "  [i] No staff added — you can add them later in config.json"
    fi
fi

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
    "tagline": "${BUSINESS_TAGLINE}",
    "personality": "${PERSONALITY}",
    "tone": "${BOT_TONE}"
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
    "dmPolicy": "${DM_POLICY}",
    "operatorNumber": "${PHONE_NUMBER}",
    "securityPhrase": "${SEC_PHRASE}",
    "allowFrom": [
      "${PHONE_NUMBER}"
    ],
    "trustedContacts": [],
    "staff": ${STAFF_JSON},
    "allowGroups": ${ALLOW_GROUPS},
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

# ─── Create business knowledge file if business mode ───
if [ "$USE_MODE" = "2" ]; then
    echo ""
    echo "  Let's give your bot some business knowledge."
    echo "  (You can always add more later by editing knowledge files)"
    echo ""
    read -p "  What does your business do? (1-2 sentences): " BIZ_DESC
    read -p "  Business hours (e.g. Mon-Fri 9am-5pm): " BIZ_HOURS
    read -p "  Location or website: " BIZ_LOCATION
    read -p "  Key services/products (comma separated): " BIZ_SERVICES
    echo ""
    read -p "  Anything else customers should know? (press Enter to skip): " BIZ_EXTRA

    cat > knowledge/business.md << BIZEOF
# ${BOT_NAME}

${BUSINESS_TAGLINE}

## About
${BIZ_DESC:-A business using Favor AI.}

## Hours
${BIZ_HOURS:-Contact us for hours.}

## Location
${BIZ_LOCATION:-Contact us for location details.}

## Services / Products
${BIZ_SERVICES:-Contact us for details.}

${BIZ_EXTRA:+## Additional Info}
${BIZ_EXTRA:-}
BIZEOF

    echo "[✓] Business knowledge file created"
fi

# ─── Set Gemini env var if provided ───
if [ -n "$GEMINI_KEY" ]; then
    if ! grep -q "GEMINI_API_KEY" ~/.bashrc 2>/dev/null; then
        echo "export GEMINI_API_KEY=\"${GEMINI_KEY}\"" >> ~/.bashrc
        export GEMINI_API_KEY="${GEMINI_KEY}"
        echo "[✓] GEMINI_API_KEY saved to environment"
    fi
fi

# ─── Claude Code ───
echo ""
if command -v claude &> /dev/null; then
    echo "[✓] Claude Code already installed"
else
    echo "  Claude Code gives your bot engineering/coding abilities."
    echo "  Requires a Claude account ($20/mo Pro or $100/mo Max)."
    echo ""
    read -p "  Install Claude Code? (y/N): " INSTALL_CLAUDE
    if [ "$INSTALL_CLAUDE" = "y" ] || [ "$INSTALL_CLAUDE" = "Y" ]; then
        echo ""
        echo "  [*] Installing Claude Code..."
        curl -fsSL https://claude.ai/install.sh | sh 2>&1
        echo ""
        echo "  [*] Now log in to your Claude account:"
        echo ""
        claude login
        echo ""
        echo "  [✓] Claude Code installed and logged in"
    else
        echo "  [i] Skipped — bot works fine without it (coding tasks use GPT-4o instead)"
    fi
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
echo "  ║  Helper scripts:                                  ║"
echo "  ║    ./status.sh     — check bot health             ║"
echo "  ║    ./update.sh     — pull latest updates          ║"
echo "  ║    ./relink.sh     — re-scan WhatsApp QR code     ║"
echo "  ║                                                   ║"
echo "  ║  Or text your bot:                                ║"
echo "  ║    /status  /update  /help                        ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""

if [ "$USE_MODE" = "2" ]; then
    echo "  ┌─────────────────────────────────────────────────┐"
    echo "  │  BUSINESS TIP: Add more knowledge by creating   │"
    echo "  │  .md files in the knowledge/ folder:            │"
    echo "  │                                                 │"
    echo "  │    nano knowledge/pricing.md                    │"
    echo "  │    nano knowledge/faq.md                        │"
    echo "  │    nano knowledge/policies.md                   │"
    echo "  │                                                 │"
    echo "  │  Your bot reads these automatically.            │"
    echo "  └─────────────────────────────────────────────────┘"
    echo ""
fi
