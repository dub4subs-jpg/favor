// adaptive-timeouts.js — Dynamic timeout adjustment based on observed latency
// Tracks per-route response times and adjusts timeouts to 1.5x p95
// Falls back to static config if insufficient data

class AdaptiveTimeouts {
  constructor(db, opts = {}) {
    this.db = db;
    this.minSamples = opts.minSamples || 10;     // need this many data points before adapting
    this.multiplier = opts.multiplier || 1.5;     // timeout = multiplier * p95
    this.floorMs = opts.floorMs || 15000;         // never go below 15s
    this.ceilingMs = opts.ceilingMs || 180000;    // never go above 3min
    this._cache = new Map();                       // route -> { timeout, updatedAt }
    this._cacheTtlMs = 5 * 60 * 1000;             // refresh every 5 min
  }

  // Get adaptive timeout for a route. Returns [attempt1, attempt2] array.
  getTimeout(route, staticTimeouts) {
    const cached = this._cache.get(route);
    if (cached && Date.now() - cached.updatedAt < this._cacheTtlMs) {
      return cached.timeouts;
    }

    try {
      // Read last 50 successful requests for this route
      const rows = this.db.prepare(
        `SELECT total_ms FROM router_telemetry
         WHERE route = ? AND success = 1 AND total_ms > 0
         ORDER BY created_at DESC LIMIT 50`
      ).all(route);

      if (rows.length < this.minSamples) {
        return staticTimeouts; // not enough data, use config
      }

      const times = rows.map(r => r.total_ms).sort((a, b) => a - b);
      const p95idx = Math.floor(times.length * 0.95);
      const p95 = times[p95idx] || times[times.length - 1];
      const adaptive = Math.round(p95 * this.multiplier);

      // Clamp to floor/ceiling, but never go below static config
      const staticFloor = Array.isArray(staticTimeouts) ? staticTimeouts[0] : (staticTimeouts || this.floorMs);
      const clamped = Math.min(this.ceilingMs, Math.max(staticFloor, adaptive));

      // Return [attempt1, attempt2 = attempt1 * 1.3] matching existing pattern
      const timeouts = [clamped, Math.round(clamped * 1.3)];

      this._cache.set(route, { timeouts, updatedAt: Date.now() });
      console.log(`[ADAPTIVE] ${route}: p95=${p95}ms → timeout=${clamped}ms (${rows.length} samples, floor=${staticFloor}ms)`);
      return timeouts;
    } catch (e) {
      return staticTimeouts; // DB error, fall back
    }
  }
}

module.exports = AdaptiveTimeouts;
