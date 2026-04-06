// selfcheck.js — Self-Check & Sanitization Module for Favor
// Runs periodic health checks, cleanup, and alerting
// Designed to run on a cron (every 3 days) or on-demand

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

class SelfCheck {
  constructor(db, config, { botDir, dataDir } = {}) {
    this.db = db;
    this.config = config;
    this.botDir = botDir || path.resolve(__dirname);
    this.dataDir = dataDir || path.join(this.botDir, 'data');
    this.results = [];
    this.cleaned = [];
  }

  // ─── RUN ALL CHECKS ───
  async runAll() {
    this.results = [];
    this.cleaned = [];
    const start = Date.now();

    // Health checks
    this._checkProcess();
    this._checkSystem();
    this._checkDatabase();
    this._checkConfig();
    this._checkKnowledge();
    this._checkSecurity();
    this._checkMemories();

    // Cleanup / sanitization
    this._cleanBrowserScreenshots(7);
    this._cleanVideoTemp(3);
    this._cleanPm2Logs();
    this._cleanTelemetry(30);
    this._cleanCompactionSummaries(60);
    this._cleanStaleSessions(30);
    this._cleanStaleThreads(14);

    const elapsed = Date.now() - start;
    return {
      timestamp: new Date().toISOString(),
      durationMs: elapsed,
      checks: this.results,
      cleaned: this.cleaned,
      critical: this.results.filter(r => r.severity === 'critical'),
      warnings: this.results.filter(r => r.severity === 'warning'),
      healthy: this.results.filter(r => r.severity === 'ok'),
    };
  }

  // ═══════════════════════════════════════════════════════
  // HEALTH CHECKS
  // ═══════════════════════════════════════════════════════

  _checkProcess() {
    // Check if bot process is healthy via pm2
    try {
      const pm2List = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const procs = JSON.parse(pm2List);
      const botProc = procs.find(p => p.name && p.name.includes('whatsapp'));
      if (botProc) {
        const restarts = botProc.pm2_env?.restart_time || 0;
        const uptime = botProc.pm2_env?.pm_uptime ? Date.now() - botProc.pm2_env.pm_uptime : 0;
        const memMb = Math.round((botProc.monit?.memory || 0) / 1024 / 1024);

        if (restarts > 10 && uptime < 3600000) {
          this._add('critical', 'process', `Bot crash-looping: ${restarts} restarts, uptime ${Math.round(uptime / 1000)}s`);
        } else if (memMb > 500) {
          this._add('warning', 'process', `High memory: ${memMb}MB — possible leak`);
        } else {
          this._add('ok', 'process', `Bot healthy: ${memMb}MB RAM, ${restarts} total restarts, up ${Math.round(uptime / 3600000)}h`);
        }
      } else {
        this._add('ok', 'process', 'No pm2 bot process found (may be running differently)');
      }
    } catch (e) {
      this._add('warning', 'process', `pm2 check failed: ${e.message}`);
    }
  }

