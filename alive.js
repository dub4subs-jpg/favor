// ─── ALIVE ENGINE ───
// Makes Favor feel alive: proactive check-ins + memory callbacks
// Plugs into the existing cron system via special task types
//
// Enable in config.json:
//   "alive": {
//     "enabled": true,
//     "morningCheckin": "09:00",   (local time in 24h format — converted to UTC internally)
//     "eveningCheckin": "21:00",
//     "memoryCallbackHours": 8    (how often to scan for callback-worthy memories)
//   }

class AliveEngine {
  constructor(db, openai, opts = {}) {
    this.db = db;
    this.openai = openai;
    this.modelId = opts.modelId || 'gpt-4o';
    this.maxTokens = opts.maxTokens || 300;
    this.operatorContact = opts.operatorContact || '';
    this.botName = opts.botName || 'Favor';
    this.buildSystemPrompt = opts.buildSystemPrompt || null;
    this.sock = null;

    // Schedule config (UTC hours — caller should convert from local if needed)
    this.morningHour = opts.morningHourUTC ?? 14;  // 9 AM EST default
    this.eveningHour = opts.eveningHourUTC ?? 2;   // 9 PM EST default
    this.callbackIntervalHours = opts.callbackIntervalHours ?? 8;

    // Callback cooldowns — avoid re-surfacing same memory too soon
    this._recentCallbacks = new Map(); // memoryId -> timestamp
    this.CALLBACK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

    console.log('[ALIVE] Engine initialized');
  }

  setSock(sock) {
    this.sock = sock;
  }

  // ─── REGISTER CRONS (idempotent) ───
  ensureCrons() {
    if (!this.operatorContact) {
      console.warn('[ALIVE] No operator contact set — skipping cron registration');
      return { registered: false, reason: 'no operator contact' };
    }

    const existing = this.db.getCrons(this.operatorContact);
    const labels = existing.map(c => c.label);

    if (!labels.includes('alive:morning_checkin')) {
      this.db.createCron(
        this.operatorContact,
        'alive:morning_checkin',
        `daily ${this.morningHour}:00`,
        JSON.stringify({
          type: 'alive:checkin',
          style: 'morning',
          prompt: 'Good morning check-in. Be warm but brief. Mention one thing from memory that\'s relevant today — a pending task, something they mentioned yesterday, or an upcoming deadline. If nothing specific, share a quick motivational thought or interesting observation. Keep it to 2-3 sentences max. Feel natural, not robotic.'
        })
      );
      console.log('[ALIVE] Created morning check-in cron');
    }

    if (!labels.includes('alive:evening_checkin')) {
      this.db.createCron(
        this.operatorContact,
        'alive:evening_checkin',
        `daily ${this.eveningHour}:00`,
        JSON.stringify({
          type: 'alive:checkin',
          style: 'evening',
          prompt: 'Evening wind-down. Be chill and low-key. Briefly recap what got done today if you know, or just check in casually. If nothing happened today, keep it very short — like "quiet day, hope you\'re good" vibes. 1-2 sentences max. Never feel forced.'
        })
      );
      console.log('[ALIVE] Created evening check-in cron');
    }

    if (!labels.includes('alive:memory_callback')) {
      this.db.createCron(
        this.operatorContact,
        'alive:memory_callback',
        `every ${this.callbackIntervalHours}h`,
        JSON.stringify({
          type: 'alive:memory_callback',
          prompt: 'Scan memories for something worth bringing up — a follow-up on a task, a decision that needs revisiting, something learned that connects to current work, or a preference that hasn\'t been acted on. Only surface genuinely useful callbacks, not noise.'
        })
      );
      console.log('[ALIVE] Created memory callback cron');
    }

    return { registered: true };
  }

  // ─── REMOVE CRONS (for disable) ───
  removeCrons() {
    const existing = this.db.getCrons(this.operatorContact);
    let removed = 0;
    for (const cron of existing) {
      if (cron.label.startsWith('alive:')) {
        this.db.deleteCron(cron.id);
        removed++;
      }
    }
    if (removed) console.log(`[ALIVE] Removed ${removed} alive crons`);
    return { removed };
  }

