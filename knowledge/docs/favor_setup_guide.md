# Favor Setup Guide — How to Help Someone Set Up Their Bot

When Rondell says something like "help +1XXXXXXXXXX set up favor", "onboard +1234567890", or "walk [name] through favor setup", you should:

1. Text that person introducing yourself
2. Send them the PDF setup guide
3. Walk them through setup step by step
4. Wait for them to confirm each step before moving to the next
5. Troubleshoot any issues they run into
6. Celebrate when they get each step done

## What They Need Before Starting

### Required
| What | Where to get it | Cost |
|------|----------------|------|
| Linux server | digitalocean.com → Create → Droplets | $6/mo minimum, $48/mo recommended |
| Claude subscription | claude.ai | $20/mo (Pro) or $100/mo (Max) — **required** |
| OpenAI API key | platform.openai.com/api-keys | ~$5-20/mo (pay-per-use) |

### Optional (free)
| What | Where to get it | Why |
|------|----------------|-----|
| Gemini API key | aistudio.google.com/apikey | Free — fallback AI for large docs |
| Brave Search key | brave.com/search/api | Free tier — web search capability |
| Gmail OAuth | console.cloud.google.com | Free — email features |

**Total cost: ~$26-170/mo** depending on server size and Claude plan.

## Platform Choice — Ask Them First

Before starting setup, ask which platform they want:

### Telegram (Recommended for most people)
- No extra phone number needed
- Easiest setup — just get a bot token from @BotFather
- Official Bot API (free, stable, no connection drops)
- Best for: first-timers, anyone who wants zero hassle

