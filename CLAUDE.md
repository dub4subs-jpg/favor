# CLAUDE.md — Favor Framework

## What is this?
Favor is a WhatsApp AI companion framework built on Baileys (WhatsApp Web API) with multi-model routing, persistent memory (SQLite), conversation compaction, scheduled tasks, voice/vision support, browser automation, and an encrypted vault.

## Quick Start
1. Copy `config.example.json` → `config.json` and fill in your API keys
2. Copy `knowledge/*.example.md` → remove `.example` suffix and customize
3. Run `npm install`
4. Run `node favor.js` (will show QR code to link WhatsApp)

## Running file
The active bot is **`favor.js`** — NOT `bot.js` (legacy, kept for reference only).

## Architecture
```
favor.js        — Main bot: WhatsApp connection, message handling, multi-model routing, tool loop
router.js       — Decision router: Gemini classifier + specialist executors
db.js           — SQLite database layer (sessions, memory, topics, crons, audit)
compactor.js    — Summarizes old messages to save context window space
cron.js         — Scheduled task engine (reminders, proactive outreach)
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
Router uses Gemini 2.5 Flash for classification, keyword overrides for obvious cases.

## Key patterns

### Tool use loop (favor.js)
The bot can call tools (memory, server, web search, crons, topics). The tool loop:
1. Send messages to the AI API with tools
2. If response.stop_reason === 'tool_use', execute tools and append results
3. Repeat until the AI gives a text response

### Compaction (compactor.js)
When conversation exceeds threshold (default 30 messages), older messages are summarized and replaced with a summary block. Split point logic avoids breaking tool pairs.

### Session storage
Conversations are stored in SQLite (`sessions` table) as JSON arrays of messages. Loaded on each incoming message, saved after each response.

### Config hot-reload
`config.json` is watched every 2s. Model changes take effect on next message. Or use `/reload` command in WhatsApp.

## Setup requirements
- Node.js 18+
- API keys: OpenAI (required), Anthropic (optional), Gemini (optional), Brave Search (optional)
- A WhatsApp account to link via QR code

## Commit conventions
- Commit working states before making changes
- Test by sending a message on WhatsApp after restarting
- Keep config.json out of git (it's in .gitignore)
