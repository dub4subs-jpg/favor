// ─── ALIVE: INSIGHTS ───
// Proactive situational intelligence — notices patterns across
// conversations, contacts, and business rhythms, then suggests actions.
// Runs every 4 hours. Uses Claude CLI (haiku, free via Max/Pro) to decide
// what's genuinely worth surfacing vs noise.

const fs = require('fs');
const path = require('path');
const { runCLI, isAvailable } = require('../utils/claude');

function runClaudeHaiku(prompt, timeoutMs = 45000) {
  if (!isAvailable()) return Promise.reject(new Error('Claude Code CLI not installed'));
  return runCLI(prompt, { model: 'haiku', timeout: timeoutMs });
}

class Insights {
  constructor(engine) {
    this.engine = engine;
    this._recentInsights = []; // last N insight hashes to prevent repeats
    this.MAX_RECENT = 20;
  }

  ensureCrons(existingLabels) {
    const created = [];
    if (!existingLabels.includes('alive:insights')) {
      this.engine.db.createCron(
        this.engine.operatorContact,
        'alive:insights',
        'every 4h',
        JSON.stringify({
          type: 'alive:insights',
          prompt: 'Scan for actionable insights across conversations, contacts, and business context.'
        })
      );
      created.push('insights');
    }
    return created;
  }

