// message-queue.js — Global concurrency limiter with priority queuing
// Prevents cascading failures when multiple contacts message simultaneously
// Priority: operator (0) > staff (1) > customer (2) > guest (3)
//
// NOTE: Per-contact serialization is handled by withJidLock() in favor.js.
// This queue only limits GLOBAL concurrency across all contacts.

class MessageQueue {
  constructor(opts = {}) {
    this.maxConcurrent = opts.maxConcurrent || 3;
    this.maxWaiting = opts.maxWaiting || 10;
    this.acquireTimeoutMs = opts.acquireTimeoutMs || 120000; // 2 min max wait
    this._active = 0;
    this._waiting = []; // { priority, resolve, reject, jid, enqueued, timer }
    this._stats = { processed: 0, queued: 0, dropped: 0, timedOut: 0, peakActive: 0, peakWaiting: 0 };
  }

  // Map trust level string to numeric priority (lower = higher priority)
  static priorityFor(trustLevel) {
    const map = { operator: 0, staff: 1, customer: 2, guest: 3 };
    return map[trustLevel] ?? 3;
  }

  // Acquire a processing slot. Resolves immediately if slots available,
  // otherwise waits in priority queue. Returns { waited, release }.
  // Rejects if queue is full or timeout expires.
  acquire(trustLevel, jid) {
    const priority = MessageQueue.priorityFor(trustLevel);

    if (this._active < this.maxConcurrent) {
      this._active++;
      if (this._active > this._stats.peakActive) this._stats.peakActive = this._active;
      return Promise.resolve({ waited: false, release: () => this._release() });
    }

    // Queue full — operators get a higher cap but not unlimited
    const hardCap = this.maxWaiting * 2; // absolute max for any priority
    if (this._waiting.length >= hardCap) {
      this._stats.dropped++;
      return Promise.reject(new Error('QUEUE_FULL'));
    }
    if (this._waiting.length >= this.maxWaiting && priority > 0) {
      this._stats.dropped++;
      return Promise.reject(new Error('QUEUE_FULL'));
    }

    // Queue it with timeout
    this._stats.queued++;
    return new Promise((resolve, reject) => {
      const entry = { priority, resolve, reject, jid, enqueued: Date.now(), timer: null };

      // Timeout: don't wait forever
      entry.timer = setTimeout(() => {
        const idx = this._waiting.indexOf(entry);
        if (idx !== -1) {
          this._waiting.splice(idx, 1);
          this._stats.timedOut++;
          reject(new Error('QUEUE_TIMEOUT'));
        }
      }, this.acquireTimeoutMs);

      this._waiting.push(entry);
      // Keep sorted by priority (lowest number = highest priority)
      this._waiting.sort((a, b) => a.priority - b.priority);
      if (this._waiting.length > this._stats.peakWaiting) {
        this._stats.peakWaiting = this._waiting.length;
      }
    });
  }

  _release() {
    this._active--;
    this._stats.processed++;

    if (this._waiting.length > 0) {
      const next = this._waiting.shift();
      clearTimeout(next.timer);
      this._active++;
      if (this._active > this._stats.peakActive) this._stats.peakActive = this._active;
      const waitMs = Date.now() - next.enqueued;
      next.resolve({ waited: true, waitMs, release: () => this._release() });
    }
  }

  get activeCount() { return this._active; }
  get waitingCount() { return this._waiting.length; }
  get stats() { return { ...this._stats, active: this._active, waiting: this._waiting.length }; }
}

module.exports = MessageQueue;
