// api.js — REST API for DellV2
// Exposes Dell's brain via HTTP for dashboards, integrations, and admin UIs
// Runs on a separate port from the WhatsApp webhook server

const http = require('http');
const url = require('url');

class DellAPI {
  constructor(opts) {
    this.db = opts.db;
    this.config = opts.config;
    this.token = opts.token || opts.config.api?.token || null;
    this.port = opts.port || opts.config.api?.port || 3105;
    this.messageQueue = opts.messageQueue;
    this.costTracker = opts.costTracker;
    this.guardian = opts.guardian;
    this.planner = opts.planner;
    this.server = null;
  }

  start() {
    if (!this.token) {
      console.warn('[API] No API token configured (config.api.token) — REST API DISABLED for security');
      return;
    }
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.listen(this.port, () => {
      console.log(`[API] REST API listening on :${this.port}`);
    });
    this.server.on('error', (e) => {
      console.error(`[API] Failed to start on :${this.port}:`, e.message);
    });
  }

  _auth(req) {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    return token === this.token;
  }

  _json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  }

  _readBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => resolve(body));
    });
  }

  async _handle(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      res.end();
      return;
    }

    // Auth required for all endpoints
    if (!this._auth(req)) {
      this._json(res, 401, { error: 'unauthorized' });
      return;
    }

    const parsed = url.parse(req.url, true);
    const path = parsed.pathname;

    try {
      // ─── GET /api/health ───
      if (req.method === 'GET' && path === '/api/health') {
        const counts = this.db.getMemoryCount();
        const uptime = process.uptime();
        const queueStats = this.messageQueue?.stats || {};
        const memUsage = process.memoryUsage();

        this._json(res, 200, {
          status: 'online',
          uptime_seconds: Math.round(uptime),
          model: this.config.model?.id || 'unknown',
          memories: counts,
          queue: queueStats,
          memory_mb: Math.round(memUsage.rss / 1024 / 1024),
          active_crons: this.db.getActiveCrons().length,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // ─── GET /api/costs ───
      if (req.method === 'GET' && path === '/api/costs') {
        if (!this.costTracker) {
          this._json(res, 200, { error: 'cost tracker not available' });
          return;
        }
        const summary = this.costTracker.getSummary();
        const byRoute = this.costTracker.getCostByRoute(7);
        this._json(res, 200, { totals: summary.totals, today: summary.today, by_route: byRoute, daily_trend: summary.dailyTrend });
        return;
      }

      // ─── GET /api/memory/search?q=... ───
      if (req.method === 'GET' && path === '/api/memory/search') {
        const query = parsed.query.q || '';
        if (!query) {
          this._json(res, 400, { error: 'missing ?q= parameter' });
          return;
        }
        const results = this.db.search(query);
        this._json(res, 200, { query, results: (results || []).slice(0, 20) });
        return;
      }

      // ─── GET /api/memories ───
      if (req.method === 'GET' && path === '/api/memories') {
        const all = this.db.getAllMemories();
        const counts = this.db.getMemoryCount();
        this._json(res, 200, { counts, recent: { facts: all.facts.slice(-10), decisions: all.decisions.slice(-10), preferences: all.preferences.slice(-10), tasks: all.tasks.slice(-10) } });
        return;
      }

      // ─── GET /api/threads?contact=... ───
      if (req.method === 'GET' && path === '/api/threads') {
        const contact = parsed.query.contact || '';
        const threads = contact ? this.db.getOpenThreads(contact, 20) : [];
        this._json(res, 200, { threads });
        return;
      }

      // ─── GET /api/plans?contact=... ───
      if (req.method === 'GET' && path === '/api/plans') {
        if (!this.planner) { this._json(res, 200, { plans: [] }); return; }
        const contact = parsed.query.contact || '';
        const plans = contact ? this.planner.getRecent(contact, 10) : [];
        this._json(res, 200, { plans });
        return;
      }

      // ─── GET /api/lessons ───
      if (req.method === 'GET' && path === '/api/lessons') {
        const lessons = this.db.getAllActiveLessons();
        this._json(res, 200, { lessons });
        return;
      }

      // ─── GET /api/queue ───
      if (req.method === 'GET' && path === '/api/queue') {
        this._json(res, 200, { stats: this.messageQueue?.stats || {} });
        return;
      }

      // ─── GET /api/audit?contact=... ───
      if (req.method === 'GET' && path === '/api/audit') {
        const contact = parsed.query.contact || '';
        try {
          const rawDb = this.db.db; // FavorMemory wraps better-sqlite3 as .db
          const rows = contact
            ? rawDb.prepare(`SELECT id, tool_name, status, contact, elapsed_ms, created_at FROM tool_audit WHERE contact = ? ORDER BY id DESC LIMIT 20`).all(contact)
            : rawDb.prepare(`SELECT id, tool_name, status, contact, elapsed_ms, created_at FROM tool_audit ORDER BY id DESC LIMIT 20`).all();
          this._json(res, 200, { entries: rows });
        } catch (e) {
          this._json(res, 200, { entries: [], error: e.message });
        }
        return;
      }

      // 404
      this._json(res, 404, { error: 'not found', endpoints: [
        'GET /api/health', 'GET /api/costs', 'GET /api/memory/search?q=',
        'GET /api/memories', 'GET /api/threads?contact=', 'GET /api/plans?contact=',
        'GET /api/lessons', 'GET /api/queue', 'GET /api/audit'
      ]});
    } catch (e) {
      console.error('[API] Error:', e.message);
      this._json(res, 500, { error: e.message });
    }
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = DellAPI;
