#!/bin/bash
# Favor — First-Time Setup Script
# Run this after cloning the repo: bash setup.sh

set -e

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║         FAVOR — Setup Script          ║"
echo "  ║      Your AI WhatsApp Companion       ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ─── Check Node.js ───
if ! command -v node &> /dev/null; then
    echo "[!] Node.js not found. Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs
else
    echo "[✓] Node.js $(node -v) found"
fi

# ─── Check build tools ───
if ! command -v make &> /dev/null; then
    echo "[!] Installing build tools..."
    apt install -y build-essential python3
else
    echo "[✓] Build tools found"
fi

# ─── Check pm2 ───
if ! command -v pm2 &> /dev/null; then
    echo "[!] Installing pm2..."
    npm install -g pm2
else
    echo "[✓] pm2 $(pm2 -v) found"
fi

# ─── Install npm dependencies ───
echo ""
echo "[*] Installing npm dependencies..."
npm install

# ─── Create directories ───
mkdir -p data
mkdir -p /root/.openclaw/credentials/whatsapp/default
echo "[✓] Directories created"

# ─── Copy knowledge templates ───
echo ""
echo "[*] Setting up knowledge files..."
KNOWLEDGE_DIR="./knowledge"

for f in "$KNOWLEDGE_DIR"/*.example.md; do
    base=$(basename "$f" .example.md)
    target="$KNOWLEDGE_DIR/$base.md"
    if [ ! -f "$target" ]; then
        cp "$f" "$target"
        echo "    Created: $target"
    else
        echo "    Exists:  $target (skipped)"
    fi
done

# ─── Config setup ───
echo ""
if [ -f "config.json" ]; then
    echo "[✓] config.json already exists (skipping)"
else
    cp config.example.json config.json
    echo "[✓] Created config.json from template"
    echo ""
    echo "  ┌─────────────────────────────────────────────────┐"
    echo "  │  You MUST edit config.json before running!      │"
    echo "  │                                                 │"
    echo "  │  nano config.json                               │"
    echo "  │                                                 │"
    echo "  │  Required changes:                              │"
    echo "  │    • api.openaiApiKey    (from platform.openai)  │"
    echo "  │    • api.geminiApiKey    (from aistudio.google)  │"
    echo "  │    • whatsapp.operatorNumber  (your phone #)    │"
    echo "  │    • whatsapp.allowFrom      (your phone #)     │"
    echo "  │    • identity.name      (your bot's name)       │"
    echo "  │    • vault.secret       (any random string)     │"
    echo "  │    • whatsapp.securityPhrase  (a secret word)   │"
    echo "  │                                                 │"
    echo "  │  Optional:                                      │"
    echo "  │    • api.braveApiKey     (for web search)       │"
    echo "  │    • laptop.enabled     (true + SSH details)    │"
    echo "  └─────────────────────────────────────────────────┘"
fi

# ─── Claude Code check ───
echo ""
if command -v claude &> /dev/null; then
    echo "[✓] Claude Code found ($(claude --version 2>/dev/null || echo 'installed'))"
else
    echo "[!] Claude Code NOT installed"
    echo "    To get full capabilities (coding/engineering route):"
    echo ""
    echo "    1. Subscribe to Claude Max ($100/mo) at claude.ai"
    echo "    2. Install:  curl -fsSL https://claude.ai/install.sh | sh"
    echo "    3. Log in:   claude login"
    echo ""
    echo "    Without Claude, coding tasks will fall back to GPT-4o (still works, just not as good for code)."
fi

# ─── Gemini env var check ───
echo ""
if [ -n "$GEMINI_API_KEY" ]; then
    echo "[✓] GEMINI_API_KEY is set"
else
    echo "[!] GEMINI_API_KEY not set in environment"
    echo "    Run this (replace with your actual key):"
    echo ""
    echo "    echo 'export GEMINI_API_KEY=\"YOUR_KEY\"' >> ~/.bashrc && source ~/.bashrc"
fi

# ─── Summary ───
echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │              Setup Complete!                    │"
echo "  │                                                 │"
echo "  │  Next steps:                                    │"
echo "  │                                                 │"
echo "  │  1. Edit config.json with your API keys         │"
echo "  │  2. Edit knowledge files with your info         │"
echo "  │  3. Set GEMINI_API_KEY env var                  │"
echo "  │  4. Run:  node favor.js                         │"
echo "  │  5. Scan QR code with WhatsApp                  │"
echo "  │  6. Then set up pm2:                            │"
echo "  │     pm2 start favor.js --name favor-whatsapp \  │"
echo "  │       --restart-delay 20000                     │"
echo "  │     pm2 save && pm2 startup                     │"
echo "  └─────────────────────────────────────────────────┘"
echo ""
