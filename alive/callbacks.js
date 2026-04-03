// ─── ALIVE: MEMORY CALLBACKS ───
// Resurfaces forgotten tasks, old decisions, and relevant facts

const { runCLI, isAvailable } = require('../utils/claude');

// Optional Oura health integration
let oura = null;
try { oura = require('../oura'); } catch (_) {}

function runClaudeHaiku(prompt, timeoutMs = 30000) {
  if (!isAvailable()) return Promise.reject(new Error('Claude Code CLI not installed'));
  return runCLI(prompt, { model: 'haiku', timeout: timeoutMs });
}

class Callbacks {
  constructor(engine) {
    this.engine = engine;
    this._recentCallbacks = new Map(); // memoryId -> timestamp
    this.COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  // Register callback cron (idempotent)
  ensureCrons(existingLabels) {
    const created = [];

    if (!existingLabels.includes('alive:memory_callback')) {
      this.engine.db.createCron(
        this.engine.operatorContact,
        'alive:memory_callback',
        `every ${this.engine.callbackIntervalHours}h`,
        JSON.stringify({
          type: 'alive:memory_callback',
          prompt: 'Scan memories for something worth bringing up — a follow-up on a task, a decision that needs revisiting, something learned that connects to current work, or a preference that hasn\'t been acted on. Only surface genuinely useful callbacks, not noise.'
        })
      );
      created.push('memory_callback');
    }

    return created;
  }

  // Handle a memory callback trigger
  async handle(cron, taskData) {
    console.log('[ALIVE] Memory callback scan starting');

    const candidate = this._findCandidate();
    if (!candidate) {
      console.log('[ALIVE] No callback-worthy memories found');
      return;
    }

    // Check cooldown
    const lastSent = this._recentCallbacks.get(candidate.id);
    if (lastSent && Date.now() - lastSent < this.COOLDOWN_MS) {
      console.log(`[ALIVE] Memory #${candidate.id} on cooldown — skipping`);
      return;
    }

    const systemPrompt = this.engine.getSystemPrompt();

    // Fetch Oura readiness to modulate callback urgency
    let healthNote = '';
    try {
      if (oura?.getToken?.()) {
        const health = await oura.getHealthSummary(1);
        if (health.readiness?.score) {
          if (health.readiness.score < 60) healthNote = '\n⚠️ Operator readiness is LOW today — only surface truly urgent items, skip anything that can wait.';
          else if (health.readiness.score >= 85) healthNote = '\nOperator readiness is HIGH today — good time to surface items that need focused attention.';
        }
      }
    } catch (err) { console.warn('[ALIVE] Oura fetch failed for callback:', err.message); }

    const prompt = `${systemPrompt}

[SYSTEM: Memory callback]

You found an old memory. Decide if it's worth bringing up RIGHT NOW.

Category: ${candidate.category}
Saved: ${candidate.created_at}
Content: ${candidate.content}
${candidate.status ? `Status: ${candidate.status}` : ''}${healthNote}

RESPOND WITH EXACTLY "SKIP" IF ANY OF THESE ARE TRUE:
- This is reference info (contacts, phone numbers, addresses, project descriptions, locations) — not actionable
- This was already discussed or resolved
- The operator explicitly said to stop/remove/cancel this
- There's no clear reason to bring it up today
- You're unsure whether it's relevant

ONLY message if this is a genuinely forgotten task, an open decision that needs follow-up, or something time-sensitive. If you do message, keep it to 1-2 sentences, casual. Connect it to what the operator might be doing now.`;

    let reply = '';
    try {
      reply = (await runClaudeHaiku(prompt)) || '';
    } catch (err) {
      console.error('[ALIVE] Claude CLI failed for memory callback:', err.message);
      return;
    }

    if (!reply || reply === 'SKIP' || reply.includes('SKIP')) {
      console.log(`[ALIVE] Memory #${candidate.id} callback skipped (AI decided not relevant)`);
      return;
    }

    const jid = this.engine.toJid(cron.contact);
    if (this.engine.notifQueue) {
      this.engine.notifQueue.queue(cron.contact, reply, { source: 'callback' });
    } else {
      await this.engine.sock.sendMessage(jid, { text: reply });
    }
    this._recentCallbacks.set(candidate.id, Date.now());
    console.log(`[ALIVE] Sent memory callback — memory #${candidate.id} (${reply.length} chars)`);
    this.engine.db.audit('alive.callback', `memory_id=${candidate.id} category=${candidate.category} chars=${reply.length}`);

    this._pruneCooldowns();
  }

  // Find a memory worth surfacing
  _findCandidate() {
    const db = this.engine.db;
    const DONE = new Set(['resolved', 'completed', 'done', 'superseded']);
    const isActive = (m) => !DONE.has((m.status || '').toLowerCase());

    // 1. Pending/active tasks (most likely forgotten)
    const tasks = db.getByCategory('task', 20);
    const pending = tasks.filter(t =>
      isActive(t) &&
      (t.status === 'pending' || t.status === 'active') &&
      !this._isOnCooldown(t.id)
    );
    if (pending.length) {
      return pending[pending.length - 1]; // oldest = most forgotten
    }

    // 2. Decisions from 3-14 days ago (worth revisiting)
    const decisions = db.getByCategory('decision', 20);
    const recent = decisions.filter(d => {
      const age = this._ageDays(d.created_at);
      return isActive(d) && age >= 3 && age <= 14 && !this._isOnCooldown(d.id);
    });
    if (recent.length) {
      return recent[Math.floor(Math.random() * recent.length)];
    }

    // 3. Facts/workflows from 7-30 days ago (skip reference-only data)
    const facts = db.getByCategory('fact', 30);
    const workflows = db.getByCategory('workflow', 20);
    const REF_PATTERNS = /\b(phone|contact|address|location|website|repo|github|template|system|key contacts)\b/i;
    const older = [...facts, ...workflows].filter(m => {
      const age = this._ageDays(m.created_at);
      return isActive(m) && age >= 7 && age <= 30 && !this._isOnCooldown(m.id) && !REF_PATTERNS.test(m.content);
    });
    if (older.length) {
      return older[Math.floor(Math.random() * older.length)];
    }

    return null;
  }

  _ageDays(dateStr) {
    return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
  }

  _isOnCooldown(memId) {
    const lastSent = this._recentCallbacks.get(memId);
    return lastSent && Date.now() - lastSent < this.COOLDOWN_MS;
  }

  _pruneCooldowns() {
    for (const [id, ts] of this._recentCallbacks.entries()) {
      if (Date.now() - ts > this.COOLDOWN_MS) {
        this._recentCallbacks.delete(id);
      }
    }
  }
}

module.exports = Callbacks;