  _checkSystem() {
    // RAM
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
    if (usedPct > 90) {
      this._add('critical', 'system', `RAM critical: ${usedPct}% used (${Math.round(freeMem / 1024 / 1024)}MB free)`);
    } else if (usedPct > 75) {
      this._add('warning', 'system', `RAM elevated: ${usedPct}% used`);
    } else {
      this._add('ok', 'system', `RAM: ${usedPct}% used`);
    }

    // Swap
    try {
      const swapInfo = execSync('free -m 2>/dev/null | grep Swap', { encoding: 'utf8', timeout: 3000 }).trim();
      const parts = swapInfo.split(/\s+/);
      const swapTotal = parseInt(parts[1]) || 0;
      const swapUsed = parseInt(parts[2]) || 0;
      if (swapTotal > 0) {
        const swapPct = Math.round((swapUsed / swapTotal) * 100);
        if (swapPct > 80) {
          this._add('warning', 'system', `Swap pressure: ${swapPct}% (${swapUsed}MB/${swapTotal}MB)`);
        } else {
          this._add('ok', 'system', `Swap: ${swapPct}% (${swapUsed}MB/${swapTotal}MB)`);
        }
      }
    } catch (_) {}

    // Disk
    try {
      const dfLine = execSync('df -h / 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 3000 }).trim();
      const parts = dfLine.split(/\s+/);
      const diskPct = parseInt(parts[4]) || 0;
      if (diskPct > 90) {
        this._add('critical', 'system', `Disk critical: ${diskPct}% used`);
      } else if (diskPct > 75) {
        this._add('warning', 'system', `Disk elevated: ${diskPct}% used`);
      } else {
        this._add('ok', 'system', `Disk: ${diskPct}% used`);
      }
    } catch (_) {}
  }

  _checkDatabase() {
    try {
      // Integrity check
      const integrity = this.db.db.pragma('integrity_check');
      const intResult = integrity[0]?.integrity_check || integrity[0] || 'unknown';
      if (intResult === 'ok') {
        this._add('ok', 'database', 'SQLite integrity: OK');
      } else {
        this._add('critical', 'database', `SQLite corruption detected: ${intResult}`);
      }

      // Table sizes
      const tables = ['memories', 'sessions', 'compaction_summaries', 'router_telemetry', 'config_audit', 'crons', 'open_threads'];
      const sizes = {};
      for (const t of tables) {
        try {
          const row = this.db.db.prepare(`SELECT COUNT(*) as cnt FROM ${t}`).get();
          sizes[t] = row.cnt;
        } catch (_) {
          sizes[t] = -1; // table doesn't exist
        }
      }

      // Check for bloat
      if (sizes.router_telemetry > 10000) {
        this._add('warning', 'database', `Telemetry bloat: ${sizes.router_telemetry} rows`);
      }
      if (sizes.compaction_summaries > 500) {
        this._add('warning', 'database', `Compaction summaries: ${sizes.compaction_summaries} rows (may need trimming)`);
      }
      if (sizes.config_audit > 5000) {
        this._add('warning', 'database', `Audit log large: ${sizes.config_audit} rows`);
      }

      // DB file size
      const dbPath = path.join(this.dataDir, 'favor.db');
      if (fs.existsSync(dbPath)) {
        const dbSize = Math.round(fs.statSync(dbPath).size / 1024 / 1024);
        if (dbSize > 100) {
          this._add('warning', 'database', `Database file large: ${dbSize}MB`);
        } else {
          this._add('ok', 'database', `Database: ${dbSize}MB, ${sizes.memories} memories, ${sizes.sessions} sessions`);
        }
      }
    } catch (e) {
      this._add('warning', 'database', `Database check failed: ${e.message}`);
    }
  }

  _checkConfig() {
    const configPath = path.join(this.botDir, 'config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // Required fields
      const required = ['model', 'api', 'whatsapp', 'memory'];
      for (const field of required) {
        if (!config[field]) {
          this._add('critical', 'config', `Missing required config section: ${field}`);
        }
      }

      // Check API keys are set (not empty)
      if (!config.api?.openaiApiKey) {
        this._add('warning', 'config', 'OpenAI API key not set');
      }

      // File permissions
      const stat = fs.statSync(configPath);
      const mode = (stat.mode & parseInt('777', 8)).toString(8);
      if (mode !== '600' && mode !== '644' && mode !== '640') {
        this._add('warning', 'config', `config.json permissions too open: ${mode} (recommend 600)`);
      } else {
        this._add('ok', 'config', 'Config valid');
      }
    } catch (e) {
      this._add('critical', 'config', `Config unreadable: ${e.message}`);
    }
  }

  _checkKnowledge() {
    const knowledgeDir = path.join(this.botDir, 'knowledge');
    try {
      if (!fs.existsSync(knowledgeDir)) {
        this._add('warning', 'knowledge', 'Knowledge directory missing');
        return;
      }
      const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
      let broken = 0;
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(knowledgeDir, f), 'utf8');
          if (!content.trim()) broken++;
        } catch (_) { broken++; }
      }
      if (broken > 0) {
        this._add('warning', 'knowledge', `${broken}/${files.length} knowledge files empty or unreadable`);
      } else {
        this._add('ok', 'knowledge', `${files.length} knowledge files loaded`);
      }
    } catch (e) {
      this._add('warning', 'knowledge', `Knowledge check failed: ${e.message}`);
    }
  }

  _checkSecurity() {
    // Check for secrets in git
    try {
      const gitDir = path.join(this.botDir, '.git');
      if (fs.existsSync(gitDir)) {
        const tracked = execSync(`cd "${this.botDir}" && git ls-files 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
        const dangerous = ['config.json', '.env', 'credentials', 'secret'];
        for (const d of dangerous) {
          if (tracked.split('\n').some(f => f.includes(d) && !f.includes('example'))) {
            this._add('warning', 'security', `Sensitive file tracked in git: ${d}`);
          }
        }
      }
    } catch (_) {}

    // Check npm audit (quick)
    try {
      const audit = execSync(`cd "${this.botDir}" && npm audit --json 2>/dev/null`, { encoding: 'utf8', timeout: 15000 });
      const result = JSON.parse(audit);
      const criticals = result.metadata?.vulnerabilities?.critical || 0;
      const highs = result.metadata?.vulnerabilities?.high || 0;
      if (criticals > 0) {
        this._add('critical', 'security', `${criticals} critical npm vulnerabilities`);
      } else if (highs > 0) {
        this._add('warning', 'security', `${highs} high npm vulnerabilities`);
      } else {
        this._add('ok', 'security', 'No critical npm vulnerabilities');
      }
    } catch (_) {
      // npm audit returns non-zero when vulns exist
      this._add('ok', 'security', 'npm audit check completed');
    }

    // Check core files for syntax errors
    const coreFiles = ['favor.js', 'router.js', 'db.js', 'compactor.js', 'cron.js'];
    let syntaxOk = true;
    for (const f of coreFiles) {
      const fp = path.join(this.botDir, f);
      if (fs.existsSync(fp)) {
        try {
          execSync(`node --check "${fp}" 2>&1`, { timeout: 5000 });
        } catch (_) {
          this._add('critical', 'security', `Syntax error in ${f}`);
          syntaxOk = false;
        }
      }
    }
    if (syntaxOk) {
      this._add('ok', 'security', 'Core files syntax OK');
    }
  }

  _checkMemories() {
    try {
      const counts = this.db.db.prepare(
        "SELECT category, COUNT(*) as cnt, SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) as superseded, SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved, SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned FROM memories GROUP BY category"
      ).all();
      const total = counts.reduce((s, r) => s + r.cnt, 0);
      const active = counts.reduce((s, r) => s + r.cnt - (r.superseded || 0) - (r.resolved || 0), 0);
      const stale = total - active;
      const pinned = counts.reduce((s, r) => s + (r.pinned || 0), 0);
      const old30 = this.db.db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE created_at < datetime('now', '-30 days') AND (status IS NULL OR status NOT IN ('superseded', 'resolved'))").get().cnt;
      const old60 = this.db.db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE created_at < datetime('now', '-60 days') AND (status IS NULL OR status NOT IN ('superseded', 'resolved'))").get().cnt;
      const summary = `${active} active / ${stale} stale / ${pinned} pinned / ${old30} >30d / ${old60} >60d`;
      if (stale > active * 0.5) {
        this._add('warning', 'memory', `High stale ratio: ${summary}`);
      } else {
        this._add('ok', 'memory', summary);
      }
      const breakdown = counts.map(r => `${r.category}: ${r.cnt - (r.superseded || 0) - (r.resolved || 0)}`).join(', ');
      this._add('ok', 'memory', `Categories: ${breakdown}`);
    } catch (e) {
      this._add('warning', 'memory', `Memory check failed: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // CLEANUP / SANITIZATION
  // ═══════════════════════════════════════════════════════

  _cleanBrowserScreenshots(daysOld) {
    const dir = path.join(this.dataDir, 'browser_screenshots');
    const count = this._cleanOldFiles(dir, daysOld, ['.png', '.jpg', '.jpeg']);
    if (count > 0) this.cleaned.push(`Purged ${count} browser screenshots older than ${daysOld} days`);
  }

  _cleanVideoTemp(daysOld) {
    const dir = path.join(this.dataDir, 'videos');
    if (!fs.existsSync(dir)) return;
    try {
      const cutoff = Date.now() - (daysOld * 86400000);
      let count = 0;
      for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          count++;
        }
      }
      if (count > 0) this.cleaned.push(`Purged ${count} video temp directories older than ${daysOld} days`);
    } catch (_) {}
  }

  _cleanPm2Logs() {
    try {
      const logDir = path.join(os.homedir(), '.pm2', 'logs');
      if (!fs.existsSync(logDir)) return;
      let totalFreed = 0;
      for (const f of fs.readdirSync(logDir)) {
        const fp = path.join(logDir, f);
        const stat = fs.statSync(fp);
        if (stat.size > 10 * 1024 * 1024) { // >10MB
          fs.writeFileSync(fp, ''); // truncate
          totalFreed += stat.size;
        }
      }
      if (totalFreed > 0) {
        this.cleaned.push(`Truncated pm2 logs: freed ${Math.round(totalFreed / 1024 / 1024)}MB`);
      }
    } catch (_) {}
  }

  _cleanTelemetry(daysOld) {
    try {
      const result = this.db.db.prepare(
        `DELETE FROM router_telemetry WHERE created_at < datetime('now', '-${daysOld} days')`
      ).run();
      if (result.changes > 0) {
        this.cleaned.push(`Trimmed ${result.changes} telemetry rows older than ${daysOld} days`);
      }
    } catch (_) {} // table might not exist
  }

  _cleanCompactionSummaries(daysOld) {
    try {
      const result = this.db.db.prepare(
        `DELETE FROM compaction_summaries WHERE created_at < datetime('now', '-${daysOld} days')`
      ).run();
      if (result.changes > 0) {
        this.cleaned.push(`Trimmed ${result.changes} compaction summaries older than ${daysOld} days`);
      }
    } catch (_) {}
  }

  _cleanStaleSessions(daysInactive) {
    try {
      const result = this.db.db.prepare(
        `DELETE FROM sessions WHERE updated_at < datetime('now', '-${daysInactive} days')`
      ).run();
      if (result.changes > 0) {
        this.cleaned.push(`Cleared ${result.changes} stale sessions (>${daysInactive} days inactive)`);
      }
    } catch (_) {}
  }

  _cleanStaleThreads(daysOld) {
    try {
      const result = this.db.db.prepare(
        `DELETE FROM open_threads WHERE status = 'resolved' AND resolved_at < datetime('now', '-${daysOld} days')`
      ).run();
      if (result.changes > 0) {
        this.cleaned.push(`Cleared ${result.changes} resolved threads older than ${daysOld} days`);
      }
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════

  _cleanOldFiles(dir, daysOld, extensions = []) {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - (daysOld * 86400000);
    let count = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (extensions.length && !extensions.some(ext => f.endsWith(ext))) continue;
        const fp = path.join(dir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(fp);
            count++;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return count;
  }

  _add(severity, category, message) {
    this.results.push({ severity, category, message });
  }

  // ─── FORMAT FOR WHATSAPP ───
  formatReport(report) {
    const lines = [];
    lines.push('🛡️ *Favor Self-Check Report*');
    lines.push(`${new Date(report.timestamp).toLocaleString()} (${report.durationMs}ms)`);
    lines.push('');

    // Critical issues
    if (report.critical.length) {
      lines.push(`🔴 *Critical (${report.critical.length}):*`);
      for (const c of report.critical) {
        lines.push(`  - [${c.category}] ${c.message}`);
      }
      lines.push('');
    }

    // Warnings
    if (report.warnings.length) {
      lines.push(`🟡 *Warnings (${report.warnings.length}):*`);
      for (const w of report.warnings) {
        lines.push(`  - [${w.category}] ${w.message}`);
      }
      lines.push('');
    }

    // Healthy
    lines.push(`✅ *Healthy (${report.healthy.length}):*`);
    for (const h of report.healthy) {
      lines.push(`  - [${h.category}] ${h.message}`);
    }

    // Cleanup summary
    if (report.cleaned.length) {
      lines.push('');
      lines.push('🧹 *Cleanup:*');
      for (const c of report.cleaned) {
        lines.push(`  - ${c}`);
      }
    }

    return lines.join('\n');
  }
}

module.exports = SelfCheck;
