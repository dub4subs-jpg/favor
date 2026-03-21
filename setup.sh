#!/bin/bash
# Favor — One-Command Setup
# Clone the repo and run: bash setup.sh
# Smart installer — scans your system, avoids conflicts, suggests features.

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║         FAVOR — Setup Script          ║"
echo "  ║      Your AI WhatsApp Companion       ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════════
#  SYSTEM SCAN — detect what's already here
# ═══════════════════════════════════════════

echo "  Scanning your system..."
echo ""

ISSUES=()

# ─── Node.js ───
if command -v node &> /dev/null; then
    NODE_VER=$(node -v | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 18 ]; then
        echo "  [✓] Node.js v${NODE_VER}"
    else
        echo "  [!] Node.js v${NODE_VER} found (need v18+, will upgrade)"
        ISSUES+=("node_old")
    fi
else
    echo "  [ ] Node.js — not installed"
    ISSUES+=("node_missing")
fi

# ─── npm ───
if command -v npm &> /dev/null; then
    echo "  [✓] npm $(npm -v 2>/dev/null)"
else
    echo "  [ ] npm — not installed"
fi

# ─── pm2 ───
if command -v pm2 &> /dev/null; then
    PM2_PROCS=$(pm2 jlist 2>/dev/null | node -e "
      try { const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.length); } catch(e) { console.log(0); }
    " 2>/dev/null || echo "0")
    echo "  [✓] pm2 v$(pm2 -v 2>/dev/null) (${PM2_PROCS} process(es) running)"
    # Check for existing favor/whatsapp bot
    EXISTING_BOT=$(pm2 jlist 2>/dev/null | node -e "
      try { const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); const p=d.find(p=>p.pm2_env.pm_exec_path.includes('favor')); if(p) console.log(p.name); } catch(e) {}
    " 2>/dev/null || echo "")
    if [ -n "$EXISTING_BOT" ]; then
        echo "  [!] Existing Favor bot found: '${EXISTING_BOT}'"
        ISSUES+=("existing_bot")
    fi
else
    echo "  [ ] pm2 — not installed"
    ISSUES+=("pm2_missing")
fi

# ─── Build tools ───
if command -v make &> /dev/null && command -v g++ &> /dev/null; then
    echo "  [✓] Build tools (make, g++)"
else
    echo "  [ ] Build tools — not installed"
    ISSUES+=("build_missing")
fi

# ─── Claude Code ───
if command -v claude &> /dev/null; then
    CLAUDE_VER=$(claude --version 2>/dev/null || echo "installed")
    echo "  [✓] Claude Code (${CLAUDE_VER})"
    HAS_CLAUDE=true
else
    echo "  [ ] Claude Code — not installed (optional)"
    HAS_CLAUDE=false
fi

# ─── Existing config ───
if [ -f "config.json" ]; then
    echo "  [!] config.json already exists"
    ISSUES+=("existing_config")
fi

# ─── Disk space ───
DISK_AVAIL=$(df -BG / | awk 'NR==2{print $4}' | tr -d 'G')
if [ "$DISK_AVAIL" -lt 2 ]; then
    echo "  [!] Low disk space: ${DISK_AVAIL}GB available (need 2GB+)"
    ISSUES+=("low_disk")
else
    echo "  [✓] Disk: ${DISK_AVAIL}GB available"
fi

# ─── RAM ───
RAM_TOTAL=$(free -m | awk 'NR==2{print $2}')
RAM_AVAIL=$(free -m | awk 'NR==2{print $7}')
if [ "$RAM_AVAIL" -lt 256 ]; then
    echo "  [!] Low RAM: ${RAM_AVAIL}MB available of ${RAM_TOTAL}MB"
    ISSUES+=("low_ram")
else
    echo "  [✓] RAM: ${RAM_AVAIL}MB available of ${RAM_TOTAL}MB"
fi

# ─── Gemini env var ───
if [ -n "$GEMINI_API_KEY" ]; then
    echo "  [✓] GEMINI_API_KEY already set"
    HAS_GEMINI_ENV=true
else
    HAS_GEMINI_ENV=false
fi

echo ""

# ─── Handle issues ───
if [[ " ${ISSUES[*]} " =~ "low_disk" ]]; then
    echo "  [!] WARNING: Very low disk space. Install may fail."
    read -p "  Continue anyway? (y/N): " CONT
    [ "$CONT" != "y" ] && [ "$CONT" != "Y" ] && exit 1
fi

