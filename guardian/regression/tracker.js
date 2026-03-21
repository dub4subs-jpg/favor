"use strict";
// =============================================================================
// Guardian — Phase 5: Regression Detection & Baseline System
// =============================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegressionTracker = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const types_1 = require("../types");
const BASELINE_FILE = 'baseline.json';
const HISTORY_FILE = 'history.json';
const MAX_HISTORY = 50;
class RegressionTracker {
    config;
    log;
    baselineDir;
    baseline = null;
    history = [];
    constructor(config, log) {
        this.config = config;
        this.log = log;
        this.baselineDir = path.join(config.target, config.baselineDir || '.guardian');
        this.loadBaseline();
        this.loadHistory();
    }
    // ─── Load / Save ────────────────────────────────────────────────────
    loadBaseline() {
        const filePath = path.join(this.baselineDir, BASELINE_FILE);
        if (fs.existsSync(filePath)) {
            try {
                this.baseline = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                this.log.debug(`Loaded baseline from ${filePath} (${this.baseline?.timestamp})`);
            }
            catch {
                this.log.warn('Could not load baseline — starting fresh');
            }
        }
    }
    loadHistory() {
        const filePath = path.join(this.baselineDir, HISTORY_FILE);
        if (fs.existsSync(filePath)) {
            try {
                this.history = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                this.log.debug(`Loaded ${this.history.length} historical runs`);
            }
            catch {
                this.history = [];
            }
        }
    }
    ensureDir() {
        if (!fs.existsSync(this.baselineDir)) {
            fs.mkdirSync(this.baselineDir, { recursive: true });
        }
    }
    saveBaseline(baseline) {
        this.ensureDir();
        fs.writeFileSync(path.join(this.baselineDir, BASELINE_FILE), JSON.stringify(baseline, null, 2));
        this.baseline = baseline;
    }
    saveHistory() {
        this.ensureDir();
        // Keep only recent runs
        this.history = this.history.slice(-MAX_HISTORY);
        fs.writeFileSync(path.join(this.baselineDir, HISTORY_FILE), JSON.stringify(this.history, null, 2));
    }
    // ─── Analysis ──────────────────────────────────────────────────────
    analyzeRegressions(layerResults, healthScore) {
        this.log.section('REGRESSION ANALYSIS');
        const currentFindings = layerResults.flatMap(lr => lr.results.flatMap(r => r.findings));
        const currentChecks = layerResults.flatMap(lr => lr.results.map(r => ({
            checkName: r.checkName,
            passed: r.passed,
            layer: lr.layer,
        })));
        if (!this.baseline) {
            this.log.info('No baseline found — this run will become the baseline');
            return currentFindings.map(f => ({
                type: 'new',
                finding: f,
                occurrenceCount: 1,
            }));
        }
        const regressions = [];
        // Compare current findings against baseline
        for (const finding of currentFindings) {
            const baselineMatch = this.findSimilarFinding(finding, this.baseline.findings);
            const historyMatches = this.countHistoryOccurrences(finding);
            if (baselineMatch) {
                // Issue existed before — recurring
                regressions.push({
                    type: 'recurring',
                    finding,
                    previousOccurrence: this.baseline.timestamp,
                    occurrenceCount: historyMatches + 1,
                });
            }
            else {
                // Check if this is a regression (check used to pass)
                const previouslyPassed = this.baseline.checkResults.some(cr => cr.checkName === finding.subsystem && cr.passed);
                if (previouslyPassed) {
                    regressions.push({
                        type: 'regression',
                        finding: { ...finding, status: 'regression' },
                        occurrenceCount: 1,
                    });
                }
                else {
                    regressions.push({
                        type: 'new',
                        finding,
                        occurrenceCount: 1,
                    });
                }
            }
        }
        // Check for resolved issues (in baseline but not in current)
        for (const baselineFinding of this.baseline.findings) {
            const stillPresent = this.findSimilarFinding(baselineFinding, currentFindings);
            if (!stillPresent) {
                regressions.push({
                    type: 'resolved',
                    finding: { ...baselineFinding, status: 'fixed' },
                    previousOccurrence: this.baseline.timestamp,
                    occurrenceCount: 0,
                });
            }
        }
        // Log summary
        const newCount = regressions.filter(r => r.type === 'new').length;
        const regCount = regressions.filter(r => r.type === 'regression').length;
        const recCount = regressions.filter(r => r.type === 'recurring').length;
        const resCount = regressions.filter(r => r.type === 'resolved').length;
        this.log.info(`New: ${newCount} | Regressions: ${regCount} | Recurring: ${recCount} | Resolved: ${resCount}`);
        if (regCount > 0) {
            this.log.warn(`REGRESSIONS DETECTED: ${regCount} previously passing check(s) now failing`);
        }
        if (resCount > 0) {
            this.log.success(`${resCount} issue(s) resolved since last baseline`);
        }
        return regressions;
    }
    // ─── Update Baseline ───────────────────────────────────────────────
    updateBaseline(layerResults, healthScore) {
        const baseline = {
            runId: (0, types_1.generateId)(),
            timestamp: new Date().toISOString(),
            targetPath: this.config.target,
            mode: this.config.mode,
            healthScore,
            findings: layerResults.flatMap(lr => lr.results.flatMap(r => r.findings)),
            checkResults: layerResults.flatMap(lr => lr.results.map(r => ({
                checkName: r.checkName,
                passed: r.passed,
                layer: lr.layer,
            }))),
        };
        this.saveBaseline(baseline);
        // Also add to history
        this.history.push(baseline);
        this.saveHistory();
        this.log.success('Baseline updated');
    }
    // ─── Helpers ───────────────────────────────────────────────────────
    findSimilarFinding(target, candidates) {
        return candidates.find(c => c.title === target.title ||
            (c.subsystem === target.subsystem && c.layer === target.layer &&
                c.severity === target.severity && c.filePath === target.filePath)) || null;
    }
    countHistoryOccurrences(finding) {
        let count = 0;
        for (const run of this.history) {
            if (this.findSimilarFinding(finding, run.findings))
                count++;
        }
        return count;
    }
    hasBaseline() {
        return this.baseline !== null;
    }
    getBaseline() {
        return this.baseline;
    }
    getHealthTrend() {
        return this.history.map(h => ({
            timestamp: h.timestamp,
            score: h.healthScore,
        }));
    }
}
exports.RegressionTracker = RegressionTracker;
//# sourceMappingURL=tracker.js.map