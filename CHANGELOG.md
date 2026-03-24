# Changelog

All notable updates to Favor. When you run `./update.sh`, you'll see what's new.

---

## [2026-03-24] v4.0.0 — Production Refinement

### What you can now do
- **Smarter & safer** — Your bot is better at ignoring spam, scams, and sketchy content when browsing the web or reading emails for you.
- **No more double replies** — Fixed an issue where the bot would sometimes respond to the same message twice.
- **Update notifications** — After every update, your bot will message you with what's new (like this one).
- **Secure vault** — Your saved cards and personal info are more securely encrypted.
- **Plugins** — Developers can now extend your bot with custom skills.

---

## [2026-03-24] v3.1.0 — Intelligence Engine

The biggest update yet. Favor now learns from its own behavior, maps relationships between entities, replays past conversations, delegates background research, replies with voice notes, and cuts API costs by 70-90% with smart tool selection.

### New capabilities
- **Self-improvement loop** (`reflect.js`) — Every 6 hours, analyzes recent interactions, extracts behavioral lessons, and injects proven lessons into future prompts. Your bot genuinely gets smarter over time.
- **Knowledge graph** — Automatically extracts entities (people, companies, products) and their relationships from every conversation. Ask "who do I do business with?" and get a real answer.
- **Conversation replay** — Daily digests (generated at 11pm) permanently store what was discussed. Ask "what were we talking about last Tuesday?" — compaction can't erase it anymore.
- **Passive learning** — Forward a message or share a link → your bot silently absorbs it (reacts with 👀) instead of trying to respond. Extracts entities, prices, dates, contacts.
- **Conversation threading** — Every message gets a topic tag. When you return to an old topic, relevant context is pulled back in. Compaction produces per-topic summaries.
- **Dynamic recipes** — Teach mode now supports `$input`, `$prev`, `$step[N]` variables. Output of one step feeds into the next.
- **Voice responses** — Send a voice note, get a voice note back (edge-tts, free). Install: `pip install edge-tts`
- **Agent delegation** — Spawn background research tasks that run independently and message you when done. Max 3 concurrent.
- **Morning intelligence brief** — Morning check-in now includes: yesterday's digest, today's schedule, pending tasks, open threads, actionable signals.
- **Notification batching** — Multiple proactive messages within 2 minutes combine into one.
- **Cost dashboard** — `/costs` command shows today/week/month spend, cost by model, cost by route, 7-day trend.
- **Trust levels** — 4 tiers (operator/staff/customer/guest) with per-level route access, tool filtering, and rate limits.

### Performance
- **Smart tool selection** — Pre-filters 80+ tools down to 10-20 per API call based on route + keywords. 70-90% token savings.
- **Retry engine** — Tool failures include fallback hints ("Hint: try phone_screenshot as alternative"). AI decides whether to act.

### New files
- `tool-selector.js` — Smart tool pre-filtering
- `reflect.js` — Self-improvement loop
- `notification-queue.js` — Notification batching
- `tts.js` — Text-to-speech (edge-tts + OpenAI TTS)
- `agent-tasks.js` — Background task delegation

### How to get this update
```bash
./update.sh
# Optional: install voice replies
pip install edge-tts
```

---

## [2026-03-23] — Smarter Conversations + Cost Visibility

### What's new
- **Claude Code CLI auto-detection** — Your bot now automatically finds Claude Code CLI wherever it's installed. If you have a Claude Pro/Max subscription, most conversations route through Claude instead of GPT-4o — better responses at a flat monthly cost instead of per-message API charges.
- **One-time install tip** — If Claude CLI isn't installed, your bot will suggest it once so your users know what they're missing.
- **API cost tracking** — Every OpenAI, Gemini, and Kimi API call is now logged with token counts and estimated cost. See daily, weekly, and monthly spend breakdowns.
- **Auto-save research findings** — When your bot does web searches or Gemini analysis, key facts are automatically extracted and saved to memory. Your bot gets smarter over time without you doing anything.
- **Email search & read tools** — Your bot can now search your Gmail inbox and read full emails. Say "check my email" or "search email for invoices".

### What you can now do
- Install Claude CLI (`curl -fsSL https://claude.ai/install.sh | sh && claude login`) for dramatically better conversations
- Ask your bot "how much have I spent on API today?" (cost data is in the database)
- Say "check my email" or "search my email for [topic]" to read emails through your bot
- Research topics and know your bot is remembering the key facts automatically

### How to get this update
```bash
./update.sh
```

---

## [2026-03-20] — Telegram Support

### What's new
- **Telegram adapter** — Run your bot on Telegram instead of WhatsApp. No second phone needed.
- Just set `"platform": "telegram"` in config.json and add your bot token from @BotFather.

### What you can now do
- Run Favor on Telegram — message @BotFather, get a token, paste it in config, done
- Switch between Telegram and WhatsApp anytime — your memory, knowledge, and settings carry over

---

## [2026-03-18] — Alive Engine

### What's new
- **Morning check-ins** — Your bot greets you each morning with relevant context
- **Evening wind-down** — Casual end-of-day recap
- **Memory callbacks** — Periodically resurfaces forgotten tasks and old decisions worth revisiting

### What you can now do
- Enable alive engine in config.json: `"alive": { "enabled": true }`
- Your bot feels like a living companion, not just a tool that waits for commands

---

## [2026-03-16] — Guardian + Self-Check

### What's new
- **Guardian runtime protection** — Rate limiting, spend caps, per-contact throttling, API key leak detection
- **Guardian code scanner** — Run QA scans on any project directory
- **Self-Check** — Automated health monitoring and cleanup every 3 days

### What you can now do
- Say "guardian status" to check current spend and request counts
- Say "run guardian on /path/to/project" to scan a codebase
- Customize rate limits in config.json under `"guard": { ... }`

---

## [2026-03-14] — Build Mode

### What's new
- **Build Mode** — Tell your bot to build software and it shells out to Claude Code CLI
- Plan, execute, verify, and iterate on software projects entirely through chat

### What you can now do
- Say "build me a todo app with React" and your bot plans, codes, and commits it
- Use `build_plan`, `build_execute`, `build_verify`, `build_raw` commands

---

## [2026-03-12] — Role-Based Access + Smart Setup

### What's new
- **Role-based access control** — Operator (full access), Staff (tools + memory), Customer (search only)
- **AI-powered setup script** — Scans your system, suggests features, avoids conflicts
- **Teach mode** — Create custom commands your bot executes deterministically

### What you can now do
- Share your bot with staff or customers with appropriate permission levels
- Teach your bot custom workflows: "teach: when I say 'deploy', pull from git and restart"
- Run `bash setup.sh` for a guided, intelligent setup experience
