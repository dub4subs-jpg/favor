# Favor

**Your own AI WhatsApp bot.** Clone it, run one command, scan a QR code — done.

Favor gives you a personal AI assistant on WhatsApp with memory, multi-model routing, browser automation, an encrypted vault, video analysis, a built-in software builder, and Guardian — a security and QA framework that protects your bot and any project it manages.

---

## Setup (5 minutes)

You need a **DigitalOcean account** (or any Linux server) and an **OpenAI API key**.

### 1. Create a server

- Go to [digitalocean.com](https://www.digitalocean.com) and sign up
- Click **Create** → **Droplets**
- Choose **Ubuntu 22.04**, pick the **$6/mo** plan, click **Create Droplet**
- Once it's ready, click on it and hit the **Console** button (opens a terminal in your browser)

### 2. Run one command

Paste this into the terminal:

```bash
git clone https://github.com/dub4subs-jpg/favor.git && cd favor && bash setup.sh
```

The setup script will:
- Install everything automatically (Node.js, pm2, dependencies)
- Ask you a few questions (bot name, phone number, API keys)
- Create your config
- Show a QR code — scan it with WhatsApp
- Start your bot and keep it running 24/7

That's it. Your bot is live.

---

## What you need

| What | Where to get it | Cost |
|------|----------------|------|
| OpenAI API key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Pay-per-use (~$5-20/mo) |
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free |
| Brave Search key | [brave.com/search/api](https://brave.com/search/api/) | Free tier available |
| Claude Code subscription | [claude.ai](https://claude.ai) | Optional — needed for Build Mode |
| DigitalOcean server | [digitalocean.com](https://www.digitalocean.com) | $6/mo |

Only OpenAI is required. Everything else is optional but recommended.

---

## Features

### Core
- **Multi-model AI** — Routes messages to GPT-4o, Gemini, Claude, or Kimi depending on the task
- **Memory** — Remembers facts, preferences, decisions, and past conversations
- **Voice messages** — Send voice notes, get text replies (or vice versa)
- **Vision** — Send photos and it can see/analyze them
- **Web search** — Searches the internet via Brave Search
- **Scheduled tasks** — Set reminders, recurring messages, check-ins
- **Knowledge base** — Load custom markdown files to give your bot expertise
- **Conversation compaction** — Summarizes old messages so it never runs out of context

### Tools
- **Browser automation** — Browse websites, fill forms, take screenshots, shop online
- **Video analysis** — Send YouTube/TikTok links for summaries, transcripts, and learning
- **Encrypted vault** — Securely store sensitive info (cards, addresses, passwords) with AES-256
- **Laptop remote access** — Control your computer via SSH (open apps, run commands, take screenshots)
- **Email** — Search, read, and send emails through Gmail
- **UI/UX design system** — Generate color palettes, typography, and layout recommendations

### Build Mode
Tell your bot to build software and it shells out to **Claude Code CLI** to do the actual coding.

- `build_plan` — Describe what you want, get a phased build plan
- `build_execute` — Execute each phase step by step (Claude Code writes the code)
- `build_verify` — Verify the build against your requirements
- `build_raw` — Freeform Claude Code commands for quick fixes

Say things like *"build me a todo app with React"* or *"build a price tracker"* — your bot plans it, builds it, commits it.

> Requires a Claude Code subscription (Pro or Max plan). Install Claude Code CLI on your server first.

### Guardian

A built-in security and QA framework with two modes:

**Code Scanner** — Run health scans on any project:
- Feature discovery, code quality checks, security validation
- API route testing, database integrity, build verification
- Regression detection (compares against previous scans)
- Say *"run guardian on /root/my-project"* or *"scan the project for issues"*

**Runtime Protection** — Keeps your bot safe 24/7:
- **Rate limiting** — 100 requests/hour, 500/day, $5/day spend cap (all configurable)
- **Per-contact throttling** — 30 requests/hour per person
- **API key leak detection** — Scans every outgoing message, auto-redacts any exposed keys
- **Anomaly detection** — Flags unusual spikes in activity
- **WhatsApp alerts** — Messages you immediately when limits are hit
- Say *"guardian status"* to check current spend and request counts

### Self-Check

Automated health monitoring and cleanup that runs every 3 days:
- Process health, RAM/swap/disk monitoring
- Database integrity checks (SQLite PRAGMA)
- Config validation, security audit (npm vulnerabilities, file permissions)
- Knowledge file verification
- Auto-cleanup: old screenshots, video temp files, pm2 logs, stale sessions, old telemetry
- Alerts you on WhatsApp only if critical issues are found

---

## WhatsApp Commands

```
/status         Show bot status (memory, model, uptime)
/memory         See what your bot remembers
/model gpt-4o   Switch AI model
/crons          View scheduled tasks
/clear          Clear conversation history
/reload         Reload config without restarting
/help           See all commands
```

---

## Customize your bot

After setup, you can personalize:

- **`config.json`** — Change the bot name, model, limits, and settings
- **`knowledge/*.md`** — Add knowledge files (your bot reads these as expertise)
  - `identity.md` — Who your bot is, its personality
  - `soul.md` — Core values and behavioral boundaries
  - `goals.md` — What your bot is working toward
  - `relationships.md` — People it should know about
  - `user.md` — Info about you (the operator)
  - `playbook.md` — How your bot should handle specific situations

### Guardian limits

Add to `config.json` to customize rate limits:

```json
"guard": {
  "maxDailySpend": 10.00,
  "maxHourlyRequests": 200,
  "maxDailyRequests": 1000,
  "maxPerContact": 50,
  "alertThreshold": 0.7
}
```

---

## Helper scripts

```bash
./status.sh     # Check if bot is running, uptime, memory, server health
./update.sh     # Pull latest updates and restart the bot
./relink.sh     # Re-scan QR code if WhatsApp disconnects
```

---

## Architecture

```
favor.js       — Main bot: WhatsApp connection, message handling, tool loop
router.js      — AI router: classifies messages and picks the best model
db.js          — SQLite database (memory, sessions, topics, crons, guard logs)
compactor.js   — Summarizes old messages to save context space
cron.js        — Scheduled task engine
vault.js       — AES-256 encrypted storage for sensitive data
browser.js     — Headless browser automation (Puppeteer)
video.js       — Video download, transcription, and analysis
build-mode.js  — Claude Code CLI integration for building software
guardian.js    — Security framework: code scanning + runtime protection
guardian/      — Guardian QA engine (validators, analyzers, reporters)
selfcheck.js   — Automated health monitoring and cleanup
sync.js        — State sync between bot and external tools
uiux.js        — UI/UX design system engine
watchdog.js    — Health monitoring and auto-recovery
```

---

## License

MIT — do whatever you want with it.