if [[ " ${ISSUES[*]} " =~ "existing_bot" ]]; then
    echo "  [!] A Favor bot is already running as '${EXISTING_BOT}'."
    echo "  [!] Running setup again will create a NEW config."
    echo ""
    echo "    1) Continue — fresh setup (old config will be backed up)"
    echo "    2) Cancel — keep what I have"
    echo ""
    read -p "  Enter 1 or 2: " EXISTING_CHOICE
    if [ "$EXISTING_CHOICE" != "1" ]; then
        echo "  [i] Setup cancelled. Your existing bot is untouched."
        exit 0
    fi
fi

if [[ " ${ISSUES[*]} " =~ "existing_config" ]]; then
    BACKUP_NAME="config.backup.$(date +%Y%m%d-%H%M%S).json"
    cp config.json "$BACKUP_NAME"
    echo "  [✓] Backed up existing config to ${BACKUP_NAME}"
fi

# ═══════════════════════════════════════════
#  INSTALL DEPENDENCIES (only what's needed)
# ═══════════════════════════════════════════

echo ""
echo "  Installing what's needed..."
echo ""

# Node.js
if [[ " ${ISSUES[*]} " =~ "node_missing" ]] || [[ " ${ISSUES[*]} " =~ "node_old" ]]; then
    echo "  [*] Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt install -y nodejs > /dev/null 2>&1
    echo "  [✓] Node.js $(node -v) installed"
fi

# Build tools
if [[ " ${ISSUES[*]} " =~ "build_missing" ]]; then
    echo "  [*] Installing build tools..."
    apt install -y build-essential python3 > /dev/null 2>&1
    echo "  [✓] Build tools installed"
fi

# pm2
if [[ " ${ISSUES[*]} " =~ "pm2_missing" ]]; then
    echo "  [*] Installing pm2..."
    npm install -g pm2 > /dev/null 2>&1
    echo "  [✓] pm2 installed"
fi

# npm dependencies
echo "  [*] Installing bot dependencies..."
npm install --silent 2>&1 | tail -1
echo "  [✓] Dependencies ready"

# Create directories
mkdir -p data auth-state
echo "  [✓] Directories ready"

