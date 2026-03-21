"use strict";
// =============================================================================
// Guardian — Phase 4: Validation Orchestrator
// =============================================================================
// Runs all validation layers based on the system map and configuration.
Object.defineProperty(exports, "__esModule", { value: true });
exports.runValidation = runValidation;
const frontend_1 = require("./frontend");
const api_1 = require("./api");
const database_1 = require("./database");
const integration_1 = require("./integration");
const runtime_1 = require("./runtime");
const security_1 = require("./security");
const build_1 = require("./build");
async function runValidation(systemMap, features, testCoverage, config, log) {
    log.section('VALIDATION');
    const layers = getLayersForMode(config.mode, config.scope, systemMap);
    log.info(`Running layers: ${layers.join(', ')}`);
    const results = [];
    for (const layer of layers) {
        const start = Date.now();
        try {
            let layerResults;
            switch (layer) {
                case 'frontend':
                    layerResults = await (0, frontend_1.validateFrontend)(systemMap, features, config, log);
                    break;
                case 'api':
                    layerResults = await (0, api_1.validateApi)(systemMap, features, config, log);
                    break;
                case 'database':
                    layerResults = await (0, database_1.validateDatabase)(systemMap, features, config, log);
                    break;
                case 'integration':
                    layerResults = await (0, integration_1.validateIntegrations)(systemMap, features, config, log);
                    break;
                case 'runtime':
                    layerResults = await (0, runtime_1.validateRuntime)(systemMap, features, testCoverage, config, log);
                    break;
                case 'security':
                    layerResults = await (0, security_1.validateSecurity)(systemMap, features, config, log);
                    break;
                case 'build':
                    layerResults = await (0, build_1.validateBuild)(systemMap, config, log);
                    break;
                default:
                    layerResults = [];
            }
            const duration = Date.now() - start;
            const passed = layerResults.filter(r => r.passed).length;
            const failed = layerResults.filter(r => !r.passed && !r.skipped).length;
            const skipped = layerResults.filter(r => r.skipped).length;
            results.push({
                layer,
                results: layerResults,
                totalChecks: layerResults.length,
                passed,
                failed,
                skipped,
                duration,
            });
            const statusIcon = failed > 0 ? '✗' : '✓';
            log.info(`  ${statusIcon} ${layer}: ${passed} passed, ${failed} failed, ${skipped} skipped (${duration}ms)`);
        }
        catch (err) {
            const duration = Date.now() - start;
            log.error(`  ${layer}: ERROR — ${err.message}`);
            results.push({
                layer,
                results: [],
                totalChecks: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                duration,
            });
        }
    }
    // Also run existing test suites if available
    if (testCoverage.assets.length > 0 && shouldRunExistingTests(config.mode)) {
        log.info('Running existing test suites...');
        const existingResults = await runExistingTests(testCoverage, systemMap, config, log);
        if (existingResults) {
            results.push(existingResults);
        }
    }
    const totalFindings = results.reduce((sum, lr) => sum + lr.results.reduce((s, r) => s + r.findings.length, 0), 0);
    log.success(`Validation complete: ${totalFindings} findings across ${layers.length} layers`);
    return results;
}
function getLayersForMode(mode, scope, systemMap) {
    // Scope-based filtering
    if (scope !== 'full') {
        const scopeLayerMap = {
            frontend: ['frontend', 'build', 'security'],
            backend: ['api', 'database', 'runtime', 'security', 'build'],
            api: ['api', 'security'],
            workers: ['runtime'],
            agents: ['runtime', 'integration'],
            integrations: ['integration', 'security'],
            database: ['database'],
        };
        return scopeLayerMap[scope] || ['frontend', 'api', 'database', 'runtime', 'security', 'build'];
    }
    // Mode-based selection
    switch (mode) {
        case 'smoke':
            return ['api', 'runtime', 'build'];
        case 'feature':
            return ['frontend', 'api', 'database', 'runtime'];
        case 'deep':
            return ['frontend', 'api', 'database', 'integration', 'runtime', 'security', 'build'];
        case 'regression':
            return ['frontend', 'api', 'database', 'runtime', 'build'];
        case 'repair':
            return ['frontend', 'api', 'database', 'runtime', 'build', 'security'];
        case 'deploy':
            return ['api', 'database', 'runtime', 'build', 'security'];
        case 'monitor':
            return ['api', 'runtime', 'database'];
        case 'targeted':
            return ['frontend', 'api', 'database', 'runtime', 'security', 'build'];
        default:
            return ['frontend', 'api', 'database', 'integration', 'runtime', 'security', 'build'];
    }
}
function shouldRunExistingTests(mode) {
    return ['deep', 'feature', 'regression', 'deploy'].includes(mode);
}
async function runExistingTests(testCoverage, systemMap, config, log) {
    const { execSync } = require('child_process');
    const results = [];
    const start = Date.now();
    // Run detected test framework suite
    const pkgPath = require('path').join(systemMap.rootPath, 'package.json');
    if (require('fs').existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf-8'));
            if (pkg.scripts?.test) {
                log.info('  Running project test suite...');
                try {
                    const output = execSync('npm test 2>&1', {
                        cwd: systemMap.rootPath,
                        encoding: 'utf-8',
                        timeout: config.timeout * 3,
                    });
                    results.push({
                        layer: 'runtime',
                        checkName: 'existing-test-suite',
                        passed: true,
                        duration: Date.now() - start,
                        findings: [],
                        details: `Test suite passed.\n${output.slice(-500)}`,
                        skipped: false,
                    });
                    log.success('  Test suite passed');
                }
                catch (err) {
                    const output = err.stdout || err.stderr || err.message || '';
                    const { createFinding } = require('../types');
                    results.push({
                        layer: 'runtime',
                        checkName: 'existing-test-suite',
                        passed: false,
                        duration: Date.now() - start,
                        findings: [createFinding({
                                severity: 'high',
                                layer: 'runtime',
                                subsystem: 'test-suite',
                                title: 'Existing test suite failed',
                                description: `The project's own test suite failed`,
                                evidence: output.slice(-1000),
                                likelyCause: 'Test failures in the existing suite',
                                confidence: 'high',
                                recommendedAction: 'Review test failures and fix failing tests',
                            })],
                        details: `Test suite FAILED.\n${output.slice(-1000)}`,
                        skipped: false,
                    });
                    log.error('  Test suite failed');
                }
            }
        }
        catch { /* skip */ }
    }
    // Run lint if available
    for (const lintCmd of testCoverage.existingRunners) {
        try {
            log.info(`  Running: ${lintCmd}...`);
            execSync(lintCmd, { cwd: systemMap.rootPath, encoding: 'utf-8', timeout: config.timeout });
            results.push({
                layer: 'build',
                checkName: `lint: ${lintCmd}`,
                passed: true,
                duration: 0,
                findings: [],
                details: 'Lint passed',
                skipped: false,
            });
        }
        catch (err) {
            const { createFinding } = require('../types');
            results.push({
                layer: 'build',
                checkName: `lint: ${lintCmd}`,
                passed: false,
                duration: 0,
                findings: [createFinding({
                        severity: 'medium',
                        layer: 'build',
                        subsystem: 'lint',
                        title: `Lint check failed: ${lintCmd}`,
                        description: 'Lint or type-check reported errors',
                        evidence: (err.stdout || err.message || '').slice(-500),
                        likelyCause: 'Code style or type errors',
                        confidence: 'high',
                        recommendedAction: 'Fix lint/type errors',
                    })],
                details: `Lint FAILED.\n${(err.stdout || err.message || '').slice(-500)}`,
                skipped: false,
            });
        }
    }
    if (results.length === 0)
        return null;
    return {
        layer: 'runtime',
        results,
        totalChecks: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        skipped: 0,
        duration: Date.now() - start,
    };
}
//# sourceMappingURL=runner.js.map