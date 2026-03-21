# CLAUDE.md — Agent Instructions for DellV2

## What is this?
DellV2 is a WhatsApp AI companion bot built on the "Favor" framework. It uses Baileys (WhatsApp Web API) and Claude (Anthropic) with tool use, persistent memory (SQLite), conversation compaction, scheduled tasks, laptop remote access, and voice/vision support.

## Running file
The active bot is **`favor.js`** — NOT `bot.js` (legacy, kept for reference only).

## How to restart
```bash
./deploy.sh          # kills old process, starts new one, tails logs
# or manually:
pkill -f "node /root/whatsapp-bot/favor.js"
node /root/whatsapp-bot/favor.js &
```

## Architecture
```
favor.js        — Main bot: WhatsApp connection, message handling, multi-model routing, tool loop
router.js       — Decision router: Gemini classifier + specialist executors (Claude CLI, Kimi, Gemini Analyst)
db.js           — SQLite database layer (sessions, memory, topics, crons, audit)
compactor.js    — Summarizes old messages to save context window space
cron.js         — Scheduled task engine (reminders, proactive outreach)
config.json     — Runtime config (NOT in git — has API keys). See config.example.json
knowledge/      — Text/markdown files loaded into system prompt as knowledge base
data/favor.db   — SQLite database (NOT in git)
```

## Specialist Routing (Kimi Swarm Integration)
Dell coordinates 4 specialist AI systems:
- **ChatGPT (Brain)** — gpt-4o: reasoning, planning, conversation, tool coordination (default route)
- **Claude Code (Engineer)** — CLI subprocess: coding, debugging, infrastructure (uses Max subscription, cost-free)
- **Gemini (Analyst)** — gemini-2.5-flash: large document analysis, research, high-context tasks
- **Kimi (Worker Swarm)** — kimi-k2: structured artifacts (reports, slides, spreadsheets, batch production)

Routes: tool, memory, mini, claude, gemini, kimi, agent, full, hybrid
Router uses Gemini 2.5 Flash for classification, keyword overrides for obvious cases.

## Key patterns

### Tool use loop (favor.js ~line 808-830)
Claude can call tools (memory, laptop, server, web search, crons, topics). The tool loop:
1. Send messages to Claude API with tools
2. If response.stop_reason === 'tool_use', execute tools and append results
3. Repeat until Claude gives a text response

### History sanitization (favor.js ~line 358-388)
`sanitizeHistory()` ensures tool_use/tool_result pairs are always intact before sending to the API. This prevents 400 errors from orphaned tool blocks. Applied on every `getHistory()` call.

### Compaction (compactor.js)
When conversation exceeds threshold (default 30 messages), older messages are summarized by a cheap model (Haiku) and replaced with a summary block. Split point logic avoids breaking tool pairs.

### Session storage
Conversations are stored in SQLite (`sessions` table) as JSON arrays of messages. Loaded on each incoming message, saved after each response.

## Common issues

### "tool_use ids were found without tool_result blocks"
History has orphaned tool_use without matching tool_result. The `sanitizeHistory()` function handles this automatically. If it recurs, check:
- Compactor split logic in `compactor.js`
- Whether the tool loop in `favor.js` properly pushes both assistant content AND tool results

### Bot not responding
1. Check if running: `ps aux | grep favor.js`
2. Check logs: `tail -50 /tmp/favor.log`
3. Check WhatsApp connection: look for `[FAVOR] ... is online` in logs
4. Check API key: `echo $ANTHROPIC_API_KEY | head -c 10`

### Config changes
`config.json` is hot-reloaded (fs.watchFile every 2s). Model changes take effect on next message. Or use `/reload` command in WhatsApp.

## Memory Sync Bot (sync.js)
DellV2 and Claude Code share state via `sync.js`. After making changes, log them:
```bash
node sync-cli.js sync '{"summary":"what you changed","type":"file_change","next":"restart bot to test"}'
```

Available commands:
```bash
node sync-cli.js status       # Quick overview
node sync-cli.js state        # Full JSON state
node sync-cli.js events 10    # Recent event log
node sync-cli.js recover      # Recovery report after crash
node sync-cli.js handoff '{"done":"what was done","next":"what to do next"}'
node sync-cli.js checkpoint "reason"
```

**Always sync after:** editing favor.js/router.js/db.js, fixing bugs, adding features, or completing tasks.

## Commit conventions
- Commit working states before making changes
- Test by sending a message on WhatsApp after restarting
- Keep config.json out of git (it's in .gitignore)
