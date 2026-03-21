# Favor

**Your own AI WhatsApp bot.** Clone it, run one command, scan a QR code — done.

Favor gives you a personal AI assistant on WhatsApp with memory, web search, voice messages, image understanding, scheduled reminders, and multi-model routing (GPT-4o, Claude, Gemini).

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
| DigitalOcean server | [digitalocean.com](https://www.digitalocean.com) | $6/mo |

Only OpenAI is required. Gemini and Brave are optional but recommended.

---

## Features

- **Multi-model AI** — Routes messages to GPT-4o, Gemini, or Claude depending on the task
- **Memory** — Remembers facts, preferences, and past conversations
- **Voice messages** — Send voice notes, get text replies (or vice versa)
- **Vision** — Send photos and it can see/analyze them
- **Web search** — Searches the internet via Brave Search
- **Scheduled tasks** — Set reminders, recurring messages, check-ins
- **Browser automation** — Can browse websites, fill forms, take screenshots
- **Video analysis** — Send YouTube/TikTok links for summaries and transcripts
- **Encrypted vault** — Securely store sensitive info (cards, addresses, passwords)
- **Knowledge base** — Load custom markdown files to give your bot expertise
- **Conversation compaction** — Summarizes old messages so it never runs out of context

---

## Customize your bot

After setup, you can personalize:

- **`config.json`** — Change the bot name, model, and settings
- **`knowledge/*.md`** — Add knowledge files (your bot reads these as expertise)
  - `identity.md` — Who your bot is, its personality
  - `goals.md` — What your bot is working toward
  - `relationships.md` — People it should know about
  - `user.md` — Info about you (the operator)

---

## Helper scripts

Run these from your server terminal:

```bash
./status.sh     # Check if bot is running, uptime, memory, server health
./update.sh     # Pull latest updates and restart the bot
./relink.sh     # Re-scan QR code if WhatsApp disconnects
```

Or text these commands to your bot on WhatsApp:

```
/status         Show bot status
/update         Update to latest version (bot restarts automatically)
/memory         See what your bot remembers
/model gpt-4o   Switch AI model
/help           See all commands
```

---

## Architecture

```
favor.js       — Main bot: WhatsApp connection, message handling, tool loop
router.js      — AI model router: classifies messages and picks the best model
db.js          — SQLite database (memory, sessions, topics, crons)
compactor.js   — Summarizes old messages to save context space
cron.js        — Scheduled task engine
vault.js       — AES-encrypted storage for sensitive data
browser.js     — Headless browser automation (Puppeteer)
video.js       — Video download, transcription, and analysis
sync.js        — State sync between bot and external tools
watchdog.js    — Health monitoring and auto-recovery
monitor.js     — Log analysis and improvement suggestions
```

---

## License

MIT — do whatever you want with it.
