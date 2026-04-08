// ─── ALIVE: INSIGHTS ───
// Proactive situational intelligence — notices patterns across
// conversations, contacts, and business rhythms, then suggests actions.
// Runs every 4 hours. Uses Claude CLI (haiku, free via Max/Pro) to decide
// what's genuinely worth surfacing vs noise.

const fs = require('fs');
const path = require('path');
const { runCLI, isAvailable } = require('../utils/claude');

const DEDUP_FILE = path.join(__dirname, '..', 'state', 'insights_dedup.json');

function runClaudeHaiku(prompt, timeoutMs = 45000) {
  if (!isAvailable()) return Promise.reject(new Error('Claude Code CLI not installed'));
  return runCLI(prompt, { model: 'haiku', timeout: timeoutMs });
}

class Insights {
  constructor(engine) {
    this.engine = engine;
    this._recentInsights = this._loadDedup(); // persisted across restarts
    this.MAX_RECENT = 50;
  }

  _loadDedup() {
    try {
      if (fs.existsSync(DEDUP_FILE)) {
        const data = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
        // Prune entries older than 7 days
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        return (data || []).filter(e => e.ts > cutoff);
      }
    } catch {}
    return [];
  }

  _saveDedup() {
    try {
      fs.writeFileSync(DEDUP_FILE, JSON.stringify(this._recentInsights));
    } catch {}
  }

  // Extract topic keywords for dedup — strips names/dates/filler to find the core subject
  _topicHash(text) {
    return text
      .toLowerCase()
      .replace(/\b(hey|heads up|want me to|should i|still|right now|got a?|you've got)\b/g, '')
      .replace(/\b\d+\s*(days?|hours?|minutes?|ago|old|h|d|m)\b/g, '')
      .replace(/[^a-z ]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .sort()
      .join(' ')
      .substring(0, 80);
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
    const timeStr = now.toLocaleString('en-US', { timeZone: this.engine.timezone, hour: 'numeric', minute: '2-digit', hour12: true });

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
- Do NOT repeat insights already sent recently (topics covered): ${this._recentInsights.slice(-8).map(e => e.topic).join('; ') || 'none'}

GROUNDING (critical — violating ANY of these = broken output):
- ONLY report things that are EXPLICITLY stated in the data above. Never infer, combine, or synthesize across unrelated sources.
- Do NOT invent external sources (LinkedIn, Twitter, Reddit, email, news, etc.) — you have NO access to those platforms.
- Do NOT fabricate posts, questions, or events that aren't directly quoted in the data.
- Do NOT attribute actions to people unless their exact name appears in the data above AND the specific action is described.
- Every claim must trace to a SINGLE specific item above (a conversation, task, decision, or thread). If you can't point to the exact source, say SKIP.
- If the data is thin or nothing is genuinely urgent, say SKIP. A false insight is worse than no insight.`;

    let reply = '';
    try {
      reply = (await runClaudeHaiku(prompt, 45000)) || '';
    } catch (err) {
      console.error('[ALIVE] Insights scan failed:', err.message);
      return;
    }

    if (!reply || reply.trim().startsWith('SKIP')) {
      console.log('[ALIVE] Insights scan: nothing worth surfacing');
      return;
    }

    // Catch "nothing to report" anti-pattern — LLM sometimes writes a verbose
    // "everything's fine" message instead of saying SKIP as instructed.
    // Only suppress short replies (<100 chars) to avoid killing legitimate content.
    const noopPatterns = /\b(no action needed|everything['']s on track|nothing.{0,20}(report|surface|flag|attention|urgent)|all.{0,15}(awaiting|on track|good|clear)|no.{0,15}blocking issues)\b/i;
    if (reply.length < 100 && noopPatterns.test(reply)) {
      console.log('[ALIVE] Insight is a "nothing to report" anti-pattern — suppressing');
      return;
    }

    // Format guard: reject multi-item replies (violates "SINGLE most valuable insight" rule)
    const bulletCount = (reply.match(/^[\s]*[•\-\*→►▸]\s?/gm) || []).length;
    if (bulletCount > 1) {
      console.log(`[ALIVE] Insight has ${bulletCount} bullets (should be 1) — suppressing status report`);
      return;
    }

    // Length guard: insights should be 2-4 sentences, not essays
    if (reply.length > 500) {
      console.log(`[ALIVE] Insight too long (${reply.length} chars, max 500) — suppressing`);
      return;
    }

    // Post-generation grounding check: reject if it mentions platforms we don't have access to
    const fabricationPatterns = /\b(linkedin|twitter|reddit|facebook|instagram|stack\s*overflow|hacker\s*news)\b/i;
    if (fabricationPatterns.test(reply)) {
      console.log('[ALIVE] Insight references external platform (likely hallucinated) — skipping');
      return;
    }

    // Reject if it names a person not present in the context data
    const contextLower = context.toLowerCase();
    const namedPersonMatch = reply.match(/\b([A-Z][a-z]{2,})\s+(asked|said|mentioned|posted|wrote|sent|requested|messaged)\b/g);
    if (namedPersonMatch) {
      for (const phrase of namedPersonMatch) {
        const name = phrase.split(/\s+/)[0].toLowerCase();
        if (!contextLower.includes(name)) {
          console.log(`[ALIVE] Insight names "${name}" but they're not in the context — skipping`);
          return;
        }
      }
    }

    // Dedup: topic-based hash catches rephrased versions of the same insight
    const topic = this._topicHash(reply);
    if (this._recentInsights.some(e => e.topic === topic)) {
      console.log('[ALIVE] Insight is a repeat topic — skipping');
      return;
    }
    this._recentInsights.push({ topic, ts: Date.now() });
    if (this._recentInsights.length > this.MAX_RECENT) this._recentInsights.shift();
    this._saveDedup();

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

    // 2. Pending tasks — only recent (≤3 days). Stale tasks are noise, not insights.
    try {
      const maxAgeMs = 3 * 24 * 60 * 60 * 1000;
      const tasks = e.db.getByCategory('task', 15)
        .filter(t => (t.status === 'pending' || t.status === 'active'))
        .filter(t => (Date.now() - new Date(t.created_at).getTime()) <= maxAgeMs);
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
    const estTime = now.toLocaleString('en-US', { timeZone: this.engine.timezone, hour: 'numeric', minute: '2-digit', hour12: true });
    parts.push(`NOW: ${dayNames[now.getDay()]} ${estTime} EST`);

    // Business rhythm hints (Monday = review day is universal enough to keep)
    const day = now.getDay();
    if (day === 1) parts.push(`RHYTHMS: Monday — week start, review open items`);

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
