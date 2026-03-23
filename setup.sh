#!/bin/bash
# Favor — One-Command Setup
# Clone the repo and run: bash setup.sh
# Smart installer — scans your system, avoids conflicts, suggests features.

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║         FAVOR — Setup Script          ║"
echo "  ║       Your AI Companion Bot           ║"
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

# ─── Platform choice ───
echo "  Which messaging platform do you want to use?"
echo ""
echo "    1) Telegram  — easy setup, no extra phone needed (recommended)"
echo "    2) WhatsApp  — requires a second phone number"
echo ""
read -p "  Enter 1 or 2 (default: 1): " PLATFORM_CHOICE
PLATFORM_CHOICE="${PLATFORM_CHOICE:-1}"

if [ "$PLATFORM_CHOICE" = "2" ]; then
    PLATFORM="whatsapp"
    echo ""
    echo "  [✓] WhatsApp — you'll scan a QR code at the end"
else
    PLATFORM="telegram"
    echo ""
    echo "  [✓] Telegram — you'll need a bot token from @BotFather"
fi

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

# ─── Describe your use case ───
echo ""
if [ "$USE_MODE" = "2" ]; then
    echo "  Describe your business in a few sentences."
    echo "  (What you do, who your customers are, what the bot should help with)"
    echo ""
    read -p "  > " USE_DESCRIPTION
else
    echo "  Describe what you want your bot to help you with."
    echo "  (The more detail the better — it'll customize everything for you)"
    echo ""
    read -p "  > " USE_DESCRIPTION
fi
USE_DESCRIPTION="${USE_DESCRIPTION:-A general purpose AI assistant}"

# Defaults (will be overridden by AI if OpenAI key is available)
BUSINESS_TAGLINE="Always in your favor."
BOT_TONE="friendly, helpful, direct"

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

# ─── Platform-specific setup ───
PHONE_NUMBER="+1XXXXXXXXXX"
TELEGRAM_TOKEN=""

if [ "$PLATFORM" = "telegram" ]; then
    echo ""
    echo "  To create a Telegram bot:"
    echo "    1. Open Telegram and message @BotFather"
    echo "    2. Send /newbot and follow the prompts"
    echo "    3. Copy the bot token it gives you"
    echo ""
    read -p "  Paste your bot token: " TELEGRAM_TOKEN
    if [ -z "$TELEGRAM_TOKEN" ]; then
        echo "  [!] Bot token is required. You can add it later: nano config.json"
        TELEGRAM_TOKEN="YOUR_BOT_TOKEN_FROM_BOTFATHER"
    fi
else
    echo ""
    echo "  Your WhatsApp number (with country code, e.g. +13055551234)"
    read -p "  Phone number: " PHONE_NUMBER
    if [ -z "$PHONE_NUMBER" ]; then
        echo "  [!] Phone number is required. You can edit config.json later."
        PHONE_NUMBER="+1XXXXXXXXXX"
    fi
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

# ─── Alive Engine (proactive check-ins + memory callbacks) ───
echo ""
echo "  Your bot can message you on its own — a morning"
echo "  hello, an evening recap, and reminders about"
echo "  things you might've forgotten."
echo ""
read -p "  Want your bot to check in on you? (Y/n): " ALIVE_ENABLED
ALIVE_ENABLED="${ALIVE_ENABLED:-Y}"

if [ "$ALIVE_ENABLED" = "n" ] || [ "$ALIVE_ENABLED" = "N" ]; then
    ALIVE_ON=false
    ALIVE_TZ_OFFSET=-5
    echo "  [i] No problem — you can turn this on later"
