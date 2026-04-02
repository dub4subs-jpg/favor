// anticipator.js — Proactive intelligence engine
// Scans calendar, memory, signals, and threads for actionable patterns
// Surfaces high-confidence suggestions to the operator

const { runClaudeCLI } = require('./router');

class Anticipator {
  constructor(db, opts = {}) {
    this.db = db;
    this.scribe = opts.scribe || null;
    this.minConfidence = opts.minConfidence || 0.7;
    this._lastRun = 0;
    this._inFlight = false;
    this._cooldownMs = opts.cooldownMs || 60 * 60 * 1000; // 1 hour between scans
  }

  // Run a proactive scan — returns array of suggestions (or empty)
  async scan(contact) {
    // Rate limit: don't scan more than once per cooldown
    if (Date.now() - this._lastRun < this._cooldownMs) return [];
    if (this._inFlight) return [];
    this._inFlight = true;

    try {
      const context = this._gatherContext(contact);
      if (!context || context.length < 50) return [];

      const prompt = `You are an AI assistant's proactive intelligence engine. Analyze the context below and identify 0-3 actionable suggestions the operator should know about RIGHT NOW.

Rules:
- Only suggest things that are TIME-SENSITIVE or would genuinely surprise/help the operator
- Each suggestion must have a clear action the operator can take
- Skip routine reminders (crons handle those) — focus on PATTERNS and CONNECTIONS
- Return JSON: {"suggestions": [{"text": "short suggestion", "action": "what to do", "confidence": 0.8}]}
- confidence 0.0-1.0: how sure you are this is worth surfacing
- Return {"suggestions": []} if nothing urgent or insightful

Examples of good suggestions:
- "Vendor X hasn't replied in 4 days — want me to follow up?"
- "You have overlapping meetings tomorrow at 2pm"
- "Based on your sleep data, today might not be the best day for that big presentation"
- "The barcode batch you started 3 days ago still has 2 items pending"

Context:
${context}`;

      const raw = await runClaudeCLI(prompt, 20000, { model: 'haiku', priority: 2 });
      if (!raw) return [];

      const cleaned = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const suggestions = (parsed.suggestions || [])
        .filter(s => s.confidence >= this.minConfidence && s.text && s.action);

      // Only burn cooldown on successful scan
      this._lastRun = Date.now();
      if (suggestions.length) {
        console.log(`[ANTICIPATOR] Found ${suggestions.length} suggestions`);
      }
      return suggestions;
    } catch (e) {
      console.warn('[ANTICIPATOR] Scan failed (non-fatal):', e.message);
      return [];
    } finally {
      this._inFlight = false;
    }
  }

  // Gather context from multiple sources for the scan
  _gatherContext(contact) {
    const parts = [];

    // Open threads (unresolved topics)
    try {
      const threads = this.db.getOpenThreads(contact, 10);
      if (threads.length) {
        const threadLines = threads.map(t => {
          const ageH = Math.round((Date.now() - new Date(t.created_at).getTime()) / 3600000);
          return `- "${t.summary}" (${ageH}h old)`;
        });
        parts.push(`Open threads:\n${threadLines.join('\n')}`);
      }
    } catch (_) {}

    // Pending tasks from memory (operator-scoped, not cross-contact)
    try {
      const tasks = this.db.search('status:pending');
      const taskItems = (tasks || []).filter(t => t.category === 'task' && t.contact === contact).slice(0, 5);
      if (taskItems.length) {
        parts.push(`Pending tasks:\n${taskItems.map(t => `- ${t.content}`).join('\n')}`);
      }
    } catch (_) {}

    // Recent signals (prices, deadlines, contacts)
    try {
      const signals = this.db.getRecentSignals?.(contact, 5);
      if (signals?.length) {
        parts.push(`Recent signals:\n${signals.map(s => `- [${s.type}] ${s.content}`).join('\n')}`);
      }
    } catch (_) {}

    // Today's journal (what happened so far) — uses scribe if available
    try {
      const journal = this.scribe?.getTodayJournal?.(contact, 10);
      if (journal?.length) {
        const pending = journal.filter(j => j.category === 'pending' || j.category === 'task');
        if (pending.length) {
          parts.push(`Unresolved today:\n${pending.map(j => `- ${j.summary}`).join('\n')}`);
        }
      }
    } catch (_) {}

    // Current time context
    const now = new Date();
    const timeStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', hour: 'numeric', minute: '2-digit' });
    parts.push(`Current time: ${timeStr} EST`);

    return parts.join('\n\n');
  }

  // Format suggestions for WhatsApp display
  static format(suggestions) {
    if (!suggestions.length) return null;
    const lines = suggestions.map(s => `• ${s.text}\n  → ${s.action}`);
    return `💡 *Heads up*\n\n${lines.join('\n\n')}`;
  }
}

module.exports = Anticipator;
