// ─── ALIVE: PERSONALITY GROWTH ───
// Daily self-reflection on communication style + operator feedback learning.
// Discovers traits, patterns, and preferences. Feeds back into buildMemoryPrompt().

const { runCLI, isAvailable } = require('../utils/claude');

function runClaudeHaiku(prompt, timeoutMs = 45000) {
  if (!isAvailable()) return Promise.reject(new Error('Claude Code CLI not installed'));
  return runCLI(prompt, { model: 'haiku', timeout: timeoutMs });
}

class Personality {
  constructor(engine) {
    this.engine = engine;
  }

  ensureCrons(existingLabels) {
    const created = [];
    if (!existingLabels.includes('alive:personality_reflect')) {
      this.engine.db.createCron(
        this.engine.operatorContact,
        'alive:personality_reflect',
        'daily 6:00', // 1 AM EST — reflect while operator sleeps
        JSON.stringify({
          type: 'alive:personality_reflect',
          prompt: 'Daily personality self-reflection — analyze recent conversations for communication patterns.'
        })
      );
      created.push('personality_reflect');
    }
    return created;
  }

  async handle(cron, taskData) {
    console.log('[ALIVE] Personality reflection starting');
    const db = this.engine.db;
    const rawDb = db.db || db;

    // Pull last 24h of operator conversations
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').substring(0, 19);

    let sessions;
    try {
      sessions = rawDb.prepare(
        "SELECT messages FROM sessions WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 5"
      ).all(windowStart);
    } catch (err) {
      console.warn('[ALIVE] Personality: DB error:', err.message);
      return;
    }

    if (!sessions.length) {
      console.log('[ALIVE] Personality: no recent conversations');
      return;
    }

    // Extract bot's responses and user messages
    let botMessages = [];
    let userMessages = [];
    for (const session of sessions) {
      try {
        const msgs = JSON.parse(session.messages || '[]');
        for (const msg of msgs) {
          if (msg.role === 'assistant' && msg.content && typeof msg.content === 'string') {
            botMessages.push(msg.content.slice(0, 400));
          }
          if (msg.role === 'user' && msg.content && typeof msg.content === 'string') {
            userMessages.push(msg.content.slice(0, 200));
          }
        }
      } catch (_) {}
    }

    if (botMessages.length < 3) {
      console.log('[ALIVE] Personality: too few messages to reflect on');
      return;
    }

    botMessages = botMessages.slice(0, 25);
    userMessages = userMessages.slice(0, 15);

    // Get existing personality memories for continuity
    const existing = rawDb.prepare(
      "SELECT content FROM memories WHERE category = 'personality' ORDER BY created_at DESC LIMIT 10"
    ).all();
    const existingText = existing.map(m => m.content).join('\n');

    // Check for operator tone feedback in recent messages
    const feedbackPatterns = /\b(too formal|too casual|don't|stop|love when you|perfect|exactly|good tone|wrong tone|be more|be less|sounds weird|sounds good|that's you|not you)\b/i;
    const feedbackMsgs = userMessages.filter(m => feedbackPatterns.test(m));

    const systemPrompt = this.engine.getSystemPrompt();

    const prompt = `${systemPrompt}

[SYSTEM: Daily Personality Reflection — analyze how you've been communicating]

Here are your recent messages to your operator:
${botMessages.map((m, i) => `[${i + 1}] ${m}`).join('\n\n')}

${feedbackMsgs.length ? `Operator's tone feedback (pay close attention):\n${feedbackMsgs.map(m => `> ${m}`).join('\n')}\n` : ''}
${existingText ? `Your existing personality observations:\n${existingText}\n` : 'No personality observations yet — this is your first reflection.'}

Reflect honestly on your communication style. Look for:
1. **NEW traits** you haven't noted before — humor style, formality, how you handle bad news, quirks, catchphrases
2. **Patterns** — message structure, emoji usage, how you open/close, level of detail
3. **What landed** — messages that felt natural vs forced
4. **Growth** — how you're different from a week ago
${feedbackMsgs.length ? '5. **Operator feedback** — what they are telling you about your tone (this is HIGHEST priority)' : ''}

Be specific and honest. "I'm helpful" is useless. "I default to bullet points when listing more than 2 things" is useful.

Return ONLY valid JSON:
{"observations":[{"type":"trait|pattern|feedback|growth","observation":"specific finding","evidence":"quote or example"}],"insight":"one sentence about who you are right now"}

If nothing new to observe, return: {"observations":[],"insight":"SKIP"}`;

    let result;
    try {
      const raw = await runClaudeHaiku(prompt, 45000);
      const jsonMatch = (raw || '').match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      result = JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.error('[ALIVE] Personality reflection failed:', err.message);
      return;
    }

    if (!result.observations?.length || result.insight === 'SKIP') {
      console.log('[ALIVE] Personality: nothing new observed');
      return;
    }

    // Save observations as personality memories
    let saved = 0;
    for (const obs of result.observations.slice(0, 5)) {
      try {
        const content = `[${obs.type}] ${obs.observation}${obs.evidence ? ' — e.g. "' + obs.evidence.slice(0, 100) + '"' : ''}`;
        const similar = db.findSimilar?.('personality', content);
        if (similar?.length > 0) continue;
        db.save('personality', content);
        saved++;
      } catch (_) {}
    }

    if (result.insight && result.insight !== 'SKIP') {
      try {
        db.save('personality', `[insight] ${result.insight}`);
        saved++;
      } catch (_) {}
    }

    if (saved > 0) {
      console.log(`[ALIVE] Personality: ${saved} new observations saved`);
      db.audit('alive.personality', `observations=${saved} insight="${(result.insight || '').slice(0, 100)}"`);
    }

    return { saved, insight: result.insight };
  }
}

module.exports = Personality;
