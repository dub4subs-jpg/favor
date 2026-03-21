// guardian.js — Guardian integration for Favor
// Wraps the Guardian QA/watchdog framework as a Favor skill
// Runs scans on any project and returns structured health reports

const path = require('path');
const { runGuardian } = require('./guardian/index');
const { loadConfig } = require('./guardian/config');

class Guardian {
  constructor() {
    this.lastReport = null;
    this.lastScanTime = null;
  }

  // ─── RUN A SCAN ───
  // mode: smoke | quick | feature | deep | regression | repair | deploy
  // scope: full | frontend | backend | api | database | security
  async scan(targetDir, { mode = 'quick', scope = 'full', verbose = false, repair = false } = {}) {
    const config = loadConfig({
      target: path.resolve(targetDir),
      mode,
      scope,
      verbose,
      allowRepair: repair,
      repairLevel: repair ? 'safe' : 'none',
      timeout: 60000,
    });

    // Capture console output since Guardian prints to stdout
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    };

    try {
      const report = await runGuardian(config);
      this.lastReport = report;
      this.lastScanTime = new Date().toISOString();
      return { report, logs: logs.join('\n') };
    } finally {
      console.log = origLog;
    }
  }

  // ─── FORMAT REPORT FOR WHATSAPP ───
  // Takes the raw report and formats it for readable WhatsApp output
  formatReport(report) {
    if (!report) return 'No scan results available.';

    const lines = [];
    lines.push(`*Guardian Health Report*`);
    lines.push(`Score: *${report.healthScore?.overall ?? '??'}/100*`);
    lines.push('');

    // Layer summary
    if (report.layers && report.layers.length) {
      lines.push('*Validation Layers:*');
      for (const layer of report.layers) {
        const icon = layer.failed === 0 ? '✅' : '❌';
        lines.push(`${icon} ${layer.layer}: ${layer.passed}/${layer.passed + layer.failed} passed`);
      }
      lines.push('');
    }

    // Findings
    const critical = (report.findings || []).filter(f => f.severity === 'critical');
    const high = (report.findings || []).filter(f => f.severity === 'high');
    const medium = (report.findings || []).filter(f => f.severity === 'medium');

    if (critical.length) {
      lines.push(`🔴 *Critical (${critical.length}):*`);
      for (const f of critical.slice(0, 5)) {
        lines.push(`  - ${f.message || f.checkName || 'Unknown'}`);
      }
    }
    if (high.length) {
      lines.push(`🟠 *High (${high.length}):*`);
      for (const f of high.slice(0, 5)) {
        lines.push(`  - ${f.message || f.checkName || 'Unknown'}`);
      }
    }
    if (medium.length) {
      lines.push(`🟡 *Medium (${medium.length}):*`);
      for (const f of medium.slice(0, 3)) {
        lines.push(`  - ${f.message || f.checkName || 'Unknown'}`);
      }
    }

    if (!critical.length && !high.length && !medium.length) {
      lines.push('✅ No issues found.');
    }

    // Regressions
    if (report.regressions) {
      const reg = report.regressions;
      if (reg.regressions > 0) {
        lines.push(`\n⚠️ *${reg.regressions} regression(s) detected*`);
      }
      if (reg.resolved > 0) {
        lines.push(`✅ ${reg.resolved} issue(s) resolved since last scan`);
      }
    }

    return lines.join('\n');
  }

  // ─── GET LAST REPORT ───
  getLastReport() {
    if (!this.lastReport) return null;
    return {
      report: this.lastReport,
      scannedAt: this.lastScanTime,
    };
  }
}

module.exports = Guardian;
