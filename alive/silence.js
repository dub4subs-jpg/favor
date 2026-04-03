// ─── ALIVE: SILENCE DETECTION ───
// Checks if the operator has gone quiet during normal hours.
// If 6+ hours without messaging, drops a casual check-in.

const { runCLI, isAvailable } = require('../utils/claude');

function runClaudeHaiku(prompt, timeoutMs = 30000) {
  if (!isAvailable()) return Promise.reject(new Error('Claude Code CLI not installed'));
  return runCLI(prompt, { model: 'haiku', timeout: timeoutMs });
}

class Silence {
  constructor(engine) {
    this.engine = engine;
    this._lastSilenceCheckin = 0;
    this.SILENCE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
    this.COOLDOWN_MS = 12 * 60 * 60 * 1000; // Max one per 12h
    this.WAKING_HOURS = { start: 9, end: 23 }; // in configured timezone
  }

  ensureCrons(existingLabels) {
    const created = [];
    if (!existingLabels.includes('alive:silence_check')) {
      this.engine.db.createCron(
        this.engine.operatorContact,
        'alive:silence_check',
        'every 2h',
        JSON.stringify({
          type: 'alive:silence_check',
          prompt: 'Check if operator has been quiet and send a casual check-in if needed.'
        })
      );
      created.push('silence_check');
    }
    return created;
  }

  async handle(cron, taskData) {
    // Cooldown — max one silence check-in per 12h
    if (Date.now() - this._lastSilenceCheckin < this.COOLDOWN_MS) return;

    // Only during waking hours (EST)
    const estHour = new Date().toLocaleString('en-US', { timeZone: this.engine.timezone, hour: 'numeric', hour12: false });
    const hour = parseInt(estHour);
    if (hour < this.WAKING_HOURS.start || hour >= this.WAKING_HOURS.end) return;

    // Check last message from operator via audit trail + session fallback
    const operatorJid = this.engine.toJid(cron.contact);
    let lastMsgTime = 0;
    try {
      // Check audit trail for last inbound message
      const lastInbound = this.engine.db.db.prepare(
        "SELECT created_at FROM audit_log WHERE action LIKE '%inbound%' OR action LIKE '%message.in%' OR (action = 'message' AND details LIKE ?) ORDER BY created_at DESC LIMIT 1"
      ).get(`%${cron.contact}%`);
      if (lastInbound) {
        lastMsgTime = new Date(lastInbound.created_at).getTime();
      }

      // Fallback: parse user messages from session
      if (!lastMsgTime) {
        const session = this.engine.db.db.prepare(
          "SELECT messages FROM sessions WHERE contact = ? ORDER BY updated_at DESC LIMIT 1"
        ).get(operatorJid);
        if (session) {
          try {
            const msgs = JSON.parse(session.messages);
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'user') {
                lastMsgTime = msgs[i].timestamp ? new Date(msgs[i].timestamp).getTime() : 0;
                break;
              }
            }
          } catch {}
        }
      }

      // Last resort: skip if any alive module fired recently
      if (!lastMsgTime) {
        const lastAlive = this.engine.db.db.prepare(
          "SELECT created_at FROM audit_log WHERE action LIKE 'alive.%' ORDER BY created_at DESC LIMIT 1"
        ).get();
        if (lastAlive) {
          const aliveAge = Date.now() - new Date(lastAlive.created_at).getTime();
          if (aliveAge < this.SILENCE_THRESHOLD_MS) return;
        }
      }
    } catch (err) {
      console.warn('[ALIVE] Silence check DB error:', err.message);
      return;
    }

    if (!lastMsgTime) return;

    const silenceDuration = Date.now() - lastMsgTime;
    if (silenceDuration < this.SILENCE_THRESHOLD_MS) return;

    const silenceHours = Math.round(silenceDuration / (1000 * 60 * 60));
    console.log(`[ALIVE] Operator silent for ${silenceHours}h — generating check-in`);

    const systemPrompt = this.engine.getSystemPrompt();
    const prompt = `${systemPrompt}

[SYSTEM: Silence check-in — operator hasn't messaged in ${silenceHours} hours]

Your operator hasn't messaged you in ${silenceHours} hours. It's ${new Date().toLocaleString('en-US', { timeZone: this.engine.timezone, hour: 'numeric', minute: '2-digit', hour12: true })}.

Send a casual, natural check-in. NOT a productivity nudge. Just a "hey, how's it going" vibe. Examples of good tone:
- "Yo, been quiet today — everything good?"
- "Haven't heard from you in a minute, hope you're having a solid day"
- "Just checking in — need anything?"

Keep it to 1 sentence. Don't mention the exact time you've been silent. Don't be needy.
If you JUST sent a morning/evening check-in within the last 2 hours, respond with: SKIP`;

    let reply = '';
    try {
      reply = (await runClaudeHaiku(prompt)) || '';
    } catch (err) {
      console.error('[ALIVE] Silence check-in failed:', err.message);
      return;
    }

    if (!reply || reply.includes('SKIP')) {
      console.log('[ALIVE] Silence check-in skipped');
      return;
    }

    if (this.engine.notifQueue) {
      this.engine.notifQueue.queue(cron.contact, reply, { source: 'silence' });
    } else {
      const jid = this.engine.toJid(cron.contact);
      await this.engine.sock.sendMessage(jid, { text: reply });
    }

    this._lastSilenceCheckin = Date.now();
    console.log(`[ALIVE] Sent silence check-in (${reply.length} chars, ${silenceHours}h silent)`);
    this.engine.db.audit('alive.silence', `hours_silent=${silenceHours} chars=${reply.length}`);
  }
}

module.exports = Silence;
