"use strict";
// =============================================================================
// Guardian — Continuous Monitoring Mode
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMonitor = startMonitor;
const child_process_1 = require("child_process");
async function startMonitor(config, log, callbacks) {
    const intervalMs = (config.monitorInterval || 300) * 1000;
    log.section('MONITOR MODE');
    log.info(`Starting continuous monitoring (interval: ${config.monitorInterval}s)`);
    log.info('Press Ctrl+C to stop\n');
    let runCount = 0;
    let lastHealthScore = -1;
    const runCycle = async () => {
        runCount++;
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        log.info(`\n── Monitor Run #${runCount} (${timestamp}) ──`);
        try {
            const report = await callbacks.runScan();
            const score = report.healthScore.overall;
            const findings = report.findings.length;
            const criticals = report.findings.filter(f => f.severity === 'critical').length;
            const regressions = report.regressions.filter(r => r.type === 'regression').length;
            // Log status
            const delta = lastHealthScore >= 0 ? ` (${score > lastHealthScore ? '+' : ''}${score - lastHealthScore})` : '';
            log.info(`  Health: ${score}/100${delta} | Findings: ${findings} | Critical: ${criticals} | Regressions: ${regressions}`);
            // Alert on degradation
            if (lastHealthScore >= 0 && score < lastHealthScore - 10) {
                log.warn(`  ALERT: Health score dropped by ${lastHealthScore - score} points!`);
                sendAlert(config, `Guardian Alert: Health score dropped from ${lastHealthScore} to ${score}`);
            }
            // Alert on new critical findings
            if (criticals > 0) {
                log.warn(`  ALERT: ${criticals} critical finding(s)!`);
                const criticalTitles = report.findings
                    .filter(f => f.severity === 'critical')
                    .map(f => f.title)
                    .slice(0, 3)
                    .join(', ');
                sendAlert(config, `Guardian Critical: ${criticalTitles}`);
            }
            // Alert on regressions
            if (regressions > 0) {
                log.warn(`  ALERT: ${regressions} regression(s) detected!`);
                sendAlert(config, `Guardian Regression: ${regressions} regression(s) detected`);
            }
            lastHealthScore = score;
            if (callbacks.onAlert && (criticals > 0 || regressions > 0)) {
                callbacks.onAlert(report);
            }
        }
        catch (err) {
            log.error(`  Monitor run failed: ${err.message}`);
            sendAlert(config, `Guardian Error: Monitor run failed — ${err.message}`);
        }
    };
    // Run immediately
    await runCycle();
    // Schedule recurring runs
    const interval = setInterval(runCycle, intervalMs);
    // Handle graceful shutdown
    const cleanup = () => {
        log.info('\nMonitor shutting down...');
        clearInterval(interval);
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    // Keep alive
    await new Promise(() => { });
}
function sendAlert(config, message) {
    if (!config.notifyCommand)
        return;
    try {
        const cmd = config.notifyCommand.replace('{{message}}', message.replace(/'/g, "\\'"));
        (0, child_process_1.execSync)(cmd, { encoding: 'utf-8', timeout: 15000 });
    }
    catch {
        // Alert delivery failure — already logged the issue
    }
}
//# sourceMappingURL=index.js.map