else
    ALIVE_ON=true
    echo ""
    echo "  What timezone are you in?"
    echo ""
    echo "    1) US Eastern (New York)"
    echo "    2) US Central (Chicago)"
    echo "    3) US Mountain (Denver)"
    echo "    4) US Pacific (Los Angeles)"
    echo "    5) UK / UTC (London)"
    echo "    6) Central Europe (Paris/Berlin)"
    echo "    7) India (Mumbai)"
    echo "    8) Other"
    echo ""
    read -p "  Enter 1-8 (default: 1): " TZ_CHOICE
    TZ_CHOICE="${TZ_CHOICE:-1}"

    case "$TZ_CHOICE" in
        1) ALIVE_TZ_OFFSET=-5 ;;
        2) ALIVE_TZ_OFFSET=-6 ;;
        3) ALIVE_TZ_OFFSET=-7 ;;
        4) ALIVE_TZ_OFFSET=-8 ;;
        5) ALIVE_TZ_OFFSET=0 ;;
        6) ALIVE_TZ_OFFSET=1 ;;
        7) ALIVE_TZ_OFFSET=5.5 ;;
        8)
            read -p "  Enter your UTC offset (e.g. -5, +3, +5.5): " ALIVE_TZ_OFFSET
            ALIVE_TZ_OFFSET="${ALIVE_TZ_OFFSET:--5}"
            ;;
        *) ALIVE_TZ_OFFSET=-5 ;;
    esac

    echo "  [✓] Your bot will say good morning and check in each evening"
fi

ALIVE_MORNING="09:00"
ALIVE_EVENING="21:00"
ALIVE_CALLBACK=8

# ─── Generate vault secret ───
VAULT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)

