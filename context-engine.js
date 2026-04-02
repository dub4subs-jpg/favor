// context-engine.js — Ambient awareness fusion
// Combines sensor streams (Omi, Oura, phone location, laptop status)
// into a single context object injected into Dell's system prompt

class ContextEngine {
  constructor(db, opts = {}) {
    this.db = db;
    this.config = opts.config || {};
    this._context = {};
    this._lastUpdate = 0;
    this._updateIntervalMs = opts.updateIntervalMs || 5 * 60 * 1000; // 5 min
    this._timer = null;
  }

  start() {
    this._update();
    this._timer = setInterval(() => this._update(), this._updateIntervalMs);
    console.log(`[CONTEXT] Ambient awareness engine started (${this._updateIntervalMs / 1000}s interval)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  _update() {
    const ctx = {};
    const now = Date.now();

    // ─── LOCATION (from phone GPS) ───
    try {
      const loc = this.db.prepare?.(
        `SELECT lat, lon, address, battery, created_at FROM location_history ORDER BY id DESC LIMIT 1`
      )?.get();
      if (loc) {
        const ageMin = Math.round((now - new Date(loc.created_at).getTime()) / 60000);
        if (ageMin < 60) { // only if fresh (< 1 hour)
          ctx.location = { address: loc.address, battery: loc.battery, age_min: ageMin };
        }
      }
    } catch (_) {}

    // ─── OURA HEALTH (from last health check) ───
    try {
      const health = this.db.prepare?.(
        `SELECT content FROM memories WHERE category = 'fact' AND content LIKE '%readiness%' ORDER BY id DESC LIMIT 1`
      )?.get();
      if (health) {
        ctx.health = health.content;
      }
    } catch (_) {}

    // ─── OMI (recent ambient audio) ───
    try {
      const transcripts = this.db.prepare?.(
        `SELECT text, created_at FROM omi_transcripts ORDER BY id DESC LIMIT 3`
      )?.all();
      if (transcripts?.length) {
        const recentOmi = transcripts.filter(t => {
          const ageMin = (now - new Date(t.created_at).getTime()) / 60000;
          return ageMin < 30; // last 30 min only
        });
        if (recentOmi.length) {
          ctx.ambient_audio = recentOmi.map(t => (t.text || '').substring(0, 200)).join(' | ');
        }
      }
    } catch (_) {}

    // ─── TIME CONTEXT ───
    const nowDate = new Date();
    const hour = nowDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    const dayOfWeek = nowDate.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
    ctx.time = { hour: parseInt(hour), day: dayOfWeek };
    ctx.time_context =
      parseInt(hour) < 9 ? 'early_morning' :
      parseInt(hour) < 12 ? 'morning' :
      parseInt(hour) < 17 ? 'afternoon' :
      parseInt(hour) < 21 ? 'evening' : 'night';

    this._context = ctx;
    this._lastUpdate = now;
  }

  // Get current fused context
  get() {
    return this._context;
  }

  // Build prompt section for system prompt injection
  getPromptSection() {
    const ctx = this._context;
    if (!ctx || Object.keys(ctx).length <= 2) return ''; // only time info, nothing interesting

    const parts = [];

    if (ctx.location) {
      parts.push(`📍 Location: ${ctx.location.address || 'unknown'} (${ctx.location.age_min}m ago, battery: ${ctx.location.battery || '?'}%)`);
    }
    if (ctx.health) {
      parts.push(`💪 Health: ${ctx.health.substring(0, 150)}`);
    }
    if (ctx.ambient_audio) {
      parts.push(`🎧 Recent ambient: ${ctx.ambient_audio.substring(0, 200)}`);
    }
    if (ctx.time_context) {
      parts.push(`⏰ Time: ${ctx.time?.day} ${ctx.time_context}`);
    }

    if (!parts.length) return '';
    return `\n\n=== AMBIENT CONTEXT (live sensor data — use naturally, don't recite) ===\n${parts.join('\n')}\n=== END AMBIENT ===`;
  }
}

module.exports = ContextEngine;
