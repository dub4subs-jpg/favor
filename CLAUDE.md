# CLAUDE.md — Favor Framework

## What is this?
Favor is a multi-platform AI companion framework supporting **WhatsApp** (Baileys) and **Telegram** (grammy), with multi-model routing, persistent memory (SQLite), conversation compaction, scheduled tasks, voice/vision support, browser automation, an encrypted vault, a built-in software builder (Claude Code), and Guardian — a security/QA framework with runtime protection.

## Quick Start

### Option A: WhatsApp (requires a second phone number)
1. Copy `config.example.json` → `config.json` and fill in your API keys
2. Set `"platform": "whatsapp"` in config.json
3. Copy `knowledge/*.example.md` → remove `.example` suffix and customize
4. Run `npm install`
5. Run `node favor.js` (will show QR code to link WhatsApp)

### Option B: Telegram (no extra phone needed — recommended for most users)
1. Copy `config.example.json` → `config.json` and fill in your API keys
2. Set `"platform": "telegram"` in config.json
3. Message @BotFather on Telegram → `/newbot` → copy the bot token
4. Paste the token into `config.json` → `telegram.botToken`
5. Copy `knowledge/*.example.md` → remove `.example` suffix and customize
6. Run `npm install`
7. Run `node favor.js`
8. Message your bot on Telegram — it will reply with your first chat ID
9. Set that chat ID as `telegram.operatorChatId` in config.json for admin access

## Running file
The active bot is **`favor.js`** — NOT `bot.js` (legacy, kept for reference only).

## Architecture
```
favor.js        — Main bot: platform connection, message handling, multi-model routing, tool loop
adapters/telegram.js — Telegram bot adapter (grammy) — sock-compatible interface
router.js       — Decision router: GPT-4o-mini classifier + keyword overrides + specialist executors
db.js           — SQLite database layer (sessions, memory, topics, crons, audit, guard logs)
compactor.js    — Summarizes old messages to save context window space
cron.js         — Scheduled task engine (reminders, proactive outreach)
vault.js        — AES-256-GCM encrypted storage for cards/addresses/IDs
browser.js      — Puppeteer automation (navigate, click, fill forms, screenshot)
video.js        — Video download, transcription, analysis (yt-dlp, ffmpeg, Whisper)
build-mode.js   — Claude Code CLI integration for building software projects
guardian.js     — Unified security framework: code scanning + runtime guard
guardian/       — Guardian QA engine (validators, discovery, regression, repair, reporter)
selfcheck.js    — Automated health monitoring, cleanup, and sanitization
alive.js        — Proactive personality engine (check-ins + memory callbacks)
sync.js         — State sync between bot and external tools
uiux.js         — UI/UX design system engine (161 industry rules)
watchdog.js     — Health monitoring and auto-recovery
config.json     — Runtime config (NOT in git — has API keys). See config.example.json
knowledge/      — Text/markdown files loaded into system prompt as knowledge base
data/favor.db   — SQLite database (NOT in git, auto-created on first run)
```

## Multi-Model Routing
The bot coordinates multiple AI systems:
- **ChatGPT (Brain)** — gpt-4o: reasoning, planning, conversation, tool coordination (default route)
- **Claude Code (Engineer)** — CLI subprocess: coding, debugging, infrastructure
- **Gemini (Analyst)** — gemini-2.5-flash: large document analysis, research, high-context tasks
- **Kimi (Worker Swarm)** — kimi-k2: structured artifacts (reports, slides, spreadsheets)

Routes: tool, memory, mini, claude, gemini, kimi, agent, full, hybrid
Router uses GPT-4o-mini for classification, keyword overrides for obvious cases.

## Build Mode
Shells out to Claude Code CLI to build software projects via WhatsApp.
- `build_plan` — Plan a project (Claude Code reads existing code, creates phases)
- `build_execute` — Execute each phase (writes code, installs deps, commits)
- `build_verify` — Verify against requirements (runs tests, checks code)
- `build_raw` — Freeform Claude Code commands
Keyword triggers: "build this", "build me", "create an app", etc.

## Guardian
Unified security and QA framework with two modes:

**Code Scanner:** Run QA scans on any project directory.
- `guardian_scan` — Discovery, validation (frontend/api/db/security/build), regression tracking
- `guardian_report` — View last scan results

**Runtime Guard:** Live API protection.
- Rate limiting: 100 req/hr, 500/day, $5/day spend cap (configurable via config.json `guard` section)
- Per-contact throttling: 30 req/hr per contact
- API key leak detection: scans outgoing messages, auto-redacts keys
- Anomaly detection and WhatsApp alerts
- `guardian_status` — View current spend, request counts, alerts

## Alive Engine
Proactive personality system that makes Favor feel like a living companion instead of a passive text-in/text-out tool.

**Features:**
- **Morning check-in** — Warm daily greeting that references pending tasks, open threads, or recent memories
- **Evening wind-down** — Casual end-of-day recap or simple check-in
- **Memory callbacks** — Periodically resurfaces forgotten tasks, old decisions worth revisiting, or facts that connect to current work

**Config** (`config.json`):
```json
"alive": {
  "enabled": true,
  "morningCheckin": "09:00",
  "eveningCheckin": "21:00",
  "memoryCallbackHours": 8,
  "timezoneOffsetHours": -5
}
```

Set `"enabled": false` to disable. Times are in local format — `timezoneOffsetHours` converts to UTC internally (default -5 = EST). Memory callbacks have a 7-day per-memory cooldown to avoid nagging. The AI can respond `SKIP` if there's nothing worth saying.

**Cost:** ~$0.01-0.03/day (3 lightweight API calls with short prompts).

## Self-Check
Automated health + cleanup running every 3 days at 5am EST:
- Process health, RAM/swap/disk, database integrity, config validation
- Security: npm audit, syntax checks, secrets-in-git detection
- Cleanup: old screenshots, video temp, pm2 logs, stale telemetry/sessions
- Alerts operator on WhatsApp only if critical issues found

## Key patterns

### Tool use loop (favor.js)
The bot can call tools (memory, server, web search, crons, topics, vault, browser, build, guardian). The tool loop:
1. Send messages to the AI API with tools
2. If response has tool_calls, execute tools and append results
3. Repeat until the AI gives a text response

### Compaction (compactor.js)
When conversation exceeds threshold (default 30 messages), older messages are summarized and replaced with a summary block. Split point logic avoids breaking tool pairs.

### Session storage
Conversations are stored in SQLite (`sessions` table) as JSON arrays of messages. Loaded on each incoming message, saved after each response.

### Config hot-reload
`config.json` is watched every 2s. Model changes take effect on next message. Or use `/reload` command in WhatsApp.

## Setup requirements
- Node.js 18+
- API keys: OpenAI (required), Gemini (optional), Brave Search (optional)
- Claude Code CLI (highly recommended — powers most conversations + Build Mode; auto-detected on startup)
- A WhatsApp account to link via QR code

## Commit conventions
- Commit working states before making changes
- Test by sending a message on WhatsApp after restarting
- Keep config.json out of git (it's in .gitignore)
