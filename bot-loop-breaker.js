/**
 * Bot Loop Breaker
 *
 * Prevents infinite reply loops when two AI bots talk to each other.
 * Detects rapid back-and-forth patterns with low text variation,
 * auto-mutes the contact, and notifies the operator.
 */

class BotLoopBreaker {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || 60000;       // 60s sliding window
    this.threshold = opts.threshold || 3;          // msgs before flagging
    this.muteMins = opts.muteMins || 30;           // default mute duration
    this.tracks = new Map();                       // jid -> [{body, direction, ts}]
    this.mutes = new Map();                        // jid -> unmute timestamp
  }

  /**
   * Check if a message looks like it came from another bot.
   * Many bots prefix with "[Message from X AI bot]" or similar.
   */
  shouldSkip(body) {
    if (!body || typeof body !== 'string') return false;
    const lower = body.toLowerCase();
    return (
      lower.startsWith('[message from') ||
      lower.startsWith('[auto-reply') ||
      lower.startsWith('[bot]') ||
      /^\[.*\bai\b.*\bbot\b.*\]/i.test(body)
    );
  }

  /**
   * Record a message in the sliding window.
   * direction: 'in' (received) or 'out' (sent by the bot)
   */
  track(jid, body, direction) {
    if (!this.tracks.has(jid)) this.tracks.set(jid, []);
    const window = this.tracks.get(jid);
    const now = Date.now();

    window.push({ body: (body || '').substring(0, 200), direction, ts: now });

    // Prune old entries outside the sliding window
    while (window.length > 0 && window[0].ts < now - this.windowMs) {
      window.shift();
    }
  }

  /**
   * Check if a contact is in a bot loop.
   * Criteria: >threshold msgs in window, alternating in/out, low text variation.
   */
  isLooping(jid) {
    const window = this.tracks.get(jid);
    if (!window || window.length < this.threshold) return false;

    // Check alternation — are messages ping-ponging?
    let alternations = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i].direction !== window[i - 1].direction) alternations++;
    }
    const altRatio = alternations / (window.length - 1);
    if (altRatio < 0.6) return false; // not a back-and-forth pattern

    // Check text variation — are responses repetitive/short?
    const outMsgs = window.filter(m => m.direction === 'out').map(m => m.body);
    if (outMsgs.length < 2) return false;

    const avgLen = outMsgs.reduce((sum, m) => sum + m.length, 0) / outMsgs.length;
    if (avgLen < 30) return true; // very short responses = likely loop

    // Check word overlap between consecutive responses
    const similarity = this._similarity(outMsgs[outMsgs.length - 2], outMsgs[outMsgs.length - 1]);
    if (similarity > 0.6) return true; // responses are too similar

    return false;
  }

  /** Simple word overlap similarity (0-1) */
  _similarity(a, b) {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    let overlap = 0;
    for (const w of wordsA) if (wordsB.has(w)) overlap++;
    return overlap / Math.max(wordsA.size, wordsB.size, 1);
  }

  /** Mute a contact for N minutes */
  mute(jid, mins) {
    this.mutes.set(jid, Date.now() + (mins || this.muteMins) * 60000);
    this.tracks.delete(jid); // reset tracking
  }

  /** Check if a contact is currently muted */
  isMuted(jid) {
    const until = this.mutes.get(jid);
    if (!until) return false;
    if (Date.now() > until) {
      this.mutes.delete(jid);
      return false;
    }
    return true;
  }

  /**
   * Full check — call this before processing an incoming message.
   * Returns { skip: boolean, reason?: string }
   */
  check(jid, body) {
    if (this.isMuted(jid)) {
      return { skip: true, reason: 'muted (bot loop cooldown)' };
    }
    if (this.shouldSkip(body)) {
      return { skip: true, reason: 'bot signature detected' };
    }
    return { skip: false };
  }
}

module.exports = BotLoopBreaker;

// CLI test mode
if (require.main === module) {
  const lb = new BotLoopBreaker({ threshold: 3, windowMs: 5000 });
  const jid = 'test@s.whatsapp.net';

  console.log('Simulating bot loop...');
  lb.track(jid, 'Hello, how can I help?', 'out');
  lb.track(jid, 'Hi there! I am another bot.', 'in');
  lb.track(jid, 'Nice to meet you, what do you need?', 'out');
  lb.track(jid, 'I was just checking in!', 'in');
  lb.track(jid, 'Sure, how can I help you today?', 'out');

  console.log('Is looping:', lb.isLooping(jid));
  console.log('shouldSkip "[Message from AI bot]":', lb.shouldSkip('[Message from AI bot]'));
  console.log('Muting...');
  lb.mute(jid, 1);
  console.log('Is muted:', lb.isMuted(jid));
}
