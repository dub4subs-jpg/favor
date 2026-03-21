"use strict";
// =============================================================================
// Guardian — Phase 2: Existing Test & Tooling Discovery
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
exports.discoverTests = discoverTests;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
async function discoverTests(systemMap, log) {
    log.section('TEST DISCOVERY');
    const assets = [];
    const root = systemMap.rootPath;
    // ─── Playwright ──────────────────────────────────────────────────────
    if (systemMap.testFrameworks.includes('playwright')) {
        const testFiles = findTestFiles(root, ['**/*.spec.ts', '**/*.spec.js', '**/*.test.ts', '**/*.test.js'], ['node_modules', '.git', 'dist']);
        const playwrightTests = testFiles.filter(f => isPlaywrightTest(path.join(root, f)));
        if (playwrightTests.length > 0) {
            log.info(`Playwright: ${playwrightTests.length} spec files`);
            for (const t of playwrightTests) {
                assets.push({
                    framework: 'playwright',
                    path: t,
                    type: classifyTestType(t),
                    runCommand: `npx playwright test ${path.basename(t, path.extname(t))}`,
                    coveredAreas: inferCoveredAreas(t),
                });
            }
        }
    }
    // ─── Jest ────────────────────────────────────────────────────────────
    if (systemMap.testFrameworks.includes('jest')) {
        const testFiles = findTestFiles(root, ['**/*.test.ts', '**/*.test.js', '**/*.test.tsx', '**/*.test.jsx',
            '**/__tests__/**/*.ts', '**/__tests__/**/*.js'], ['node_modules', '.git', 'dist']);
        const jestTests = testFiles.filter(f => !isPlaywrightTest(path.join(root, f)));
        if (jestTests.length > 0) {
            log.info(`Jest: ${jestTests.length} test files`);
            for (const t of jestTests) {
                assets.push({
                    framework: 'jest',
                    path: t,
                    type: classifyTestType(t),
                    runCommand: `npx jest ${t}`,
                    coveredAreas: inferCoveredAreas(t),
                });
            }
        }
    }
    // ─── Vitest ──────────────────────────────────────────────────────────
    if (systemMap.testFrameworks.includes('vitest')) {
        const testFiles = findTestFiles(root, ['**/*.test.ts', '**/*.test.js', '**/*.spec.ts'], ['node_modules', '.git', 'dist']);
        if (testFiles.length > 0) {
            log.info(`Vitest: ${testFiles.length} test files`);
            for (const t of testFiles) {
                assets.push({
                    framework: 'vitest',
                    path: t,
                    type: classifyTestType(t),
                    runCommand: `npx vitest run ${t}`,
                    coveredAreas: inferCoveredAreas(t),
                });
            }
        }
    }
    // ─── Cypress ─────────────────────────────────────────────────────────
    if (systemMap.testFrameworks.includes('cypress')) {
        const testFiles = findTestFiles(root, ['cypress/**/*.cy.ts', 'cypress/**/*.cy.js',
            'cypress/**/*.spec.ts', 'cypress/**/*.spec.js'], ['node_modules']);
        if (testFiles.length > 0) {
            log.info(`Cypress: ${testFiles.length} spec files`);
            for (const t of testFiles) {
                assets.push({
                    framework: 'cypress',
                    path: t,
                    type: 'e2e',
                    runCommand: `npx cypress run --spec ${t}`,
                    coveredAreas: inferCoveredAreas(t),
                });
            }
        }
    }
    // ─── Pytest ──────────────────────────────────────────────────────────
    if (systemMap.testFrameworks.includes('pytest')) {
        const testFiles = findTestFiles(root, ['**/test_*.py', '**/*_test.py', 'tests/**/*.py'], ['__pycache__', '.git', 'venv', '.venv']);
        if (testFiles.length > 0) {
            log.info(`Pytest: ${testFiles.length} test files`);
            for (const t of testFiles) {
                assets.push({
                    framework: 'pytest',
                    path: t,
                    type: classifyTestType(t),
                    runCommand: `pytest ${t}`,
                    coveredAreas: inferCoveredAreas(t),
                });
            }
        }
    }
    // ─── Go test ─────────────────────────────────────────────────────────
    if (systemMap.testFrameworks.includes('go-test')) {
        const testFiles = findTestFiles(root, ['**/*_test.go'], ['.git', 'vendor']);
        if (testFiles.length > 0) {
            log.info(`Go test: ${testFiles.length} test files`);
            for (const t of testFiles) {
                assets.push({
                    framework: 'go-test',
                    path: t,
                    type: 'unit',
                    runCommand: `go test ./${path.dirname(t)}/...`,
                    coveredAreas: inferCoveredAreas(t),
                });
            }
        }
    }
    // ─── CI Scripts ──────────────────────────────────────────────────────
    const ciScripts = [];
    const ciPaths = [
        '.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile',
        '.circleci/config.yml', '.travis.yml', 'Makefile',
    ];
    for (const ci of ciPaths) {
        const fullPath = path.join(root, ci);
        if (fs.existsSync(fullPath)) {
            if (fs.statSync(fullPath).isDirectory()) {
                try {
                    const files = fs.readdirSync(fullPath);
                    ciScripts.push(...files.map(f => path.join(ci, f)));
                }
                catch { /* skip */ }
            }
            else {
                ciScripts.push(ci);
            }
        }
    }
    if (ciScripts.length > 0) {
        log.info(`CI/CD scripts: ${ciScripts.join(', ')}`);
    }
    // ─── Lint tools ──────────────────────────────────────────────────────
    const lintCommands = [];
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (pkg.scripts?.lint)
                lintCommands.push('npm run lint');
            if (pkg.scripts?.['type-check'] || pkg.scripts?.typecheck) {
                lintCommands.push(pkg.scripts?.['type-check'] ? 'npm run type-check' : 'npm run typecheck');
            }
        }
        catch { /* skip */ }
    }
    // ─── Coverage Analysis ───────────────────────────────────────────────
    const allCoveredAreas = new Set();
    for (const asset of assets) {
        asset.coveredAreas.forEach(a => allCoveredAreas.add(a));
    }
    // Determine uncovered areas from system map
    const allAreas = new Set();
    for (const comp of systemMap.components) {
        if (comp.type !== 'test' && comp.type !== 'config') {
            allAreas.add(comp.type);
        }
    }
    const uncoveredAreas = Array.from(allAreas).filter(a => !allCoveredAreas.has(a));
    const coverage = {
        assets,
        coveredAreas: Array.from(allCoveredAreas),
        uncoveredAreas,
        existingRunners: lintCommands,
        ciScripts,
    };
    log.success(`Test discovery complete: ${assets.length} test files, ${lintCommands.length} lint commands`);
    if (uncoveredAreas.length > 0) {
        log.warn(`Uncovered areas: ${uncoveredAreas.join(', ')}`);
    }
    return coverage;
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
function findTestFiles(root, patterns, ignore) {
    const results = [];
    try {
        // Use find command for cross-platform compatibility
        const ignoreArgs = ignore.map(i => `-not -path '*/${i}/*'`).join(' ');
        for (const pattern of patterns) {
            // Convert glob to find pattern
            const findPattern = pattern.replace('**/', '').replace('*', '*');
            try {
                const output = (0, child_process_1.execSync)(`find "${root}" -type f -name "${findPattern}" ${ignoreArgs} 2>/dev/null`, { encoding: 'utf-8', timeout: 10000 }).trim();
                if (output) {
                    for (const line of output.split('\n')) {
                        const rel = path.relative(root, line.trim());
                        if (rel && !results.includes(rel))
                            results.push(rel);
                    }
                }
            }
            catch { /* skip */ }
        }
    }
    catch { /* skip */ }
    return results;
}
function isPlaywrightTest(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 500);
        return content.includes('@playwright/test') || content.includes('playwright');
    }
    catch {
        return false;
    }
}
function classifyTestType(testPath) {
    const lower = testPath.toLowerCase();
    if (lower.includes('e2e') || lower.includes('end-to-end') || lower.includes('spec'))
        return 'e2e';
    if (lower.includes('integration') || lower.includes('integ'))
        return 'integration';
    if (lower.includes('visual') || lower.includes('screenshot') || lower.includes('walkthrough'))
        return 'visual';
    if (lower.includes('api') || lower.includes('health'))
        return 'api';
    if (lower.includes('unit'))
        return 'unit';
    return 'other';
}
function inferCoveredAreas(testPath) {
    const areas = [];
    const lower = testPath.toLowerCase();
    if (lower.includes('auth') || lower.includes('login'))
        areas.push('auth');
    if (lower.includes('dashboard'))
        areas.push('dashboard');
    if (lower.includes('product'))
        areas.push('products');
    if (lower.includes('api') || lower.includes('health'))
        areas.push('api');
    if (lower.includes('nav'))
        areas.push('navigation');
    if (lower.includes('report'))
        areas.push('reports');
    if (lower.includes('pipeline'))
        areas.push('pipeline');
    if (lower.includes('crud'))
        areas.push('crud');
    if (lower.includes('button') || lower.includes('ui') || lower.includes('component'))
        areas.push('ui');
    if (lower.includes('visual') || lower.includes('walkthrough'))
        areas.push('visual');
    if (lower.includes('form'))
        areas.push('forms');
    if (lower.includes('worker') || lower.includes('job'))
        areas.push('workers');
    if (lower.includes('agent') || lower.includes('bot'))
        areas.push('agents');
    if (lower.includes('webhook') || lower.includes('integration'))
        areas.push('integrations');
    if (lower.includes('db') || lower.includes('database') || lower.includes('migration'))
        areas.push('database');
    if (areas.length === 0)
        areas.push('general');
    return areas;
}
//# sourceMappingURL=tests.js.map