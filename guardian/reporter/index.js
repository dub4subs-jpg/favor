"use strict";
// =============================================================================
// Guardian — Phase 11: Reporting Engine & Health Scoring
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
exports.generateReport = generateReport;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const types_1 = require("../types");
function generateReport(systemMap, features, testCoverage, layerResults, regressions, repairs, config, startTime, log) {
    log.section('REPORT GENERATION');
    const allFindings = layerResults.flatMap(lr => lr.results.flatMap(r => r.findings));
    const healthScore = calculateHealthScore(layerResults, allFindings);
    const statusBuckets = buildStatusBuckets(layerResults, features);
    const riskSummary = buildRiskSummary(allFindings);
    const nextActions = buildNextActions(allFindings, regressions, repairs);
    const report = {
        runId: (0, types_1.generateId)(),
        timestamp: new Date().toISOString(),
        target: config.target,
        mode: config.mode,
        scope: config.scope,
        duration: Date.now() - startTime,
        systemMap,
        healthScore,
        statusBuckets,
        findings: allFindings,
        regressions,
        repairs,
        layerResults,
        riskSummary,
        nextActions,
        testCoverage,
    };
    // Save report to file
    saveReport(report, config);
    // Print summary to console
    printReport(report, log);
    return report;
}
// ─── Health Score Calculation ────────────────────────────────────────────────
function calculateHealthScore(layerResults, findings) {
    const layerScores = {};
    for (const lr of layerResults) {
        if (lr.totalChecks === 0) {
            layerScores[lr.layer] = null;
            continue;
        }
        const skipped = lr.results.filter(r => r.skipped).length;
        const effective = lr.totalChecks - skipped;
        if (effective === 0) {
            layerScores[lr.layer] = null;
            continue;
        }
        // Base score from pass rate
        let score = (lr.passed / effective) * 100;
        // Penalty for severity of findings
        const layerFindings = lr.results.flatMap(r => r.findings);
        for (const f of layerFindings) {
            score -= severityPenalty(f.severity);
        }
        layerScores[lr.layer] = Math.max(0, Math.min(100, Math.round(score)));
    }
    // Overall score: weighted average of layer scores
    const weights = {
        frontend: 15, api: 20, database: 20, integration: 10,
        runtime: 20, security: 10, build: 5,
    };
    let totalWeight = 0;
    let weightedSum = 0;
    for (const [layer, score] of Object.entries(layerScores)) {
        if (score !== null) {
            const weight = weights[layer] || 10;
            totalWeight += weight;
            weightedSum += score * weight;
        }
    }
    const overall = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    // Additional penalty for critical findings
    const criticals = findings.filter(f => f.severity === 'critical').length;
    const finalOverall = Math.max(0, overall - (criticals * 15));
    return {
        overall: finalOverall,
        frontend: layerScores['frontend'] ?? null,
        backend: layerScores['api'] ?? null,
        api: layerScores['api'] ?? null,
        database: layerScores['database'] ?? null,
        integration: layerScores['integration'] ?? null,
        runtime: layerScores['runtime'] ?? null,
        security: layerScores['security'] ?? null,
        build: layerScores['build'] ?? null,
    };
}
function severityPenalty(severity) {
    switch (severity) {
        case 'critical': return 20;
        case 'high': return 10;
        case 'medium': return 5;
        case 'low': return 2;
        case 'info': return 0;
    }
}
// ─── Status Buckets ─────────────────────────────────────────────────────────
function buildStatusBuckets(layerResults, features) {
    const confirmed = [];
    const partiallyWorking = [];
    const broken = [];
    const untested = [];
    const blocked = [];
    for (const lr of layerResults) {
        for (const result of lr.results) {
            if (result.skipped) {
                blocked.push(`[${lr.layer}] ${result.checkName}: ${result.skipReason || 'skipped'}`);
            }
            else if (result.passed) {
                confirmed.push(`[${lr.layer}] ${result.checkName}`);
            }
            else if (result.findings.some(f => f.severity === 'critical' || f.severity === 'high')) {
                broken.push(`[${lr.layer}] ${result.checkName}`);
            }
            else {
                partiallyWorking.push(`[${lr.layer}] ${result.checkName}`);
            }
        }
    }
    // Find untested features
    const testedLayers = new Set(layerResults.map(lr => lr.layer));
    for (const feature of features) {
        const hasValidation = feature.validationLayers.some(vl => testedLayers.has(vl));
        if (!hasValidation) {
            untested.push(`${feature.name} (needs: ${feature.validationLayers.join(', ')})`);
        }
    }
    return { confirmed, partiallyWorking, broken, untested, blocked };
}
// ─── Risk Summary ───────────────────────────────────────────────────────────
function buildRiskSummary(findings) {
    const classify = (layers) => {
        const relevant = findings.filter(f => layers.includes(f.layer));
        if (relevant.some(f => f.severity === 'critical'))
            return 'critical';
        if (relevant.some(f => f.severity === 'high'))
            return 'high';
        if (relevant.some(f => f.severity === 'medium'))
            return 'medium';
        if (relevant.length > 0)
            return 'low';
        return 'info';
    };
    return {
        operational: classify(['runtime']),
        dataIntegrity: classify(['database']),
        integration: classify(['integration', 'api']),
        performance: classify(['runtime', 'build']),
        securityConfig: classify(['security']),
    };
}
// ─── Next Actions ───────────────────────────────────────────────────────────
function buildNextActions(findings, regressions, repairs) {
    const immediate = [];
    const nearTerm = [];
    const later = [];
    // Regressions are always immediate
    const regressionsFound = regressions.filter(r => r.type === 'regression');
    if (regressionsFound.length > 0) {
        immediate.push(`Fix ${regressionsFound.length} regression(s): ${regressionsFound.map(r => r.finding.title).slice(0, 3).join(', ')}`);
    }
    // Critical and high findings
    const criticals = findings.filter(f => f.severity === 'critical');
    const highs = findings.filter(f => f.severity === 'high');
    const mediums = findings.filter(f => f.severity === 'medium');
    const lows = findings.filter(f => f.severity === 'low');
    for (const f of criticals) {
        immediate.push(`[CRITICAL] ${f.recommendedAction} — ${f.title}`);
    }
    for (const f of highs.slice(0, 5)) {
        immediate.push(`[HIGH] ${f.recommendedAction}`);
    }
    for (const f of mediums.slice(0, 5)) {
        nearTerm.push(`[MEDIUM] ${f.recommendedAction}`);
    }
    for (const f of lows.slice(0, 3)) {
        later.push(`[LOW] ${f.recommendedAction}`);
    }
    // Failed repairs
    const failedRepairs = repairs.filter(r => r.applied && !r.retestPassed);
    if (failedRepairs.length > 0) {
        nearTerm.push(`Review ${failedRepairs.length} failed repair attempt(s)`);
    }
    return { immediate, nearTerm, later };
}
// ─── Report Output ──────────────────────────────────────────────────────────
function saveReport(report, config) {
    const dir = path.join(config.target, config.baselineDir || '.guardian');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const reportPath = path.join(dir, 'last-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    // Also save timestamped report
    const tsPath = path.join(dir, `report-${report.runId}.json`);
    fs.writeFileSync(tsPath, JSON.stringify(report, null, 2));
}
function printReport(report, log) {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║               GUARDIAN — HEALTH REPORT                      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    // Health Score
    const scoreBar = buildScoreBar(report.healthScore.overall);
    console.log(`\n  OVERALL HEALTH: ${scoreBar} ${report.healthScore.overall}/100`);
    const layers = [
        ['Frontend', report.healthScore.frontend],
        ['API', report.healthScore.api],
        ['Database', report.healthScore.database],
        ['Integration', report.healthScore.integration],
        ['Runtime', report.healthScore.runtime],
        ['Security', report.healthScore.security],
        ['Build', report.healthScore.build],
    ];
    for (const [name, score] of layers) {
        if (score !== null) {
            console.log(`  ${name.padEnd(14)} ${buildScoreBar(score)} ${score}/100`);
        }
    }
    // Status Buckets
    console.log('\n  STATUS:');
    console.log(`    ✓ Confirmed:   ${report.statusBuckets.confirmed.length}`);
    console.log(`    ~ Partial:     ${report.statusBuckets.partiallyWorking.length}`);
    console.log(`    ✗ Broken:      ${report.statusBuckets.broken.length}`);
    console.log(`    ? Untested:    ${report.statusBuckets.untested.length}`);
    console.log(`    ⊘ Blocked:     ${report.statusBuckets.blocked.length}`);
    // Findings Summary
    const critCount = report.findings.filter(f => f.severity === 'critical').length;
    const highCount = report.findings.filter(f => f.severity === 'high').length;
    const medCount = report.findings.filter(f => f.severity === 'medium').length;
    const lowCount = report.findings.filter(f => f.severity === 'low').length;
    console.log(`\n  FINDINGS: ${report.findings.length} total`);
    if (critCount)
        console.log(`    CRITICAL: ${critCount}`);
    if (highCount)
        console.log(`    HIGH:     ${highCount}`);
    if (medCount)
        console.log(`    MEDIUM:   ${medCount}`);
    if (lowCount)
        console.log(`    LOW:      ${lowCount}`);
    // Top findings
    const topFindings = report.findings
        .sort((a, b) => severityPenalty(b.severity) - severityPenalty(a.severity))
        .slice(0, 8);
    if (topFindings.length > 0) {
        console.log('\n  TOP FINDINGS:');
        for (const f of topFindings) {
            const icon = f.severity === 'critical' ? '!!' :
                f.severity === 'high' ? '! ' : '  ';
            console.log(`    ${icon} [${f.severity.toUpperCase().padEnd(8)}] ${f.title}`);
            if (f.recommendedAction) {
                console.log(`       → ${f.recommendedAction}`);
            }
        }
    }
    // Regressions
    const regressions = report.regressions.filter(r => r.type === 'regression');
    const resolved = report.regressions.filter(r => r.type === 'resolved');
    if (regressions.length > 0 || resolved.length > 0) {
        console.log('\n  REGRESSIONS:');
        if (regressions.length > 0) {
            console.log(`    !! ${regressions.length} new regression(s):`);
            for (const r of regressions.slice(0, 5)) {
                console.log(`       - ${r.finding.title}`);
            }
        }
        if (resolved.length > 0) {
            console.log(`    ✓  ${resolved.length} resolved since last run`);
        }
    }
    // Repairs
    if (report.repairs.length > 0) {
        const applied = report.repairs.filter(r => r.applied);
        const verified = report.repairs.filter(r => r.retestPassed);
        console.log(`\n  REPAIRS: ${applied.length} applied, ${verified.length} verified`);
        for (const r of report.repairs.slice(0, 5)) {
            const status = r.retestPassed ? '✓' : r.applied ? '?' : '✗';
            console.log(`    ${status} ${r.description} (${path.basename(r.filePath)})`);
        }
    }
    // Risk Summary
    console.log('\n  RISK ASSESSMENT:');
    console.log(`    Operational:    ${riskIcon(report.riskSummary.operational)} ${report.riskSummary.operational}`);
    console.log(`    Data Integrity: ${riskIcon(report.riskSummary.dataIntegrity)} ${report.riskSummary.dataIntegrity}`);
    console.log(`    Integration:    ${riskIcon(report.riskSummary.integration)} ${report.riskSummary.integration}`);
    console.log(`    Performance:    ${riskIcon(report.riskSummary.performance)} ${report.riskSummary.performance}`);
    console.log(`    Security:       ${riskIcon(report.riskSummary.securityConfig)} ${report.riskSummary.securityConfig}`);
    // Next Actions
    if (report.nextActions.immediate.length > 0) {
        console.log('\n  IMMEDIATE ACTIONS:');
        for (const a of report.nextActions.immediate.slice(0, 5)) {
            console.log(`    → ${a}`);
        }
    }
    if (report.nextActions.nearTerm.length > 0) {
        console.log('\n  NEAR-TERM:');
        for (const a of report.nextActions.nearTerm.slice(0, 3)) {
            console.log(`    → ${a}`);
        }
    }
    // Footer
    console.log(`\n  Duration: ${(report.duration / 1000).toFixed(1)}s | Mode: ${report.mode} | Target: ${report.target}`);
    console.log(`  Report saved: .guardian/last-report.json`);
    console.log('');
}
function buildScoreBar(score) {
    const filled = Math.round(score / 5);
    const empty = 20 - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    if (score >= 80)
        return `[${bar}]`;
    if (score >= 60)
        return `[${bar}]`;
    if (score >= 40)
        return `[${bar}]`;
    return `[${bar}]`;
}
function riskIcon(severity) {
    switch (severity) {
        case 'critical': return '!!';
        case 'high': return '! ';
        case 'medium': return '~ ';
        case 'low': return '  ';
        case 'info': return '✓ ';
    }
}
//# sourceMappingURL=index.js.map