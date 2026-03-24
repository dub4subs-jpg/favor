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
tool-runner.js  — Standalone tool executor for Claude CLI (laptop, phone, server, memory, web search)
adapters/telegram.js — Telegram bot adapter (grammy) — sock-compatible interface
router.js       — Decision router: Claude CLI classifier + keyword overrides + specialist executors
db.js           — SQLite database layer (sessions, memory, topics, crons, audit, guard logs)
compactor.js    — Summarizes old messages to save context window space (Claude CLI)
cron.js         — Scheduled task engine (reminders, proactive outreach)
vault.js        — AES-256-GCM encrypted storage for cards/addresses/IDs
browser.js      — Puppeteer automation (navigate, click, fill forms, screenshot)
video.js        — Video download, transcription, analysis (yt-dlp, ffmpeg, Whisper + Claude CLI vision)
build-mode.js   — Claude Code CLI integration for building software projects
guardian.js     — Unified security framework: code scanning + runtime guard
guardian/       — Guardian QA engine (validators, discovery, regression, repair, reporter)
selfcheck.js    — Automated health monitoring, cleanup, and sanitization
alive/          — Proactive personality engine (check-ins + memory callbacks, Claude CLI)
monitor.js      — Process and system monitoring
sync.js         — State sync between bot and external tools
memory-bridge.js — Syncs Claude Code CLI memories into bot's SQLite (auto, every 2m)
uiux.js         — UI/UX design system engine (161 industry rules)
watchdog.js     — Health monitoring and auto-recovery
costs.js        — API cost tracker (OpenAI, Gemini, Kimi — auto-logs token usage and estimated spend)
config.json     — Runtime config (NOT in git — has API keys). See config.example.json
knowledge/      — Text/markdown files loaded into system prompt as knowledge base
data/favor.db   — SQLite database (NOT in git, auto-created on first run)
```

## Multi-Model Routing
**Claude Code CLI is the primary brain** — free via Claude Max ($100/mo) or Pro ($20/mo) subscription. Almost all tasks run through Claude CLI, drastically reducing API costs.

The bot coordinates multiple AI systems:
- **Claude Code CLI (Primary Brain)** — Handles: classification, chat, mini tasks, analysis, compaction, check-ins, callbacks, proactive messages, screen monitoring, video frame analysis, fact extraction, thread detection. **Free via Max/Pro subscription.**
- **OpenAI GPT-4o (Tool Coordinator)** — Only used for the tool use loop (function calling), error recovery/fallback. Also provides Whisper (transcription), TTS (voice), and embeddings.
- **Gemini (Analyst Fallback)** — gemini-2.5-flash: falls back here if Claude CLI fails for large document analysis
- **Kimi (Worker Swarm)** — kimi-k2: structured artifacts (reports, slides, spreadsheets)

Routes: tool, memory, mini, claude, gemini, kimi, agent, full, hybrid
Router uses Claude CLI for classification (free), keyword overrides for obvious cases.

### What still uses OpenAI (paid API)?
- **Tool loop** — GPT-4o function calling (tools: getToolsForRole). This is the ONLY major paid usage.
- **Whisper** — Audio transcription (voice notes, video audio)
- **TTS** — Text-to-speech for voice replies
- **Embeddings** — Semantic memory search (text-embedding-3-small)
- **Fallback** — If Claude CLI is unavailable, some routes fall back to GPT-4o

### What uses Claude CLI (free)?
- Request classification (router)
- **Tool execution** (tool-runner.js — laptop, phone, server, memory, web search)
- Chat and mini route responses
- Conversation compaction (summarization + fact extraction)
- Alive engine (morning/evening check-ins, memory callbacks)
- Proactive cron messages
- Screen monitoring analysis (vision via Read tool)
- Video frame analysis (vision via Read tool)
- Video summarization
- Auto-save findings (fact extraction from research)
- Thread detection (follow-up awareness)
- Gemini analyst route (with Gemini as fallback)
- Learn from URL / video technique extraction

## Tool Runner (Claude CLI Tool Execution)
`tool-runner.js` is a standalone tool executor invoked by Claude CLI during the "tool" route. Instead of using GPT-4o function calling (paid), Claude CLI spawns `node tool-runner.js <tool_name> '<json_args>'` via its Bash tool to execute actions directly.

**How it works:**
1. User sends a tool-like request ("take a screenshot", "open Chrome on my laptop")
2. Router classifies it as `tool` route
3. Claude CLI (haiku model, fast) reads the request and calls `tool-runner.js` via Bash
4. tool-runner.js executes the action and returns the result
5. If Claude CLI fails, GPT-4o function calling is used as fallback

**Available tools:** laptop_screenshot, laptop_open_app, laptop_open_url, laptop_run_command, laptop_read_file, laptop_list_files, laptop_status, phone_screenshot, phone_open_app, phone_status, phone_shell, server_exec, read_file, write_file, memory_save, memory_search, cron_list, web_search, start_remote

## Remote Code Sessions
Message the bot "start remote" and it spins up a Claude Code session in tmux, then sends you a clickable link. Open the link on your phone — you're now coding on your server from your phone, no SSH client needed.

- Uses Claude Code's Remote Control (`claude --rc`)
- Session runs in tmux (survives disconnects)
- Requires Claude Pro ($20/mo) or Max ($100/mo) subscription
- Trigger phrases: "start remote", "remote session", "code from phone", "start coding"

**Device configuration:** All device IPs and SSH credentials are read from `config.json` (`laptop` and `phone` sections). No hardcoded IPs or usernames.

**Cost impact:** Tool execution that previously required GPT-4o function calling ($2.50/$10 per 1M tokens) now runs through Claude CLI (free via subscription). GPT-4o is only the fallback.

### Cost comparison (approximate monthly for active user)
| Component | Before (GPT-4o only) | After (Claude CLI primary) |
|-----------|---------------------|---------------------------|
| Chat/conversation | $15-30/mo | $0 (Claude CLI) |
| Classification | $2-5/mo | $0 (Claude CLI) |
| Tool execution | $10-20/mo | $0 (Claude CLI), GPT-4o fallback only |
| Compaction | $3-5/mo | $0 (Claude CLI) |
| Whisper/TTS/embeddings | $2-5/mo | $2-5/mo (still OpenAI) |
| **Total** | **$30-65/mo** | **$2-5/mo + $20-100 subscription** |

For users already paying for Claude Pro ($20/mo) or Max ($100/mo), the bot runs ~95% free.

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
Proactive personality system that makes Favor feel like a living companion instead of a passive text-in/text-out tool. **Powered by Claude CLI (free).**

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

**Cost:** Free (uses Claude CLI via Max/Pro subscription).

## Self-Check
Automated health + cleanup running every 3 days at 5am EST:
- Process health, RAM/swap/disk, database integrity, config validation
- Security: npm audit, syntax checks, secrets-in-git detection
- Cleanup: old screenshots, video temp, pm2 logs, stale telemetry/sessions
- Alerts operator on WhatsApp only if critical issues found

## Key patterns

### Tool execution (favor.js)
Tool requests go through two layers:
1. **Claude CLI + tool-runner.js (free)** — Claude CLI (haiku) reads the request, picks a tool, runs `node tool-runner.js <tool> '<args>'` via Bash. If the tool sends its own result (e.g. screenshot image), the reply is `__SKIP__` and no text is sent.
2. **GPT-4o function calling (fallback)** — If Claude CLI fails, falls back to OpenAI tool loop:
   - Send messages to OpenAI API with tools (function calling — requires GPT-4o)
   - If response has tool_calls, execute tools and append results
   - Repeat until the AI gives a text response

### Claude CLI pattern
All non-tool-loop AI calls use Claude Code CLI via `runClaudeCLI()`:
- Spawn + stdin pattern for long prompts (avoids arg length limits)
- `ANTHROPIC_API_KEY` stripped from env so it uses Max/Pro subscription (free)
- `--model haiku` for cheap tasks (classification, fact extraction)
- `--model sonnet` for quality responses (analysis, vision)
- `--allowedTools Read` for vision tasks (reads image files)

### Compaction (compactor.js)
When conversation exceeds threshold (default 30 messages), older messages are summarized by Claude CLI and replaced with a summary block. Split point logic avoids breaking tool pairs.

### Session storage
Conversations are stored in SQLite (`sessions` table) as JSON arrays of messages. Loaded on each incoming message, saved after each response.

### Config hot-reload
`config.json` is watched every 2s. Model changes take effect on next message. Or use `/reload` command in WhatsApp.

## Setup requirements
- Node.js 18+
- **Claude Code CLI** (required — primary brain for most tasks; install: `curl -fsSL https://claude.ai/install.sh | sh`)
- Claude Pro ($20/mo) or Max ($100/mo) subscription for free CLI usage
- API keys: OpenAI (required for tool loop + Whisper + TTS + embeddings), Gemini (optional fallback), Brave Search (optional)
- A WhatsApp account to link via QR code, or a Telegram bot token

## Commit conventions
- Commit working states before making changes
- Test by sending a message on WhatsApp after restarting
- Keep config.json out of git (it's in .gitignore)
