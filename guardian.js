// guardian.js — Guardian: Unified Security & Health Framework for Favor
// Two modes:
//   1. Code Scanner — QA/watchdog scans on project code
//   2. Runtime Guard — rate limiting, spend tracking, key leak protection, anomaly detection

const fs = require('fs');
const path = require('path');
const { runGuardian } = require('./guardian/index');
const { loadConfig } = require('./guardian/config');

// Approximate costs per 1K tokens (USD)
const MODEL_COSTS = {
  'gpt-4o':           { input: 0.0025, output: 0.01 },
  'gpt-4o-mini':      { input: 0.00015, output: 0.0006 },
  'gpt-4.1':          { input: 0.002, output: 0.008 },
  'gpt-4.1-mini':     { input: 0.0004, output: 0.0016 },
  'o3-mini':          { input: 0.00115, output: 0.0044 },
  'claude-sonnet':    { input: 0.003, output: 0.015 },
  'claude-haiku':     { input: 0.0008, output: 0.004 },
  'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
};

// API key patterns for leak detection
const KEY_PATTERNS = [
  { name: 'OpenAI',    regex: /sk-[a-zA-Z0-9]{20,}/ },
  { name: 'OpenAI',    regex: /sk-proj-[a-zA-Z0-9\-_]{20,}/ },
  { name: 'Google',    regex: /AIza[a-zA-Z0-9\-_]{30,}/ },
  { name: 'Anthropic', regex: /sk-ant-[a-zA-Z0-9\-_]{20,}/ },
  { name: 'Brave',     regex: /BSA[a-zA-Z0-9]{20,}/ },
  { name: 'GitHub',    regex: /ghp_[a-zA-Z0-9]{30,}/ },
  { name: 'GitHub',    regex: /gho_[a-zA-Z0-9]{30,}/ },
  { name: 'Slack',     regex: /xoxb-[0-9]{10,}/ },
];

class Guardian {
  constructor(db, config, { dataDir, onAlert } = {}) {
    this.db = db;
    this.config = config || {};
    this.dataDir = dataDir || path.join(__dirname, 'data');
    this.onAlert = onAlert || (() => {});
    this.stateFile = path.join(this.dataDir, 'guard-state.json');

    // Scanner state
    this.lastReport = null;
    this.lastScanTime = null;

    // Guard state
    this.state = this._loadState();

    // DB table for guard logs
    if (db) this._migrate();
  }

  // ═══════════════════════════════════════════════════════
  // PART 1: CODE SCANNER
  // ═══════════════════════════════════════════════════════

  // Run a QA scan on a project directory
  async scan(targetDir, { mode = 'quick', scope = 'full', verbose = false, repair = false } = {}) {
    const scanConfig = loadConfig({
      target: path.resolve(targetDir),
      mode,
      scope,
      verbose,
      allowRepair: repair,
      repairLevel: repair ? 'safe' : 'none',
      timeout: 60000,
    });

    // Capture console output since scanner prints to stdout
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    };