  async handle(cron, taskData) {
    console.log('[ALIVE] Insights scan starting');

    const context = this._gatherContext();
    if (!context || context.length < 50) {
      console.log('[ALIVE] Not enough context for insights');
      return;
    }

    const systemPrompt = this.engine.getSystemPrompt();
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const timeStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });

    const prompt = `${systemPrompt}

[SYSTEM: Proactive Insights — ${dayNames[now.getDay()]} ${timeStr} EST]

You are scanning for things the operator should know about or act on RIGHT NOW. Review this data and surface the single most actionable insight.

Types of insights to look for (in priority order):
1. FOLLOW-UPS — things the operator said they'd do that are due/overdue
2. CONTACT PATTERNS — someone messaging frequently about an unresolved issue, or a contact gone quiet who usually messages
3. RECURRING FRICTION — the same problem or request coming up repeatedly
4. BUSINESS RHYTHMS — deadlines, weekly tasks that are due
5. OPPORTUNITIES — something in the conversation data that suggests an action the operator hasn't thought of

${context}

Rules:
- Pick the SINGLE most valuable insight. Quality over quantity.
- Be specific — name the person, the task, the date.
- Suggest a concrete next action.
- Write it as a natural message, 2-4 sentences max.
- If NOTHING is genuinely worth surfacing right now, respond with exactly: SKIP
- Do NOT repeat insights already sent recently: ${this._recentInsights.slice(-5).join(', ') || 'none'}`;

    let reply = '';
    try {
      reply = (await runClaudeHaiku(prompt, 45000)) || '';
    } catch (err) {
      console.error('[ALIVE] Insights scan failed:', err.message);
      return;
    }

    if (!reply || reply === 'SKIP' || reply.includes('SKIP')) {
      console.log('[ALIVE] Insights scan: nothing worth surfacing');
      return;
    }

    // Dedup: hash the first 50 chars to avoid repeating the same insight
    const hash = reply.substring(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (this._recentInsights.includes(hash)) {
      console.log('[ALIVE] Insight is a repeat — skipping');
      return;
    }
    this._recentInsights.push(hash);
    if (this._recentInsights.length > this.MAX_RECENT) this._recentInsights.shift();

    // Send via notification queue or direct
    if (this.engine.notifQueue) {
      this.engine.notifQueue.queue(cron.contact, reply, { source: 'insight' });
    } else {
      const jid = this.engine.toJid(cron.contact);
      await this.engine.sock.sendMessage(jid, { text: reply });
    }

    console.log(`[ALIVE] Sent insight (${reply.length} chars)`);
    this.engine.db.audit('alive.insight', `chars=${reply.length}`);
    this._log(reply);
  }

  _gatherContext() {
    const e = this.engine;
    const parts = [];

    // 1. Conversation activity — 7-day window with engagement trends
    try {
      const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
      const sessions = e.db.db.prepare(
        "SELECT contact, messages, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 20"
      ).all();

      if (sessions.length) {
        const summary = sessions.map(s => {
          let msgCount = 0, lastUserMsg = '';
          try {
            const msgs = JSON.parse(s.messages);
            msgCount = msgs.length;
            const userMsgs = msgs.filter(m => m.role === 'user' && typeof m.content === 'string');
            lastUserMsg = userMsgs.length ? userMsgs[userMsgs.length - 1].content.substring(0, 100) : '';
          } catch {}
          const updatedAt = new Date(s.updated_at).getTime();
          const daysSilent = Math.round((Date.now() - updatedAt) / (1000 * 60 * 60 * 24));
          const isRecent = updatedAt > cutoff24h;
          const isStale = updatedAt < cutoff7d;
          let trend = '';
          if (isStale) trend = ' ⚠️ GONE QUIET (>7d)';
          else if (!isRecent && daysSilent >= 3) trend = ` (quiet ${daysSilent}d)`;
          return `- ${s.contact}: ${msgCount} msgs${trend}, last: "${lastUserMsg}"`;
        }).filter(Boolean);
        parts.push(`CONVERSATIONS (7-day view):\n${summary.join('\n')}`);
      }
    } catch {}

    // 2. Pending tasks and their age
    try {
      const tasks = e.db.getByCategory('task', 15).filter(t => t.status === 'pending' || t.status === 'active');
      if (tasks.length) {
        const taskLines = tasks.map(t => {
          const age = Math.round((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24));
          return `- ${t.content} (${age}d old, ${t.status})`;
        });
        parts.push(`PENDING TASKS:\n${taskLines.join('\n')}`);
      }
    } catch {}

    // 3. Recent decisions (last 7 days, skip resolved)
    try {
      const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const decisions = e.db.db.prepare(
        "SELECT content, created_at FROM memories WHERE category = 'decision' AND created_at >= ? AND (status IS NULL OR status NOT IN ('resolved','superseded')) ORDER BY created_at DESC LIMIT 5"
      ).all(cutoff7d);
      if (decisions.length) {
        parts.push(`RECENT DECISIONS:\n${decisions.map(d => `- ${d.content} (${d.created_at.split('T')[0]})`).join('\n')}`);
      }
    } catch {}

    // 4. Open threads
    try {
      const threads = e.db.getOpenThreads(e.operatorContact, 5);
      if (threads.length) {
        parts.push(`OPEN THREADS:\n${threads.map(t => `- ${t.summary}`).join('\n')}`);
      }
    } catch {}

    // 5. Upcoming crons (non-alive)
    try {
      const crons = e.db.getCrons(e.operatorContact).filter(c => c.enabled && !c.label.startsWith('alive:'));
      if (crons.length) {
        parts.push(`SCHEDULED:\n${crons.map(c => `- ${c.label} (${c.schedule})`).join('\n')}`);
      }
    } catch {}

    // 6. Active lessons (learned behaviors)
    try {
      const lessons = e.db.getActiveLessons?.(5);
      if (lessons?.length) {
        parts.push(`LEARNED PATTERNS:\n${lessons.map(l => `- ${l.lesson} (confidence: ${l.confidence || '?'})`).join('\n')}`);
      }
    } catch {}

    // 7. Day/time context
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const estTime = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
    parts.push(`NOW: ${dayNames[now.getDay()]} ${estTime} EST`);

    // Business rhythm hints
    const day = now.getDay();
    const hints = [];
    if (day === 5) hints.push('Friday — invoice day');
    if (day === 1) hints.push('Monday — week start, review open items');
    if (hints.length) parts.push(`RHYTHMS: ${hints.join(', ')}`);

    return parts.join('\n\n');
  }

  _log(insight) {
    try {
      const logFile = path.join(__dirname, '..', 'data', 'insights.log');
      const line = `[${new Date().toISOString()}] ${insight.substring(0, 200)}\n`;
      fs.appendFileSync(logFile, line);
    } catch {}
  }
}

module.exports = Insights;
