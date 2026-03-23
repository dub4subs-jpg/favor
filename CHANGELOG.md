# Changelog

All notable updates to Favor. When you run `./update.sh`, you'll see what's new.

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