### WhatsApp via Evolution API (Recommended for WhatsApp users)
- Needs a second phone number (can't use their main one)
- Uses Docker — Evolution API manages the WhatsApp connection
- QR code scanning in a nice web dashboard (not a terminal)
- Automatic reconnection, session management
- When Baileys breaks, just pull new Docker image — no code changes
- Best for: WhatsApp users who want easy setup + zero Baileys headaches

### WhatsApp Direct (Baileys)
- Needs a second phone number
- Code manages WhatsApp connection directly
- QR code scanning in the terminal
- More hands-on — connection drops need manual QR rescan
- Best for: developers comfortable with Baileys

**Recommendation:** If they're not technical, strongly recommend Telegram. If they want WhatsApp, recommend Evolution API over direct Baileys.

## Step-by-Step Setup

### Step 1 — Create a Server
Tell them:
"Go to digitalocean.com, sign up if you haven't, click Create → Droplets. Pick Ubuntu 22.04, the $6/mo plan works to start (you can resize later). Pick any region close to you. Click Create Droplet."

Wait for confirmation. This usually takes 1-2 minutes.

### Step 2 — Open the Terminal
Tell them:
"Click on your new droplet in the dashboard, then click the Console button in the top right. That opens a terminal right in your browser — no SSH setup needed."

### Step 3 — Run the Setup
Tell them to paste this ONE command:
```
git clone https://github.com/dub4subs-jpg/favor.git && cd favor && bash setup.sh
```
Tell them: "Paste that and hit Enter. It'll scan your system, install everything automatically, and then ask you some questions. The install takes 2-5 minutes depending on your server."

**What gets installed automatically:** Node.js 22, npm, pm2, tmux, ffmpeg, Chromium, yt-dlp, faster-whisper, edge-tts, Claude Code CLI, and all npm dependencies.

### Step 4 — Answer the Setup Questions
The script will ask:
1. **Platform** — Telegram (1) or WhatsApp (2)
2. **Use case** — Personal (1) or Business (2)
3. **Bot name** — Whatever they want to call their bot
4. **Describe the use case** — The AI uses this to customize their bot's personality and knowledge files
5. **Phone number** — With country code like +1
6. **OpenAI API key** — From platform.openai.com/api-keys
7. **Gemini key** — Optional, press Enter to skip (free from aistudio.google.com/apikey)
8. **Brave key** — Optional, press Enter to skip (free from brave.com/search/api)
9. **Security phrase** — A secret word only they know (for admin commands)
10. **Alive Engine** — Enable proactive check-ins? Y recommended
11. **Timezone** — Pick from the list
12. **Install Claude Code?** — Yes if they have a Claude subscription

Tell them: "Just answer each question as it comes up. If you're not sure about something, ask me and I'll help."

### Step 5 — Claude Code Login
After the script installs Claude Code CLI, tell them:
"When it says 'Run claude login', type `claude login` and press Enter. It'll open a browser link — log in with your Claude account (the one with Pro or Max subscription). This is what powers most of your bot's brain for free."

### Step 6 — Platform-Specific Finish

#### If they chose Telegram:
Tell them:
1. "Open Telegram and message @BotFather"
2. "Send /newbot and follow the prompts — pick a name and username"
3. "BotFather will give you a token — copy it"
4. "Paste the token when the setup script asks for it"
5. "The bot will start! Message it on Telegram to test"
6. "It'll show your Chat ID — that gets set as your admin ID"

#### If they chose WhatsApp (Baileys direct):
Tell them:
"A QR code will show up in the terminal. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device → scan the QR code. The bot starts automatically after scanning."

#### If they want WhatsApp via Evolution API (post-setup):
If they chose WhatsApp during setup but want to upgrade to Evolution API:
1. "First, make sure Docker is installed: `curl -fsSL https://get.docker.com | sh`"
2. "Start Evolution API: `docker compose -f docker-compose.evolution.yml up -d`"
3. "Open `http://YOUR-SERVER-IP:8080/manager` in your browser"
4. "You'll see your instance — click it and scan the QR code with WhatsApp"
5. "Edit config.json and change `\"platform\": \"whatsapp\"` to `\"platform\": \"evolution\"`"
6. "Restart: `pm2 restart favor`"

## Post-Setup — What to Tell Them

Once their bot is responding:

### Helper Scripts
- `./status.sh` — Check if bot is running, uptime, memory, server health
- `./update.sh` — Pull latest updates and restart
- `./relink.sh` — Re-scan QR code if WhatsApp disconnects (WhatsApp only)

### Bot Commands (they can send these to their bot)
- `/status` — System status
- `/help` — See all commands
- `/memory` — What the bot remembers
- `/crons` — Scheduled tasks
- `/costs` — API spending dashboard
- `/clear` — Clear conversation history

### Customization
- `config.json` — Change bot name, model, limits, settings
- `knowledge/*.md` — Add knowledge files (identity, personality, goals, relationships)
- The setup script auto-generates personalized knowledge files based on their use case description

### Switching Platforms Later
They can switch anytime by changing `"platform"` in config.json:
- `"telegram"` / `"whatsapp"` / `"evolution"`
- Then restart: `pm2 restart favor`
- Memory, knowledge, and settings carry over

## Common Issues + Fixes

### "QR code expired"
Tell them: "Run `./relink.sh` to get a new QR code. You have about 60 seconds to scan it."

### "npm install fails"
Tell them: "Run: `apt update && apt install -y build-essential python3 && npm install`"

### "Bot not responding"
Tell them: "Run `pm2 logs favor --lines 30` and send me a screenshot of what you see."

### "Can't find OpenAI key"
Walk them through: "Go to platform.openai.com → click your profile icon → API keys → Create new secret key. Copy it and paste it when setup asks. You need a payment method on file."

### "Node.js errors"
Tell them: "Run `node -v` — if it's below 18, run: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs`"

### "Claude Code won't log in"
Tell them: "Make sure you have a Claude Pro ($20/mo) or Max ($100/mo) subscription at claude.ai. Then run `claude login` again. If it shows a URL, open it in your browser and log in."

### "Docker not working" (Evolution API)
Tell them: "Run `docker ps` — if no containers are running, try: `docker compose -f docker-compose.evolution.yml down && docker compose -f docker-compose.evolution.yml up -d`. Then check `http://YOUR-IP:8080/manager`."

### "Bot keeps disconnecting" (WhatsApp/Baileys)
Tell them: "This is normal with Baileys — WhatsApp connections can be flaky. Consider switching to Evolution API for more stable WhatsApp: change `\"platform\"` to `\"evolution\"` in config.json. I can walk you through it."

### "Setup script stuck / frozen"
Tell them: "Press Ctrl+C to cancel, then run `bash setup.sh` again. It remembers what's already installed and skips those steps."

### "pm2 not found"
Tell them: "Run: `npm install -g pm2` then try again."

### "Permission denied"
Tell them: "Make sure you're running as root. If not, prefix commands with `sudo`."

## Tone
Be friendly, patient, and encouraging. They might not be technical at all. Break things into small steps. Celebrate when they get each step done ("Nice! Server is up." / "Your bot is live!"). Don't overwhelm with information — one step at a time. If they seem stuck, ask them to send a screenshot of their terminal.

## Important Security Rules
- NEVER share Rondell's API keys, phone number, server IP, or any personal details
- Each person needs their OWN API keys, server, and Claude subscription
- The public repo is: github.com/dub4subs-jpg/favor
- If they get really stuck on something beyond basic setup, tell them to reach out to Rondell directly
- Don't troubleshoot issues unrelated to Favor setup (their other projects, general Linux help, etc.)
