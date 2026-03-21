// ─── ALIVE: CHECK-INS ───
// Morning greetings and evening wind-downs

class Checkins {
  constructor(engine) {
    this.engine = engine;
  }

  // Register check-in crons (idempotent)
  ensureCrons(existingLabels) {
    const created = [];

    if (!existingLabels.includes('alive:morning_checkin')) {
      this.engine.db.createCron(
        this.engine.operatorContact,
        'alive:morning_checkin',
        `daily ${this.engine.morningHourUTC}:00`,
        JSON.stringify({
          type: 'alive:checkin',
          style: 'morning',
          prompt: 'Good morning check-in. Be warm but brief. Mention one thing from memory that\'s relevant today — a pending task, something they mentioned yesterday, or an upcoming deadline. If nothing specific, share a quick motivational thought or interesting observation. Keep it to 2-3 sentences max. Feel natural, not robotic.'
        })
      );
      created.push('morning_checkin');
    }

    if (!existingLabels.includes('alive:evening_checkin')) {
      this.engine.db.createCron(
        this.engine.operatorContact,
        'alive:evening_checkin',
        `daily ${this.engine.eveningHourUTC}:00`,
        JSON.stringify({
          type: 'alive:checkin',
          style: 'evening',
          prompt: 'Evening wind-down. Be chill and low-key. Briefly recap what got done today if you know, or just check in casually. If nothing happened today, keep it very short — like "quiet day, hope you\'re good" vibes. 1-2 sentences max. Never feel forced.'
        })
      );
      created.push('evening_checkin');
    }

    return created;
  }

  // Handle a check-in trigger
  async handle(cron, taskData) {
    const style = taskData.style || 'morning';
    console.log(`[ALIVE] ${style} check-in firing`);

    const context = this._gatherContext(style);
    const systemPrompt = this.engine.getSystemPrompt();

    const response = await this.engine.openai.chat.completions.create({
      model: this.engine.modelId,
      max_tokens: this.engine.maxTokens,
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

    const jid = this.engine.toJid(cron.contact);
    await this.engine.sock.sendMessage(jid, { text: reply });
    console.log(`[ALIVE] Sent ${style} check-in (${reply.length} chars)`);
    this.engine.db.audit('alive.checkin', `style=${style} chars=${reply.length}`);
  }

  // Gather context for personalized check-ins
  _gatherContext(style) {
    const e = this.engine;
    const parts = [];

    // Recent memories
    const cutoffHours = style === 'morning' ? 48 : 24;
    const cutoff = new Date(Date.now() - cutoffHours * 60 * 60 * 1000).toISOString();
    try {
      const recent = e.db.db.prepare(
        "SELECT * FROM memories WHERE created_at >= ? ORDER BY created_at DESC LIMIT 10"
      ).all(cutoff);
      if (recent.length) {
        parts.push(`Recent memories (last ${cutoffHours}h):\n${recent.map(m => `- [${m.category}] ${m.content}`).join('\n')}`);
      }
    } catch (_) {}

    // Open threads
    const threads = e.db.getOpenThreads(e.operatorContact, 3);
    if (threads.length) {
      parts.push(`Open threads:\n${threads.map(t => `- ${t.summary}`).join('\n')}`);
    }

    // Pending tasks
    const tasks = e.db.getByCategory('task', 5).filter(t => t.status === 'pending' || t.status === 'active');
    if (tasks.length) {
      parts.push(`Pending tasks:\n${tasks.map(t => `- ${t.content} (${t.status || 'pending'})`).join('\n')}`);
    }

    // Day/time
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    parts.push(`Current: ${dayNames[now.getDay()]}, ${now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true })}`);

    return parts.join('\n\n') || 'No recent context available.';
  }
}

module.exports = Checkins;
