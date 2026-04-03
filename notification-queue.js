// notification-queue.js — Smart Notification Batching for Favor
// Batches proactive messages (alive checkins, callbacks, cron triggers) into single messages
// when multiple fire within a short window. Uses Claude to merge them naturally.

const { runCLI, isAvailable } = require('./utils/claude');

function mergeViaAI(items, systemPrompt) {
  if (!isAvailable()) return Promise.reject(new Error('CLI not available'));
  const sources = items.map(it => `[${it.source}] ${it.text}`).join('\n---\n');
  const prompt = `${systemPrompt || ''}

[SYSTEM: Merge these proactive messages into one natural message in YOUR voice.]

Multiple of your proactive modules fired at the same time and generated these separate messages:

${sources}

Merge these into ONE natural WhatsApp message. Rules:
- Write in YOUR voice and personality — this should sound exactly like you, not a generic bot
- Weave all the content together conversationally — don't use numbered lists or section headers
- Keep the tone casual and natural, like one continuous thought
- If some items overlap or repeat, deduplicate
- Keep it concise — shorter than the sum of the parts
- Don't mention that you're combining messages or that multiple systems triggered
- Just write the merged message directly, nothing else`;

  return runCLI(prompt, { model: 'haiku', timeout: 20000 });
}

class NotificationQueue {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || 120000; // 2 minute batch window
    this.queues = new Map(); // contact -> { items: [], timer }
    this.sendFn = opts.sendFn || null; // async (contact, text) => {}
    this.getSystemPrompt = opts.getSystemPrompt || null; // () => string (bot personality)
  }

  queue(contact, text, opts = {}) {
    if (!text || !contact) return;

    // Urgent messages bypass queue
    if (opts.urgent) {
      if (this.sendFn) this.sendFn(contact, text);
      return;
    }

    if (!this.queues.has(contact)) {
      this.queues.set(contact, { items: [], timer: null });
    }
    const q = this.queues.get(contact);
    q.items.push({ text, source: opts.source || 'system', timestamp: Date.now() });

    // Reset/start the batch timer
    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(() => this._flush(contact), this.windowMs);
  }

  async _flush(contact) {
    const q = this.queues.get(contact);
    if (!q || !q.items.length) return;

    const items = q.items;
    this.queues.delete(contact);

    let text;
    if (items.length === 1) {
      // Single item — send as-is
      text = items[0].text;
    } else {
      // Multiple items — merge into one natural message via AI
      console.log(`[NOTIF] Merging ${items.length} messages for ${contact} (sources: ${items.map(i => i.source).join(', ')})`);
      try {
        const sysPrompt = this.getSystemPrompt ? this.getSystemPrompt() : '';
        text = await mergeViaAI(items, sysPrompt);
        if (!text || text.length < 10) {
          text = items.map(it => it.text).join('\n\n');
        }
        console.log(`[NOTIF] Merged ${items.length} messages into ${text.length} chars`);
      } catch (err) {
        console.warn(`[NOTIF] AI merge failed, falling back to join:`, err.message);
        text = items.map(it => it.text).join('\n\n');
      }
    }

    if (this.sendFn) this.sendFn(contact, text);
  }

  // Flush all queues (for shutdown)
  flushAll() {
    for (const contact of this.queues.keys()) {
      this._flush(contact);
    }
  }
}

module.exports = NotificationQueue;