# Copy knowledge templates
KNOWLEDGE_DIR="./knowledge"
for f in "$KNOWLEDGE_DIR"/*.example.md; do
    base=$(basename "$f" .example.md)
    target="$KNOWLEDGE_DIR/$base.md"
    [ ! -f "$target" ] && cp "$f" "$target"
done
echo "  [✓] Knowledge templates ready"

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

# ─── Use case ───
echo ""
if [ "$USE_MODE" = "2" ]; then
    echo "  What does your business do? Pick what fits best:"
    echo ""
    echo "    1) Customer service   — answer questions, handle requests"
    echo "    2) Appointments       — bookings, scheduling, reminders"
    echo "    3) Sales / e-commerce — products, orders, recommendations"
    echo "    4) Content / media    — social media, content creation"
    echo "    5) Consulting / pro services — clients, projects, follow-ups"
    echo "    6) General            — a bit of everything"
    echo ""
    read -p "  Enter 1-6 (default: 6): " BIZ_TYPE
    BIZ_TYPE="${BIZ_TYPE:-6}"
else
    echo "  What will you mainly use your bot for?"
    echo ""
    echo "    1) Personal assistant — reminders, tasks, organization"
    echo "    2) Research / learning — web search, video analysis, notes"
    echo "    3) Coding / dev work  — engineering, debugging, automation"
    echo "    4) Creative           — writing, brainstorming, design help"
    echo "    5) General            — a bit of everything"
    echo ""
    read -p "  Enter 1-5 (default: 5): " PERSONAL_TYPE
    PERSONAL_TYPE="${PERSONAL_TYPE:-5}"
fi

# ─── Bot name ───
echo ""
if [ "$USE_MODE" = "2" ]; then
    read -p "  What's your business name? (this is your bot's name): " BOT_NAME
else
    read -p "  What do you want to name your bot? (default: Favor): " BOT_NAME
fi
BOT_NAME="${BOT_NAME:-Favor}"

# ─── Business details ───
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

# ─── Gemini API key ───
GEMINI_KEY=""
if [ "$HAS_GEMINI_ENV" = true ]; then
    GEMINI_KEY="$GEMINI_API_KEY"
    echo ""
    echo "  [✓] Using existing GEMINI_API_KEY from environment"
else
    echo ""
    echo "  (Optional) Get a free Gemini key from: https://aistudio.google.com/apikey"
    read -p "  Gemini API key (press Enter to skip): " GEMINI_KEY
    GEMINI_KEY="${GEMINI_KEY:-}"
fi

# ─── Brave Search API key ───
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
if [ -n "$GEMINI_KEY" ] && [ "$HAS_GEMINI_ENV" != true ]; then
    if ! grep -q "GEMINI_API_KEY" ~/.bashrc 2>/dev/null; then
        echo "export GEMINI_API_KEY=\"${GEMINI_KEY}\"" >> ~/.bashrc
        export GEMINI_API_KEY="${GEMINI_KEY}"
        echo "[✓] GEMINI_API_KEY saved to environment"
    fi
fi

# ─── Claude Code ───
echo ""
if [ "$HAS_CLAUDE" = true ]; then
    echo "  [✓] Claude Code already installed — skipping"
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
        HAS_CLAUDE=true
    else
        echo "  [i] Skipped — bot works fine without it (coding tasks use GPT-4o instead)"
    fi
fi

# ═══════════════════════════════════════════
#  FEATURE SUGGESTIONS based on use case
# ═══════════════════════════════════════════

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │         Recommended features for you            │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

if [ "$USE_MODE" = "2" ]; then
    # Business suggestions
    case "$BIZ_TYPE" in
        1) # Customer service
            echo "  Based on your use case (customer service), here's what's ready:"
            echo ""
            echo "    [✓] Knowledge base — drop FAQ, policies, product info into knowledge/"
            echo "    [✓] Memory — bot remembers returning customers"
            echo "    [✓] Web search — bot can look things up for customers"
            echo "    [✓] Role security — customers can't access admin tools"
            echo ""
            echo "  Suggested knowledge files to create:"
            echo "    nano knowledge/faq.md          — common questions & answers"
            echo "    nano knowledge/policies.md     — return policy, shipping, etc."
            echo "    nano knowledge/troubleshoot.md  — common issues & solutions"
            ;;
        2) # Appointments
            echo "  Based on your use case (appointments), here's what's ready:"
            echo ""
            echo "    [✓] Scheduled tasks — set up recurring reminders"
            echo "    [✓] Memory — remembers client preferences"
            echo "    [✓] Messaging — bot can send confirmations & reminders"
            echo "    [✓] Staff access — staff can manage schedules via WhatsApp"
            echo ""
            echo "  Suggested knowledge files to create:"
            echo "    nano knowledge/services.md     — services, durations, prices"
            echo "    nano knowledge/booking.md      — how to book, cancellation policy"
            echo "  Suggested next step:"
            echo "    Tell your bot to create scheduled reminders for appointments"
            ;;
        3) # Sales / e-commerce
            echo "  Based on your use case (sales/e-commerce), here's what's ready:"
            echo ""
            echo "    [✓] Knowledge base — product catalog, pricing, inventory"
            echo "    [✓] Browser automation — check sites, fill forms"
            echo "    [✓] Memory — tracks customer preferences & order history"
            echo "    [✓] Web search — research products, competitors"
            echo ""
            echo "  Suggested knowledge files to create:"
            echo "    nano knowledge/products.md     — product list with descriptions"
            echo "    nano knowledge/pricing.md      — pricing, discounts, bundles"
            echo "    nano knowledge/shipping.md     — shipping rates & delivery times"
            ;;
        4) # Content / media
            echo "  Based on your use case (content/media), here's what's ready:"
            echo ""
            echo "    [✓] Video analysis — analyze YouTube/TikTok content"
            echo "    [✓] Web research — research trends, competitors"
            echo "    [✓] Browser automation — check social platforms"
            echo "    [✓] Memory — track content ideas & performance notes"
            echo ""
            echo "  Suggested knowledge files to create:"
            echo "    nano knowledge/brand.md        — brand voice, style guide"
            echo "    nano knowledge/content.md      — content calendar, themes"
            ;;
        5) # Consulting
            echo "  Based on your use case (consulting), here's what's ready:"
            echo ""
            echo "    [✓] Memory — track client projects & notes"
            echo "    [✓] Scheduling — reminders, follow-ups, check-ins"
            echo "    [✓] Vault — securely store client info"
            echo "    [✓] Email — send follow-ups and reports"
            echo ""
            echo "  Suggested knowledge files to create:"
            echo "    nano knowledge/services.md     — what you offer"
            echo "    nano knowledge/process.md      — your workflow & methodology"
            echo "    nano knowledge/clients.md      — client-facing info & FAQs"
            ;;
        *) # General
            echo "  Here's what's ready for your business:"
            echo ""
            echo "    [✓] Knowledge base — teach your bot about your business"
            echo "    [✓] Memory — remembers customers & conversations"
            echo "    [✓] Scheduling — reminders and follow-ups"
            echo "    [✓] Web search — look things up for customers"
            echo "    [✓] Staff roles — team access without admin risk"
            echo ""
            echo "  Start by creating knowledge files:"
            echo "    nano knowledge/business.md     — already created with your info"
            echo "    nano knowledge/faq.md          — common questions"
            echo "    nano knowledge/pricing.md      — your services/pricing"
            ;;
    esac
else
    # Personal suggestions
    case "$PERSONAL_TYPE" in
        1) # Personal assistant
            echo "  Based on your use case (personal assistant), here's what's ready:"
            echo ""
            echo "    [✓] Scheduled reminders — 'remind me to X every Monday at 9am'"
            echo "    [✓] Memory — remembers everything you tell it"
            echo "    [✓] Vault — securely store passwords, cards, addresses"
            echo "    [✓] Web search — look things up instantly"
            if [ "$HAS_CLAUDE" = true ]; then
                echo "    [✓] Claude Code — can run tasks on your server"
            fi
            echo ""
            echo "  Try telling your bot: 'Remind me to check email every morning at 9am'"
            ;;
        2) # Research / learning
            echo "  Based on your use case (research/learning), here's what's ready:"
            echo ""
            echo "    [✓] Web search — research any topic instantly"
            echo "    [✓] Video analysis — send YouTube links for summaries"
            echo "    [✓] Learn from URL — bot reads articles and remembers key points"
            echo "    [✓] Memory — builds knowledge over time"
            echo "    [✓] Browser — visit and read full web pages"
            echo ""
            echo "  Try: Send your bot a YouTube link and say 'learn this'"
            ;;
        3) # Coding / dev
            echo "  Based on your use case (coding/dev), here's what's ready:"
            echo ""
            if [ "$HAS_CLAUDE" = true ]; then
                echo "    [✓] Claude Code — full engineering capability"
            else
                echo "    [!] Claude Code not installed — HIGHLY recommended for dev work"
                echo "        Install: curl -fsSL https://claude.ai/install.sh | sh"
            fi
            echo "    [✓] Server commands — run code, manage processes"
            echo "    [✓] File read/write — edit files on your server"
            echo "    [✓] Browser — test web apps, scrape docs"
            echo "    [✓] Memory — remembers project context"
            echo ""
            echo "  Optional: Connect your laptop for remote dev"
            echo "    Edit config.json → laptop.enabled = true + SSH details"
            ;;
        4) # Creative
            echo "  Based on your use case (creative), here's what's ready:"
            echo ""
            echo "    [✓] Memory — remembers your style, preferences, ideas"
            echo "    [✓] Web research — inspiration, references, trends"
            echo "    [✓] Video analysis — break down creative content"
            echo "    [✓] Learn from URL — study techniques from articles"
            echo "    [✓] Browser — browse reference sites, mood boards"
            echo ""
            echo "  Customize your bot's personality:"
            echo "    nano knowledge/identity.md     — make it match your creative style"
            ;;
        *) # General
            echo "  Here's what's ready for you:"
            echo ""
            echo "    [✓] Memory — remembers everything across conversations"
            echo "    [✓] Scheduled tasks — reminders, check-ins, recurring tasks"
            echo "    [✓] Web search — look up anything"
            echo "    [✓] Video analysis — send links for summaries"
            echo "    [✓] Vault — encrypted storage for sensitive info"
            echo "    [✓] Browser — visit websites, fill forms"
            if [ "$HAS_CLAUDE" = true ]; then
                echo "    [✓] Claude Code — engineering and coding tasks"
            fi
            echo ""
            echo "  Customize your bot:"
            echo "    nano knowledge/identity.md     — personality & style"
            echo "    nano knowledge/goals.md        — what you're working toward"
            ;;
    esac
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

# Check if this pm2 name already exists
if pm2 describe "$BOT_PM2_NAME" > /dev/null 2>&1; then
    pm2 restart "$BOT_PM2_NAME"
    echo "  [✓] Restarted existing pm2 process: ${BOT_PM2_NAME}"
else
    pm2 start favor.js --name "${BOT_PM2_NAME}" --restart-delay 20000
    echo "  [✓] Started new pm2 process: ${BOT_PM2_NAME}"
fi
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
