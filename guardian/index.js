"use strict";
// =============================================================================
// Guardian — Main Orchestrator
// =============================================================================
// Coordinates all phases: discovery → validation → analysis → repair → report
Object.defineProperty(exports, "__esModule", { value: true });
exports.runGuardian = runGuardian;
exports.runGuardianMonitor = runGuardianMonitor;
const types_1 = require("./types");
const project_1 = require("./discovery/project");
const tests_1 = require("./discovery/tests");
const features_1 = require("./discovery/features");
const runner_1 = require("./validators/runner");
const tracker_1 = require("./regression/tracker");
const logs_1 = require("./analyzer/logs");
const engine_1 = require("./repair/engine");
const index_1 = require("./reporter/index");
const index_2 = require("./monitor/index");
async function runGuardian(config) {
    const startTime = Date.now();
    const log = (0, types_1.createLogger)(config.verbose);
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                    GUARDIAN                                 ║');
    console.log('║          Universal QA / Watchdog Framework                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`  Mode: ${config.mode} | Scope: ${config.scope} | Target: ${config.target}`);
    // ─── Phase 1: Project Discovery ────────────────────────────────────
    const systemMap = await (0, project_1.discoverProject)(config, log);
    // ─── Phase 2: Test Discovery ───────────────────────────────────────
    const testCoverage = await (0, tests_1.discoverTests)(systemMap, log);
    // ─── Phase 3: Feature Discovery ────────────────────────────────────
    const features = await (0, features_1.discoverFeatures)(systemMap, config, log);
    // ─── Phase 4: Validation ───────────────────────────────────────────
    const layerResults = await (0, runner_1.runValidation)(systemMap, features, testCoverage, config, log);
    // ─── Phase 5: Regression Analysis ──────────────────────────────────
    const regressionTracker = new tracker_1.RegressionTracker(config, log);
    const healthScorePreview = layerResults.reduce((sum, lr) => {
        const eff = lr.totalChecks - lr.skipped;
        return sum + (eff > 0 ? (lr.passed / eff) * 100 : 0);
    }, 0) / Math.max(1, layerResults.filter(lr => lr.totalChecks - lr.skipped > 0).length);
    const regressions = regressionTracker.analyzeRegressions(layerResults, Math.round(healthScorePreview));
    // ─── Phase 6: Log Analysis ─────────────────────────────────────────
    if (['deep', 'deploy', 'monitor'].includes(config.mode)) {
        const logAnalysis = await (0, logs_1.analyzeLogs)(systemMap, config, log);
        // Merge log findings into runtime layer results
        if (logAnalysis.findings.length > 0) {
            const runtimeLayer = layerResults.find(lr => lr.layer === 'runtime');
            if (runtimeLayer) {
                runtimeLayer.results.push({
                    layer: 'runtime',
                    checkName: 'log-analysis',
                    passed: logAnalysis.findings.filter(f => f.severity === 'critical' || f.severity === 'high').length === 0,
                    duration: 0,
                    findings: logAnalysis.findings,
                    details: logAnalysis.summary,
                    skipped: false,
                });
                runtimeLayer.totalChecks++;
                if (logAnalysis.findings.some(f => f.severity === 'critical' || f.severity === 'high')) {
                    runtimeLayer.failed++;
                }
                else {
                    runtimeLayer.passed++;
                }
            }
        }
    }
    // ─── Phase 8: Repair ──────────────────────────────────────────────
    const repairEngine = new engine_1.RepairEngine(config, log);
    let repairs = await repairEngine.processFindings(layerResults);
    // ─── Phase 11: Report ──────────────────────────────────────────────
    const report = (0, index_1.generateReport)(systemMap, features, testCoverage, layerResults, regressions, repairs, config, startTime, log);
    // Update baseline after report
    regressionTracker.updateBaseline(layerResults, report.healthScore.overall);
    return report;
}
async function runGuardianMonitor(config) {
    const log = (0, types_1.createLogger)(config.verbose);
    // Override mode for each scan cycle
    const scanConfig = {
        ...config,
        mode: 'smoke', // Use smoke mode for recurring checks
    };
    await (0, index_2.startMonitor)(config, log, {
        runScan: async () => {
            return runGuardian(scanConfig);
        },
    });
}
//# sourceMappingURL=index.js.map