    try {
      const report = await runGuardian(scanConfig);
      this.lastReport = report;
      this.lastScanTime = new Date().toISOString();
      return { report, logs: logs.join('\n') };
    } finally {
      console.log = origLog;
    }
  }

  formatReport(report) {
    if (!report) return 'No scan results available.';
    const lines = [];
    lines.push(`*Guardian Health Report*`);
    lines.push(`Score: *${report.healthScore?.overall ?? '??'}/100*`);
    lines.push('');

    if (report.layers && report.layers.length) {
      lines.push('*Validation Layers:*');
      for (const layer of report.layers) {
        const icon = layer.failed === 0 ? '✅' : '❌';
        lines.push(`${icon} ${layer.layer}: ${layer.passed}/${layer.passed + layer.failed} passed`);
      }
      lines.push('');
    }

    const critical = (report.findings || []).filter(f => f.severity === 'critical');
    const high = (report.findings || []).filter(f => f.severity === 'high');
    const medium = (report.findings || []).filter(f => f.severity === 'medium');

    if (critical.length) {
      lines.push(`🔴 *Critical (${critical.length}):*`);
      for (const f of critical.slice(0, 5)) lines.push(`  - ${f.message || f.checkName || 'Unknown'}`);
    }
    if (high.length) {
      lines.push(`🟠 *High (${high.length}):*`);
      for (const f of high.slice(0, 5)) lines.push(`  - ${f.message || f.checkName || 'Unknown'}`);
    }
    if (medium.length) {
      lines.push(`🟡 *Medium (${medium.length}):*`);
      for (const f of medium.slice(0, 3)) lines.push(`  - ${f.message || f.checkName || 'Unknown'}`);
    }

    if (!critical.length && !high.length && !medium.length) {
      lines.push('✅ No issues found.');
    }

    if (report.regressions) {
      if (report.regressions.regressions > 0) lines.push(`\n⚠️ *${report.regressions.regressions} regression(s) detected*`);
      if (report.regressions.resolved > 0) lines.push(`✅ ${report.regressions.resolved} issue(s) resolved since last scan`);
    }

    return lines.join('\n');
  }

  getLastReport() {
    if (!this.lastReport) return null;
    return { report: this.lastReport, scannedAt: this.lastScanTime };
  }

  // ═══════════════════════════════════════════════════════
  // PART 2: RUNTIME GUARD
  // ═══════════════════════════════════════════════════════

  // Configurable limits — override via config.json { "guard": { ... } }
  get limits() {
    const guard = this.config.guard || {};
    return {
      maxDailySpend:     guard.maxDailySpend     || 5.00,
      maxHourlyRequests: guard.maxHourlyRequests  || 100,
      maxDailyRequests:  guard.maxDailyRequests   || 500,
      maxPerContact:     guard.maxPerContact      || 30,
      alertThreshold:    guard.alertThreshold     || 0.7,
    };
  }

  // Call BEFORE every API request — returns { allowed, reason }
  checkRequest(contact, model, route) {
    this._resetCountersIfNeeded();
    const limits = this.limits;
    const contactKey = contact || 'unknown';
    const contactHourly = this.state.contactRequests[contactKey] || 0;

    if (contactHourly >= limits.maxPerContact) {
      this._logBlocked(contact, model, route, 'per-contact hourly limit');
      return { allowed: false, reason: `Rate limited: ${contactHourly}/${limits.maxPerContact} requests this hour` };
    }
    if (this.state.hourlyRequests >= limits.maxHourlyRequests) {
      this._logBlocked(contact, model, route, 'global hourly limit');
      this._alert('critical', `Hourly request limit hit: ${this.state.hourlyRequests}/${limits.maxHourlyRequests}`);
      return { allowed: false, reason: `System rate limited: ${this.state.hourlyRequests} requests this hour` };
    }
    if (this.state.dailyRequests >= limits.maxDailyRequests) {
      this._logBlocked(contact, model, route, 'global daily limit');
      this._alert('critical', `Daily request limit hit: ${this.state.dailyRequests}/${limits.maxDailyRequests}`);
      return { allowed: false, reason: `Daily limit reached: ${this.state.dailyRequests} requests today` };
    }
    if (this.state.dailySpend >= limits.maxDailySpend) {
      this._logBlocked(contact, model, route, 'daily spend limit');
      this._alert('critical', `Daily spend limit hit: $${this.state.dailySpend.toFixed(2)}/$${limits.maxDailySpend}`);
      return { allowed: false, reason: `Spend limit reached: $${this.state.dailySpend.toFixed(2)} today` };
    }

    // Warn at threshold
    if (this.state.dailySpend >= limits.maxDailySpend * limits.alertThreshold) {
      this._alert('warning', `Approaching spend limit: $${this.state.dailySpend.toFixed(2)}/$${limits.maxDailySpend}`);
    }
    if (this.state.hourlyRequests >= limits.maxHourlyRequests * limits.alertThreshold) {
      this._alert('warning', `Approaching hourly limit: ${this.state.hourlyRequests}/${limits.maxHourlyRequests}`);
    }

    return { allowed: true };
  }

  // Call AFTER every API request — tracks spend
  trackUsage(contact, model, inputTokens, outputTokens, route) {
    this._resetCountersIfNeeded();
    const costs = MODEL_COSTS[model] || MODEL_COSTS['gpt-4o'];
    const cost = ((inputTokens / 1000) * costs.input) + ((outputTokens / 1000) * costs.output);

    this.state.dailySpend += cost;
    this.state.dailyRequests++;
    this.state.hourlyRequests++;
    const contactKey = contact || 'unknown';
    this.state.contactRequests[contactKey] = (this.state.contactRequests[contactKey] || 0) + 1;

    this._logUsage(contact, model, inputTokens, outputTokens, cost, route);
    this._saveState();

    return { cost, dailyTotal: this.state.dailySpend };
  }

  // ─── KEY LEAK PROTECTION ───

  scanForKeyLeak(text) {
    if (!text || typeof text !== 'string') return false;
    for (const p of KEY_PATTERNS) {
      if (p.regex.test(text)) {
        this._alert('critical', `API KEY LEAK DETECTED (${p.name}) in outgoing message — redacted`);
        return true;
      }
    }
    return false;
  }

  redactKeys(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    for (const p of KEY_PATTERNS) {
      result = result.replace(new RegExp(p.regex.source, 'g'), `[${p.name}-KEY-REDACTED]`);
    }
    return result;
  }

  // ─── ANOMALY DETECTION ───

  detectAnomaly(contact) {
    const contactKey = contact || 'unknown';
    const hourlyCount = this.state.contactRequests[contactKey] || 0;
    const limits = this.limits;

    if (hourlyCount > limits.maxPerContact * 0.5 && hourlyCount > 10) {
      return { anomaly: true, reason: `Unusual activity from ${contactKey}: ${hourlyCount} requests this hour` };
    }
    if (this.state.hourlyRequests > limits.maxHourlyRequests * 0.5 && this.state.hourlyRequests > 30) {
      return { anomaly: true, reason: `Unusual global activity: ${this.state.hourlyRequests} requests this hour` };
    }
    return { anomaly: false };
  }

  // ─── GUARD STATUS ───

  getGuardStatus() {
    this._resetCountersIfNeeded();
    const limits = this.limits;
    return {
      dailySpend: `$${this.state.dailySpend.toFixed(2)} / $${limits.maxDailySpend}`,
      dailyRequests: `${this.state.dailyRequests} / ${limits.maxDailyRequests}`,
      hourlyRequests: `${this.state.hourlyRequests} / ${limits.maxHourlyRequests}`,
      topContacts: Object.entries(this.state.contactRequests)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([c, n]) => `${c}: ${n}`),
      recentAlerts: this.state.alerts.slice(-5),
    };
  }

  formatGuardStatus() {
    const s = this.getGuardStatus();
    const lines = [
      '🛡️ *Guardian — Runtime Protection*',
      '',
      `💰 Spend today: ${s.dailySpend}`,
      `📊 Requests today: ${s.dailyRequests}`,
      `⏱️ Requests this hour: ${s.hourlyRequests}`,
    ];
    if (s.topContacts.length) {
      lines.push('', '*Top contacts (this hour):*');
      for (const c of s.topContacts) lines.push(`  - ${c}`);
    }
    if (s.recentAlerts.length) {
      lines.push('', '*Recent alerts:*');
      for (const a of s.recentAlerts) lines.push(`  - [${a.level}] ${a.message}`);
    }
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════

  _migrate() {
    try {
      const rawDb = this.db.db || this.db;
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS guard_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contact TEXT,
          model TEXT,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          estimated_cost REAL DEFAULT 0,
          route TEXT,
          blocked INTEGER DEFAULT 0,
          reason TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_guard_log_created ON guard_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_guard_log_contact ON guard_log(contact);
      `);
    } catch (_) {}
  }

  _loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      }
    } catch (_) {}
    return {
      dailySpend: 0,
      dailyRequests: 0,
      hourlyRequests: 0,
      lastHourReset: Date.now(),
      lastDayReset: Date.now(),
      contactRequests: {},
      alerts: [],
    };
  }

  _saveState() {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2)); } catch (_) {}
  }

  _resetCountersIfNeeded() {
    const now = Date.now();
    if (now - this.state.lastHourReset > 3600000) {
      this.state.hourlyRequests = 0;
      this.state.contactRequests = {};
      this.state.lastHourReset = now;
    }
    if (now - this.state.lastDayReset > 86400000) {
      this.state.dailySpend = 0;
      this.state.dailyRequests = 0;
      this.state.lastDayReset = now;
      this.state.alerts = [];
      this._saveState();
    }
  }

  _logUsage(contact, model, inputTokens, outputTokens, cost, route) {
    try {
      const rawDb = this.db.db || this.db;
      rawDb.prepare(`INSERT INTO guard_log (contact, model, input_tokens, output_tokens, estimated_cost, route) VALUES (?,?,?,?,?,?)`)
        .run(contact || '', model || '', inputTokens || 0, outputTokens || 0, cost || 0, route || '');
    } catch (_) {}
  }

  _logBlocked(contact, model, route, reason) {
    try {
      const rawDb = this.db.db || this.db;
      rawDb.prepare(`INSERT INTO guard_log (contact, model, route, blocked, reason) VALUES (?,?,?,1,?)`)
        .run(contact || '', model || '', route || '', reason);
    } catch (_) {}
  }

  _alert(level, message) {
    const recent = this.state.alerts.slice(-10);
    if (recent.some(a => a.message === message && Date.now() - new Date(a.time).getTime() < 300000)) return;
    const alert = { level, message, time: new Date().toISOString() };
    this.state.alerts.push(alert);
    this._saveState();
    console.warn(`[GUARDIAN] ${level.toUpperCase()}: ${message}`);
    try { this.onAlert(alert); } catch (_) {}
  }
}

module.exports = Guardian;
