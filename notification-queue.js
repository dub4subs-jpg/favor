// notification-queue.js — Smart Notification Batching for Favor
// Batches proactive messages (alive checkins, callbacks, cron triggers) into single messages
// when multiple fire within a short window. Urgent messages bypass the queue.

class NotificationQueue {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || 120000; // 2 minute batch window
    this.queues = new Map(); // contact -> { items: [], timer }
    this.sendFn = opts.sendFn || null; // async (contact, text) => {}
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

  _flush(contact) {
    const q = this.queues.get(contact);
    if (!q || !q.items.length) return;

    const items = q.items;
    this.queues.delete(contact);

    let text;
    if (items.length === 1) {
      // Single item — send as-is, no numbering
      text = items[0].text;
    } else {
      // Multiple items — combine with numbers
      text = items.map((it, i) => `[${i + 1}] ${it.text}`).join('\n\n');
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