  // ─── HANDLE ALIVE CRON TRIGGERS ───
  async handleTrigger(cron, taskData) {
    if (!this.sock) {
      console.warn('[ALIVE] No socket — skipping');
      return;
    }

    if (taskData.type === 'alive:checkin') {
      return this._handleCheckin(cron, taskData);
    }
    if (taskData.type === 'alive:memory_callback') {
      return this._handleMemoryCallback(cron, taskData);
    }

    console.warn(`[ALIVE] Unknown alive type: ${taskData.type}`);
  }

  // ─── CHECK-IN ───
  async _handleCheckin(cron, taskData) {
    const style = taskData.style || 'morning';
    console.log(`[ALIVE] ${style} check-in firing`);

    const context = this._gatherContext(style);
    const systemPrompt = this.buildSystemPrompt
      ? this.buildSystemPrompt(this.operatorContact)
      : `You are ${this.botName}, a WhatsApp AI companion. Be natural, warm, and concise.`;

    const response = await this.openai.chat.completions.create({
      model: this.modelId,
      max_tokens: this.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `[SYSTEM: Alive check-in — ${style}]\n\n${taskData.prompt}\n\n${context}\n\nIMPORTANT: Write your message directly — no labels, no prefixes, no "[Morning Check-in]" headers. Just talk naturally like you're texting a friend. If there's truly nothing to say, respond with exactly: SKIP`
        }
      ]
    });

    const reply = response.choices?.[0]?.message?.content?.trim() || '';

    if (!reply || reply === 'SKIP' || reply.includes('SKIP')) {
      console.log(`[ALIVE] ${style} check-in skipped (nothing to say)`);
      return;
    }

    const jid = this._toJid(cron.contact);
    await this.sock.sendMessage(jid, { text: reply });
    console.log(`[ALIVE] Sent ${style} check-in (${reply.length} chars)`);
    this.db.audit('alive.checkin', `style=${style} chars=${reply.length}`);
  }

  // ─── MEMORY CALLBACK ───
  async _handleMemoryCallback(cron, taskData) {
    console.log('[ALIVE] Memory callback scan starting');

    const candidate = this._findCallbackCandidate();
    if (!candidate) {
      console.log('[ALIVE] No callback-worthy memories found');
      return;
    }

    // Check cooldown
    const lastSent = this._recentCallbacks.get(candidate.id);
    if (lastSent && Date.now() - lastSent < this.CALLBACK_COOLDOWN_MS) {
      console.log(`[ALIVE] Memory #${candidate.id} on cooldown — skipping`);
      return;
    }

    const systemPrompt = this.buildSystemPrompt
      ? this.buildSystemPrompt(this.operatorContact)
      : `You are ${this.botName}, a WhatsApp AI companion. Be natural, warm, and concise.`;

    const response = await this.openai.chat.completions.create({
      model: this.modelId,
      max_tokens: this.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `[SYSTEM: Memory callback]\n\nYou remembered something worth bringing up. Here's the memory:\n\nCategory: ${candidate.category}\nSaved: ${candidate.created_at}\nContent: ${candidate.content}\n${candidate.status ? `Status: ${candidate.status}` : ''}\n\nBring this up naturally in a short message. Connect it to what the operator might be doing now. Examples:\n- "Hey, remember when you mentioned [X]? Just thinking — have you followed up on that?"\n- "That [task] from last week — still on the radar?"\n- "Random thought: you saved [this decision] a while back. Still feeling good about it?"\n\nKeep it to 1-3 sentences. Be casual, not formal. If this memory is stale or irrelevant, respond with exactly: SKIP`
        }
      ]
    });

    const reply = response.choices?.[0]?.message?.content?.trim() || '';

    if (!reply || reply === 'SKIP' || reply.includes('SKIP')) {
      console.log(`[ALIVE] Memory #${candidate.id} callback skipped (AI decided not relevant)`);
      return;
    }

    const jid = this._toJid(cron.contact);
    await this.sock.sendMessage(jid, { text: reply });
    this._recentCallbacks.set(candidate.id, Date.now());
    console.log(`[ALIVE] Sent memory callback — memory #${candidate.id} (${reply.length} chars)`);
    this.db.audit('alive.callback', `memory_id=${candidate.id} category=${candidate.category} chars=${reply.length}`);

    this._pruneCooldowns();
  }

  // ─── CONTEXT GATHERING ───
  _gatherContext(style) {
    const parts = [];

    // Recent memories
    const cutoffHours = style === 'morning' ? 48 : 24;
    const recentMemories = this._getRecentMemories(cutoffHours);
    if (recentMemories.length) {
      parts.push(`Recent memories (last ${cutoffHours}h):\n${recentMemories.map(m => `- [${m.category}] ${m.content}`).join('\n')}`);
    }

    // Open threads
    const threads = this.db.getOpenThreads(this.operatorContact, 3);
    if (threads.length) {
      parts.push(`Open threads:\n${threads.map(t => `- ${t.summary}`).join('\n')}`);
    }

    // Pending tasks
    const tasks = this.db.getByCategory('task', 5).filter(t => t.status === 'pending' || t.status === 'active');
    if (tasks.length) {
      parts.push(`Pending tasks:\n${tasks.map(t => `- ${t.content} (${t.status || 'pending'})`).join('\n')}`);
    }

    // Day/time
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    parts.push(`Current: ${dayNames[now.getUTCDay()]}, ${now.toUTCString()}`);

    return parts.join('\n\n') || 'No recent context available.';
  }

  // ─── FIND CALLBACK-WORTHY MEMORY ───
  _findCallbackCandidate() {
    // Priority:
    // 1. Pending/active tasks (follow-up worthy)
    // 2. Decisions from 3-14 days ago (worth revisiting)
    // 3. Facts/workflows from 7-30 days ago (might connect to current work)

    const tasks = this.db.getByCategory('task', 20);
    const pendingTasks = tasks.filter(t =>
      (t.status === 'pending' || t.status === 'active') &&
      !this._isOnCooldown(t.id)
    );
    if (pendingTasks.length) {
      return pendingTasks[pendingTasks.length - 1]; // oldest = most likely forgotten
    }

    const decisions = this.db.getByCategory('decision', 20);
    const recentDecisions = decisions.filter(d => {
      const age = this._ageDays(d.created_at);
      return age >= 3 && age <= 14 && !this._isOnCooldown(d.id);
    });
    if (recentDecisions.length) {
      return recentDecisions[Math.floor(Math.random() * recentDecisions.length)];
    }

    const facts = this.db.getByCategory('fact', 30);
    const workflows = this.db.getByCategory('workflow', 20);
    const older = [...facts, ...workflows].filter(m => {
      const age = this._ageDays(m.created_at);
      return age >= 7 && age <= 30 && !this._isOnCooldown(m.id);
    });
    if (older.length) {
      return older[Math.floor(Math.random() * older.length)];
    }

    return null;
  }

  // ─── HELPERS ───
  _getRecentMemories(hours) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    try {
      return this.db.db.prepare(
        "SELECT * FROM memories WHERE created_at >= ? ORDER BY created_at DESC LIMIT 10"
      ).all(cutoff);
    } catch (e) {
      return [];
    }
  }

  _ageDays(dateStr) {
    return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
  }

  _isOnCooldown(memId) {
    const lastSent = this._recentCallbacks.get(memId);
    return lastSent && Date.now() - lastSent < this.CALLBACK_COOLDOWN_MS;
  }

  _pruneCooldowns() {
    for (const [id, ts] of this._recentCallbacks.entries()) {
      if (Date.now() - ts > this.CALLBACK_COOLDOWN_MS) {
        this._recentCallbacks.delete(id);
      }
    }
  }

  _toJid(contact) {
    return contact.replace('+', '').replace('@c.us', '').replace('@s.whatsapp.net', '') + '@s.whatsapp.net';
  }
}

module.exports = AliveEngine;