# ─── Write config.json ───
cat > config.json << CONFIGEOF
{
  "platform": "${PLATFORM}",
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
  "telegram": {
    "botToken": "${TELEGRAM_TOKEN}",
    "operatorChatId": "",
    "dmPolicy": "${DM_POLICY}",
    "allowGroups": ${ALLOW_GROUPS},
    "securityPhrase": "${SEC_PHRASE}",
    "trustedContacts": [],
    "staff": ${STAFF_JSON},
    "allowFrom": []
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
  "alive": {
    "enabled": ${ALIVE_ON},
    "morningCheckin": "${ALIVE_MORNING}",
    "eveningCheckin": "${ALIVE_EVENING}",
    "memoryCallbackHours": ${ALIVE_CALLBACK},
    "timezoneOffsetHours": ${ALIVE_TZ_OFFSET}
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

# ═══════════════════════════════════════════
#  AI-POWERED CUSTOMIZATION
#  Uses their OpenAI key to generate:
#  - Tagline, tone, personality
#  - Knowledge files tailored to their use case
#  - Feature recommendations
# ═══════════════════════════════════════════

if [ "$OPENAI_KEY" != "YOUR_OPENAI_API_KEY" ] && [ -n "$USE_DESCRIPTION" ]; then
    echo ""
    echo "  [*] Analyzing your description and customizing your bot..."
    echo ""

    if [ "$USE_MODE" = "2" ]; then
        AI_MODE="business"
    else
        AI_MODE="personal"
    fi

    # Call OpenAI to generate customizations
    AI_RESPONSE=$(curl -s --max-time 30 https://api.openai.com/v1/chat/completions \
        -H "Authorization: Bearer ${OPENAI_KEY}" \
        -H "Content-Type: application/json" \
        -d "$(cat << AIPROMPTEOF
{
  "model": "gpt-4o-mini",
  "temperature": 0.7,
  "messages": [
    {
      "role": "system",
      "content": "You are setting up an AI companion bot (platform: ${PLATFORM}). The user described their use case. Generate a JSON response with these fields:\n\n1. tagline: A short catchy tagline for their bot (under 50 chars)\n2. tone: Comma-separated tone descriptors (e.g. 'friendly, professional, warm')\n3. personality: One word (companion, assistant, advisor, concierge, coach, expert)\n4. knowledge_files: Array of objects with 'filename' and 'content' — markdown knowledge files the bot should have. Create 2-4 files with real useful content based on their description. For business: include business info, services, FAQ. For personal: include relevant guides, preferences, goals.\n5. features: Array of strings — the most relevant bot features for their use case. Pick from: memory, scheduled_tasks, web_search, video_analysis, browser_automation, vault, voice_messages, image_analysis, email, laptop_remote, claude_code, alive\n6. tips: Array of 3 short tips (one sentence each) for getting the most out of their bot\n\nRespond with ONLY valid JSON, no markdown."
    },
    {
      "role": "user",
      "content": "Mode: ${AI_MODE}\nBot name: ${BOT_NAME}\nDescription: ${USE_DESCRIPTION}"
    }
  ]
}
AIPROMPTEOF
)" 2>/dev/null)

    # Parse the AI response
    AI_JSON=$(echo "$AI_RESPONSE" | node -e "
        try {
            const r = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            const content = r.choices[0].message.content.replace(/\`\`\`json?\n?/g,'').replace(/\`\`\`/g,'').trim();
            console.log(content);
        } catch(e) { console.log(''); }
    " 2>/dev/null)

    if [ -n "$AI_JSON" ] && echo "$AI_JSON" | node -e "try{JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.exit(0)}catch(e){process.exit(1)}" 2>/dev/null; then
        # Successfully got AI suggestions — apply them

        # Update config with AI-generated tagline, tone, personality
        NEW_TAGLINE=$(echo "$AI_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.tagline||'')" 2>/dev/null)
        NEW_TONE=$(echo "$AI_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.tone||'')" 2>/dev/null)
        NEW_PERSONALITY=$(echo "$AI_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.personality||'')" 2>/dev/null)

        if [ -n "$NEW_TAGLINE" ]; then
            node -e "
                const fs = require('fs');
                const c = JSON.parse(fs.readFileSync('config.json','utf8'));
                c.identity.tagline = '${NEW_TAGLINE}'.replace(/'/g, \"\\\\'\");
                c.identity.tone = '${NEW_TONE}'.replace(/'/g, \"\\\\'\") || c.identity.tone;
                c.identity.personality = '${NEW_PERSONALITY}'.replace(/'/g, \"\\\\'\") || c.identity.personality;
                fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
            " 2>/dev/null
            echo "  [✓] Tagline: ${NEW_TAGLINE}"
            echo "  [✓] Tone: ${NEW_TONE}"
        fi

        # Create knowledge files
        echo "$AI_JSON" | node -e "
            const fs = require('fs');
            const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            if (d.knowledge_files && d.knowledge_files.length) {
                d.knowledge_files.forEach(f => {
                    const path = 'knowledge/' + f.filename;
                    fs.writeFileSync(path, f.content);
                    console.log('  [✓] Created: ' + path);
                });
            }
        " 2>/dev/null

        # Show feature recommendations
        echo ""
        echo "  ┌─────────────────────────────────────────────────┐"
        echo "  │         Recommended features for you            │"
        echo "  └─────────────────────────────────────────────────┘"
        echo ""

        echo "$AI_JSON" | node -e "
            const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            const featureNames = {
                memory: 'Memory — remembers everything across conversations',
                scheduled_tasks: 'Scheduled tasks — reminders, follow-ups, recurring actions',
                web_search: 'Web search — look up anything online',
                video_analysis: 'Video analysis — summarize YouTube/TikTok content',
                browser_automation: 'Browser — visit websites, fill forms, take screenshots',
                vault: 'Vault — encrypted storage for sensitive info',
                voice_messages: 'Voice — send/receive voice notes',
                image_analysis: 'Vision — analyze photos and images',
                email: 'Email — send emails and follow-ups',
                laptop_remote: 'Laptop remote — control your computer from your bot',
                claude_code: 'Claude Code — engineering and coding tasks',
                alive: 'Alive Engine — proactive morning/evening check-ins + memory callbacks'
            };
            if (d.features) {
                d.features.forEach(f => {
                    const name = featureNames[f] || f;
                    console.log('    [✓] ' + name);
                });
            }
        " 2>/dev/null

        # Show tips
        echo ""
        echo "$AI_JSON" | node -e "
            const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            if (d.tips && d.tips.length) {
                console.log('  Tips:');
                d.tips.forEach((t, i) => console.log('    ' + (i+1) + '. ' + t));
            }
        " 2>/dev/null

    else
        echo "  [i] Couldn't reach OpenAI for customization — using defaults."
        echo "  [i] You can customize later by editing knowledge/ files."

        # Fallback: create basic knowledge file for business mode
        if [ "$USE_MODE" = "2" ]; then
            cat > knowledge/business.md << BIZEOF
# ${BOT_NAME}

## About
${USE_DESCRIPTION}

## Contact
Contact us for more information.
BIZEOF
            echo "  [✓] Created basic knowledge/business.md"
        fi
    fi
else
    # No OpenAI key or no description — create basic files
    if [ "$USE_MODE" = "2" ] && [ -n "$USE_DESCRIPTION" ]; then
        cat > knowledge/business.md << BIZEOF
# ${BOT_NAME}

## About
${USE_DESCRIPTION}
BIZEOF
        echo "  [✓] Created knowledge/business.md"
    fi
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
    echo "  ⭐ HIGHLY RECOMMENDED: Claude Code makes your bot way smarter."
    echo "  Without it, all messages use GPT-4o (pay-per-use API costs)."
    echo "  With it, most conversations route through Claude for better"
    echo "  responses at a flat monthly fee (no extra per-message cost)."
    echo ""
    echo "  Requires a Claude account (\$20/mo Pro or \$100/mo Max)."
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
        echo "  [i] Skipped — bot will use GPT-4o for all messages (higher API costs, less natural)"
        echo "  [i] You can install later: curl -fsSL https://claude.ai/install.sh | sh && claude login"
    fi
fi

echo ""

# ═══════════════════════════════════════════
#  LAUNCH
# ═══════════════════════════════════════════

BOT_PM2_NAME=$(echo "$BOT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')

if [ "$PLATFORM" = "telegram" ]; then
    echo ""
    echo "  ╔═══════════════════════════════════════════════════╗"
    echo "  ║                 Setup Complete!                   ║"
    echo "  ║                                                   ║"
    echo "  ║  Your bot '${BOT_NAME}' is ready to launch.            "
    echo "  ║                                                   ║"
    echo "  ║  Starting now — message your bot on Telegram!     ║"
    echo "  ║                                                   ║"
    echo "  ║  After your first message, check the console      ║"
    echo "  ║  for your Chat ID — set it as operatorChatId      ║"
    echo "  ║  in config.json for admin access.                 ║"
    echo "  ╚═══════════════════════════════════════════════════╝"
    echo ""

    read -p "  Press Enter to start ${BOT_NAME}..." _

    # Start and let it run briefly so user can see it working
    node favor.js &
    BOT_PID=$!
    echo ""
    echo "  Bot is starting... Message your bot on Telegram now!"
    echo "  Once you see your Chat ID in the logs, note it down."
    echo ""
    read -p "  Press Enter after you've messaged your bot..." _

    # Kill the foreground process and set up pm2
    kill $BOT_PID 2>/dev/null
    sleep 2

    echo ""
    echo "  Now set your Chat ID as the operator:"
    read -p "  Your Telegram Chat ID (from the logs above): " TG_CHAT_ID
    if [ -n "$TG_CHAT_ID" ]; then
        node -e "
            const fs = require('fs');
            const c = JSON.parse(fs.readFileSync('config.json','utf8'));
            c.telegram.operatorChatId = '${TG_CHAT_ID}';
            fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
        " 2>/dev/null
        echo "  [✓] Operator Chat ID set to ${TG_CHAT_ID}"
    else
        echo "  [i] No Chat ID set — you can add it later in config.json"
    fi

    # Set up pm2
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
    echo "  ║  Message your bot on Telegram — it will reply!    ║"
    echo "  ║  It runs 24/7 automatically.                      ║"
    echo "  ║                                                   ║"
    echo "  ║  Helper scripts:                                  ║"
    echo "  ║    ./status.sh     — check bot health             ║"
    echo "  ║    ./update.sh     — pull latest updates          ║"
    echo "  ║                                                   ║"
    echo "  ║  Or text your bot:                                ║"
    echo "  ║    /status  /update  /help                        ║"
    echo "  ╚═══════════════════════════════════════════════════╝"
    echo ""

else
    # WhatsApp flow
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
fi
