// ─── ALIVE: MEMORY CALLBACKS ───
// Resurfaces forgotten tasks, old decisions, and relevant facts

const { spawn } = require('child_process');
const fs = require('fs');

// ─── CLAUDE CLI AUTO-DETECTION ───
const { execSync } = require('child_process');
let CLAUDE_BIN = null;

(function detectClaudeCLI() {
  const candidates = [
    process.env.CLAUDE_BIN,
    '/root/.local/bin/claude',
    '/usr/local/bin/claude',
    '/home/' + (process.env.USER || 'root') + '/.local/bin/claude',
  ].filter(Boolean);
  for (const bin of candidates) {
    try { if (fs.existsSync(bin)) { CLAUDE_BIN = bin; return; } } catch {}
  }
  try {
    const which = execSync('which claude 2>/dev/null', { encoding: 'utf8' }).trim();
    if (which) { CLAUDE_BIN = which; return; }
  } catch {}
})();

// Strip ANTHROPIC_API_KEY so Claude CLI uses Max subscription, not API key
function claudeEnv() {
  const binDir = CLAUDE_BIN ? require('path').dirname(CLAUDE_BIN) : '/root/.local/bin';
  return Object.fromEntries(
    Object.entries({ ...process.env, PATH: `${binDir}:${process.env.PATH}` })
      .filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ANTHROPIC_REUSE') && k !== 'ANTHROPIC_API_KEY')
  );
}

function runClaudeHaiku(prompt, timeoutMs = 30000) {
  if (!CLAUDE_BIN) return Promise.reject(new Error('Claude Code CLI not installed'));
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, ['--print', '--model', 'haiku', '--allowedTools', '', '-'], {
      timeout: timeoutMs,
      env: claudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', (code) => {
      const out = stdout.trim() || stderr.trim() || '';
      if (code !== 0 && !stdout.trim()) reject(new Error(stderr.trim() || `exit code ${code}`));
      else resolve(out);
    });
    proc.on('error', reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
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

    const prompt = `${systemPrompt}

[SYSTEM: Memory callback]

You remembered something worth bringing up. Here's the memory:

Category: ${candidate.category}
Saved: ${candidate.created_at}
Content: ${candidate.content}
${candidate.status ? `Status: ${candidate.status}` : ''}

Bring this up naturally in a short message. Connect it to what the operator might be doing now. Examples:
- "Hey, remember when you mentioned [X]? Just thinking — have you followed up on that?"
- "That [task] from last week — still on the radar?"
- "Random thought: you saved [this decision] a while back. Still feeling good about it?"

Keep it to 1-3 sentences. Be casual, not formal. If this memory is stale or irrelevant, respond with exactly: SKIP`;

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
    await this.engine.sock.sendMessage(jid, { text: reply });
    this._recentCallbacks.set(candidate.id, Date.now());
    console.log(`[ALIVE] Sent memory callback — memory #${candidate.id} (${reply.length} chars)`);
    this.engine.db.audit('alive.callback', `memory_id=${candidate.id} category=${candidate.category} chars=${reply.length}`);

    this._pruneCooldowns();
  }

  // Find a memory worth surfacing
  _findCandidate() {
    const db = this.engine.db;

    // 1. Pending/active tasks (most likely forgotten)
    const tasks = db.getByCategory('task', 20);
    const pending = tasks.filter(t =>
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
      return age >= 3 && age <= 14 && !this._isOnCooldown(d.id);
    });
    if (recent.length) {
      return recent[Math.floor(Math.random() * recent.length)];
    }

    // 3. Facts/workflows from 7-30 days ago
    const facts = db.getByCategory('fact', 30);
    const workflows = db.getByCategory('workflow', 20);
    const older = [...facts, ...workflows].filter(m => {
      const age = this._ageDays(m.created_at);
      return age >= 7 && age <= 30 && !this._isOnCooldown(m.id);
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
