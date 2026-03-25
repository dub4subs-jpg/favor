# Favor

**Your own AI companion bot.** Works on **Telegram** or **WhatsApp**. Clone it, run one command, and you're live.

Favor gives you a personal AI assistant with memory, multi-model routing, browser automation, an encrypted vault, video analysis, a built-in software builder, and Guardian — a security and QA framework that protects your bot and any project it manages.

---

## Setup (5 minutes)

You need a **Linux server** (or DigitalOcean droplet), an **OpenAI API key**, and a **Claude Pro or Max subscription**.

### 1. Create a server

- Go to [digitalocean.com](https://www.digitalocean.com) and sign up
- Click **Create** → **Droplets**
- Choose **Ubuntu 22.04**, pick the **$48/mo** plan (2 vCPU / 8GB RAM) for the full experience
- Smaller plans work too — $12/mo (2GB RAM) handles core features, but video processing and browser automation may be limited
- Once it's ready, click on it and hit the **Console** button (opens a terminal in your browser)

### 2. Run one command

Paste this into the terminal:

```bash
git clone https://github.com/dub4subs-jpg/favor.git && cd favor && bash setup.sh
```

The setup script will:
- Ask if you want **Telegram** (recommended) or **WhatsApp**
- Install everything automatically (Node.js, pm2, tmux, ffmpeg, Chromium, yt-dlp, faster-whisper, edge-tts, and all npm dependencies)
- Install Claude Code CLI and prompt you to log in
- Ask you a few questions (bot name, API keys, etc.)
- Optionally set up Gmail (for email features)
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
| DigitalOcean server | [digitalocean.com](https://www.digitalocean.com) | $48/mo recommended, $12/mo minimum |
| Claude Code subscription | [claude.ai](https://claude.ai) | **Required** — Pro ($20/mo) or Max ($100/mo) |
| OpenAI API key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Pay-per-use (~$5-20/mo) |
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free (optional) |
| Brave Search key | [brave.com/search/api](https://brave.com/search/api/) | Free tier (optional) |
| Gmail OAuth credentials | [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) | Free (optional, for email features) |

**Claude Code** and **OpenAI** are both required. The setup script installs everything else automatically — Node.js, pm2, tmux, ffmpeg, Chromium, yt-dlp, faster-whisper, edge-tts, and all npm dependencies. You just need the server and API keys.

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

- **Morning intelligence brief** — Structured daily briefing: yesterday's recap, today's schedule, pending tasks, open threads, actionable signals
- **Evening wind-down** — Casual end-of-day recap or just vibes if nothing happened
- **Memory callbacks** — Periodically resurfaces forgotten tasks, old decisions worth revisiting, or facts that connect to what you're doing now
- **Notification batching** — Multiple proactive messages within 2 minutes get combined into one message instead of spamming you

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

### Claude Code CLI (Required)

Claude Code CLI is the brain that makes Favor feel like a real companion, not just a chatbot. **Most of your conversations route through Claude** instead of GPT-4o — including casual chat, Q&A, engineering tasks, mini responses, and even image analysis. This runs on your Claude subscription (Pro $20/mo or Max $100/mo), so there's **no extra per-message API cost**.

It also powers Build Mode (software building from chat) and Remote Code Sessions (code on your server from your phone).

**The setup script installs it automatically.** You just need to log in when prompted. If you need to install manually:
```bash
curl -fsSL https://claude.ai/install.sh | sh
claude login
```

**Memory Bridge:** If you also use Claude Code interactively on your server (e.g. `claude` in the terminal for coding or research), your bot automatically learns from those sessions. Claude Code saves memories to `~/.claude/` — the Memory Bridge scans those files every 2 minutes and imports them into your bot's brain. This means your bot and Claude Code share the same understanding of who you are, your preferences, and your projects. The more you use Claude Code, the smarter your bot gets.

### Build Mode
Tell your bot to build software and it shells out to **Claude Code CLI** to do the actual coding.

- `build_plan` — Describe what you want, get a phased build plan
- `build_execute` — Execute each phase step by step (Claude Code writes the code)
- `build_verify` — Verify the build against your requirements
- `build_raw` — Freeform Claude Code commands for quick fixes

Say things like *"build me a todo app with React"* or *"build a price tracker"* — your bot plans it, builds it, commits it.

> Requires a Claude Code subscription (Pro or Max plan). Install Claude Code CLI on your server first.

### Remote Code Sessions
Message your bot **"start remote"** and it spins up a Claude Code session on your server, then sends you a clickable link. Open the link on your phone — you're now coding on your server from anywhere, no SSH client needed.

- Say *"start remote"*, *"remote session"*, *"code from phone"*, or *"start coding"*
- Session runs in **tmux** (survives disconnects — you can close the browser and come back)
- Opens in the directory of your choice (defaults to `/root`)

**Requirements:**
- **Claude Code CLI** installed on your server (`curl -fsSL https://claude.ai/install.sh | sh`)
- **Claude Pro** ($20/mo) or **Max** ($100/mo) subscription
- **tmux** (`apt install tmux` — installed automatically by `setup.sh`)

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

### Smart Tool Selection
Your bot has 80+ tools, but most messages only need 5-10. Instead of sending all tools to the AI on every message (wasting tokens and confusing the model), Favor **pre-filters tools** based on the route + message keywords.

- Chat message "hello" → 7 core tools (memory, search, send)
- "Take a screenshot of my laptop" → core + laptop tools (~12 total)
- Tool route with browser keywords → full relevant set

**Result:** 70-90% token savings per API call. Faster responses, lower costs, fewer model mistakes.

### Self-Improvement Loop
Your bot learns from its own behavior over time.

- **Every 6 hours**, analyzes recent interactions from telemetry data
- Scores interactions (0-10) based on: tool failures, retry patterns, response time, success rate
- Sends worst interactions to Claude Haiku for behavioral lesson extraction
- Stores lessons with confidence scores — only proven lessons (reinforced multiple times) get injected into future prompts
- Stale lessons auto-retire after 30 days without reinforcement

Example lessons it might learn: *"web_search fails 40% for product lookups — use browser_navigate instead"*, *"batch vault_save calls instead of calling 8 times sequentially"*

### Knowledge Graph
Your bot doesn't just remember facts — it maps **relationships between entities**.

- Automatically extracts people, companies, products, projects from conversations
- Tracks relationships: "Jerry works_at Speedy Distribution", "Speedy supplies product X"
- Ask *"who do I do business with?"* or *"what's connected to Speedy?"* → searches the graph
- Entities are deduplicated by name and strengthen over time with repeated mentions

### Conversation Replay
Never lose a conversation to compaction again.

- **Daily digests** — At 11pm, your bot summarizes the day's conversations into a permanent record
- Digests include: topics discussed, decisions made, tasks assigned, key facts
- Ask *"what were we talking about last Tuesday?"* → searches daily digests
- Supports relative dates: "yesterday", "last monday", "march 15"
- Digests are **permanent** — they survive compaction and memory consolidation

### Passive Learning
When you forward messages, share links, or send screenshots without asking a question, your bot **silently absorbs the information** instead of trying to respond.

- Detects forwarded messages, bare URLs, and media without questions
- Extracts entities, prices, dates, contacts, products from the content
- Stores as "signals" — lower-confidence than memories, surfaced naturally when relevant
- Reacts with a 👀 emoji to acknowledge without interrupting

### Dynamic Recipes
Extend teach mode with **dynamic parameter passing** between steps.

- `$input` — the user's message text after the trigger phrase
- `$prev` — output of the previous step
- `$step[N]` — output of step N
- `$step[N].extract(url)` — extract a URL from step N's output

Example: *"research [topic]"* → web_search($input) → browser_navigate($step[0].extract(url)) → memory_save($prev)

### Conversation Threading
Your bot silently tags every message with a topic (e.g., `packaging+inventory`, `flight+medellin`).

- When you return to an old topic, relevant older messages are pulled back into context
- Compaction produces per-topic summaries instead of flat blobs
- Pure text processing — no AI call, <1ms per message
- Tags are invisible to you — they just make context smarter

### Voice Responses
When you send a voice note, your bot can reply with a voice note too.

- Uses **edge-tts** (free, no API key) or **OpenAI TTS** (paid fallback)
- Voice notes render as waveform in WhatsApp/Telegram (ptt mode)
- Falls back to text if TTS is unavailable
- Config: `"voice": { "ttsEnabled": true, "ttsVoice": "en-US-GuyNeural" }`

Install: `pip install edge-tts` (optional — text replies work without it)

### Agent Delegation
Offload heavy research to background tasks.

- Say *"research the best frameworks for building chatbots"* → spawns a Claude CLI subprocess
- Task runs in the background while you keep chatting
- Results are sent as a WhatsApp/Telegram message when done
- Max 3 concurrent background tasks
- Say *"check tasks"* to see running tasks

### Retry Engine
When a tool fails, your bot gets smart suggestions for alternatives.

- Laptop offline? → *"(Hint: try phone_screenshot as alternative)"*
- Web search failed? → *"(Hint: try browser_navigate as alternative)"*
- The AI decides whether to act on hints — keeps the model in control, not hardcoded retries

### Trust Levels
Graduate from binary operator/non-operator to 4 trust tiers:

| Level | Routes | Tools | Rate Limit |
|-------|--------|-------|------------|
| **Operator** | All | All | Unlimited |
| **Staff** | tool, hybrid, chat, mini, memory, full | All except admin (server_exec, build, guardian) | 50/hr |
| **Customer** | chat, mini, memory | web_search, memory_search, knowledge_search | 20/hr |
| **Guest** | chat only | None | 5/hr |

Configure in `config.json`:
```json
"contactPermissions": { "+1234567890": "staff" },
"trustDefaults": { "trustedContacts": "staff", "verified": "customer" }
```

### Cost Dashboard
See exactly where your money goes.

- `/costs` command → today/week/month totals, cost by model, cost by route, 7-day trend
- Tracks every OpenAI, Gemini, and Kimi API call automatically
- Visual bar chart trend in the chat

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
/costs          API cost dashboard (today/week/month)
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
memory-bridge.js        — Syncs Claude Code CLI memories into bot brain (auto, every 2m)
uiux.js                 — UI/UX design system engine
watchdog.js             — Health monitoring and auto-recovery
```

---

## License

MIT — do whatever you want with it.
