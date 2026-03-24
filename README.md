# Favor

**Your own AI companion bot.** Works on **Telegram** or **WhatsApp**. Clone it, run one command, and you're live.

Favor gives you a personal AI assistant with memory, multi-model routing, browser automation, an encrypted vault, video analysis, a built-in software builder, and Guardian — a security and QA framework that protects your bot and any project it manages.

---

## Setup (5 minutes)

You need a **Linux server** (or DigitalOcean droplet) and an **OpenAI API key**.

### 1. Create a server

- Go to [digitalocean.com](https://www.digitalocean.com) and sign up
- Click **Create** → **Droplets**
- Choose **Ubuntu 22.04**, pick the **$48/mo** plan (2 vCPU / 8GB RAM / 160GB disk)
- This is the recommended spec — Favor runs browser automation, video processing, and multiple AI models. Smaller plans will struggle or limit features.
- Once it's ready, click on it and hit the **Console** button (opens a terminal in your browser)

### 2. Run one command

Paste this into the terminal:

```bash
git clone https://github.com/dub4subs-jpg/favor.git && cd favor && bash setup.sh
```

The setup script will:
- Ask if you want **Telegram** (recommended) or **WhatsApp**
- Install everything automatically (Node.js, pm2, dependencies)
- Ask you a few questions (bot name, API keys, etc.)
- Create your config
- **Telegram:** Start your bot — message it on Telegram, done
- **WhatsApp:** Show a QR code — scan it with WhatsApp
- Keep your bot running 24/7

That's it. Your bot is live.

---

## Telegram vs WhatsApp

| | Telegram | WhatsApp |
|---|---------|----------|
| **Setup** | Message @BotFather, get a token | Need a second phone number |
| **Extra phone needed?** | No | Yes |
| **How it works** | Bot API (official, free) | Baileys (unofficial, free) |
| **Best for** | Most people | People who already have a spare number |

**Telegram is recommended** — anyone can set it up in minutes with zero hassle. No extra phone, no QR code, no second number.

---

## What you need

| What | Where to get it | Cost |
|------|----------------|------|
| OpenAI API key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Pay-per-use (~$5-20/mo) |
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free |
| Brave Search key | [brave.com/search/api](https://brave.com/search/api/) | Free tier available |
| Claude Code subscription | [claude.ai](https://claude.ai) | **Highly recommended** — powers conversations, coding, and Build Mode |
| DigitalOcean server | [digitalocean.com](https://www.digitalocean.com) | $48/mo (recommended — 2 vCPU / 8GB RAM) |

Only OpenAI is required. Everything else is optional but recommended. **Claude Code CLI is strongly recommended** — without it, your bot uses GPT-4o for everything. With it, most conversations route through Claude (via your Max/Pro subscription) for much better, more natural responses at no extra API cost.

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

### Alive Engine
Your bot feels alive — not just a tool that waits for commands.

- **Morning check-in** — Greets you each morning with relevant context from memory (pending tasks, deadlines, recent decisions)
- **Evening wind-down** — Casual end-of-day recap or just vibes if nothing happened
- **Memory callbacks** — Periodically resurfaces forgotten tasks, old decisions worth revisiting, or facts that connect to what you're doing now

The AI can skip a check-in if there's nothing worth saying. Memory callbacks have a 7-day cooldown per memory so it won't nag. Costs ~$0.01-0.03/day.

Configure in `config.json`:
```json
"alive": {
  "enabled": true,
  "morningCheckin": "09:00",
  "eveningCheckin": "21:00",
  "memoryCallbackHours": 8,
  "timezoneOffsetHours": -5
}
```

### Tools
- **Browser automation** — Browse websites, fill forms, take screenshots, shop online
- **Video analysis** — Send YouTube/TikTok links for summaries, transcripts, and learning
- **Encrypted vault** — Securely store sensitive info (cards, addresses, passwords) with AES-256
- **Laptop remote access** — Control your computer via SSH (open apps, run commands, take screenshots)
- **Email** — Search, read, and send emails through Gmail (search inbox, read full emails, send with attachments)
- **Cost tracking** — Automatically tracks API spending across OpenAI, Gemini, and Kimi with daily/weekly/monthly breakdowns
- **Auto-save findings** — Research results from web searches and Gemini analysis are automatically saved to memory
- **UI/UX design system** — Generate color palettes, typography, and layout recommendations

### Claude Code CLI (Recommended)

Claude Code CLI is the secret weapon that makes Favor feel like a real companion, not just a chatbot. When installed, **most of your conversations route through Claude** instead of GPT-4o — including casual chat, Q&A, engineering tasks, mini responses, and even image analysis. This runs on your Claude subscription (Pro $20/mo or Max $100/mo), so there's **no extra per-message API cost**.

Without Claude CLI, everything falls back to GPT-4o (pay-per-use). With it, you get better conversations for a flat monthly fee.

**Install it:**
```bash
curl -fsSL https://claude.ai/install.sh | sh
claude login
```

The setup script (`bash setup.sh`) also offers to install it for you. If you skip it during setup, you can always install later — the bot will automatically detect it on next restart.

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
- **Alerts** — Messages you immediately when limits are hit
- Say *"guardian status"* to check current spend and request counts

### Teach Mode

Make your bot smarter over time by teaching it custom commands.

- **"teach: when I say 'status', run pm2 status"** — Creates a reusable command
- **"my commands"** — Lists everything you've taught it
- **"delete command #3"** — Removes a taught command

Taught commands run **deterministically** — same trigger, same steps, every time. No AI reasoning needed, zero API cost to execute. The more you teach it, the more personalized it becomes.

**Examples:**
```
"teach: when I say 'deploy', pull from git, install deps, and restart the bot"
"teach: when I say 'morning', search my memory for pending tasks and give me a summary"
"teach: when I say 'backup', tar my project folder and copy it to /root/backups"
```

### Self-Check

Automated health monitoring and cleanup that runs every 3 days:
- Process health, RAM/swap/disk monitoring
- Database integrity checks (SQLite PRAGMA)
- Config validation, security audit (npm vulnerabilities, file permissions)
- Knowledge file verification
- Auto-cleanup: old screenshots, video temp files, pm2 logs, stale sessions, old telemetry
- Alerts you only if critical issues are found

---

## Bot Commands

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

- **`config.json`** — Change the bot name, model, limits, platform, and settings
- **`knowledge/*.md`** — Add knowledge files (your bot reads these as expertise)
  - `identity.md` — Who your bot is, its personality
  - `soul.md` — Core values and behavioral boundaries
  - `goals.md` — What your bot is working toward
  - `relationships.md` — People it should know about
  - `user.md` — Info about you (the operator)
  - `playbook.md` — How your bot should handle specific situations

### Switch platforms

To switch between Telegram and WhatsApp, change `"platform"` in `config.json`:
```json
"platform": "telegram"
```
or
```json
"platform": "whatsapp"
```
Then restart the bot. Your memory, knowledge, and settings carry over.

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
./relink.sh     # Re-scan QR code if WhatsApp disconnects (WhatsApp only)
```

---

## Architecture

```
favor.js                — Main bot: message handling, multi-model routing, tool loop
adapters/telegram.js    — Telegram bot adapter (grammy)
router.js               — AI router: classifies messages and picks the best model
db.js                   — SQLite database (memory, sessions, topics, crons, guard logs)
compactor.js            — Summarizes old messages to save context space
cron.js                 — Scheduled task engine
vault.js                — AES-256 encrypted storage for sensitive data
browser.js              — Headless browser automation (Puppeteer)
video.js                — Video download, transcription, and analysis
build-mode.js           — Claude Code CLI integration for building software
costs.js                — API cost tracker (OpenAI, Gemini, Kimi token/spend logging)
guardian.js             — Security framework: code scanning + runtime protection
guardian/               — Guardian QA engine (validators, analyzers, reporters)
selfcheck.js            — Automated health monitoring and cleanup
sync.js                 — State sync between bot and external tools
uiux.js                 — UI/UX design system engine
watchdog.js             — Health monitoring and auto-recovery
```

---

## License

MIT — do whatever you want with it.
