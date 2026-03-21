"use strict";
// =============================================================================
// Guardian — Build / Compile Validation
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
exports.validateBuild = validateBuild;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const types_1 = require("../types");
async function validateBuild(systemMap, config, log) {
    const results = [];
    log.info('  Build validation...');
    // TypeScript type checking
    if (systemMap.languages.includes('typescript')) {
        results.push(checkTypeScript(systemMap, config, log));
    }
    // ESLint
    results.push(checkLint(systemMap, config, log));
    // Build output freshness
    results.push(checkBuildFreshness(systemMap, config, log));
    // Package.json sanity
    results.push(checkPackageJson(systemMap, config, log));
    return results;
}
function checkTypeScript(systemMap, config, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    if (!fs.existsSync(path.join(root, 'tsconfig.json'))) {
        return {
            layer: 'build', checkName: 'typescript',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'No tsconfig.json found', skipped: true,
        };
    }
    try {
        (0, child_process_1.execSync)('npx tsc --noEmit 2>&1', {
            cwd: root, encoding: 'utf-8', timeout: 60000,
        });
        return {
            layer: 'build', checkName: 'typescript',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'TypeScript compilation successful', skipped: false,
        };
    }
    catch (err) {
        const output = (err.stdout || err.stderr || err.message || '').slice(-2000);
        const errorCount = (output.match(/error TS\d+/g) || []).length;
        return {
            layer: 'build', checkName: 'typescript',
            passed: false, duration: Date.now() - start,
            findings: [(0, types_1.createFinding)({
                    severity: 'high', layer: 'build', subsystem: 'typescript',
                    title: `TypeScript: ${errorCount} type error(s)`,
                    description: 'TypeScript type-check failed',
                    evidence: output.slice(-500),
                    likelyCause: 'Type errors in source code',
                    confidence: 'high',
                    recommendedAction: 'Fix type errors (npx tsc --noEmit)',
                })],
            details: `TypeScript: ${errorCount} error(s)`, skipped: false,
        };
    }
}
function checkLint(systemMap, config, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    // Check if ESLint is available
    const hasEslint = fs.existsSync(path.join(root, 'node_modules', '.bin', 'eslint')) ||
        fs.existsSync(path.join(root, 'eslint.config.mjs')) ||
        fs.existsSync(path.join(root, '.eslintrc.js')) ||
        fs.existsSync(path.join(root, '.eslintrc.json'));
    if (!hasEslint) {
        return {
            layer: 'build', checkName: 'lint',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'No linter configured', skipped: true,
        };
    }
    // Check if there's a lint script
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
        if (pkg.scripts?.lint) {
            try {
                (0, child_process_1.execSync)('npm run lint 2>&1', {
                    cwd: root, encoding: 'utf-8', timeout: 60000,
                });
                return {
                    layer: 'build', checkName: 'lint',
                    passed: true, duration: Date.now() - start, findings: [],
                    details: 'Lint passed', skipped: false,
                };
            }
            catch (err) {
                const output = (err.stdout || err.stderr || '').slice(-2000);
                // Parse error/warning counts from ESLint summary line
                const summaryMatch = output.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/);
                const errorCount = summaryMatch ? parseInt(summaryMatch[2], 10) : 0;
                const warningCount = summaryMatch ? parseInt(summaryMatch[3], 10) : 0;
                // Check if errors are only in non-app files (scripts, legacy JS, config)
                const errorLines = output.split('\n').filter((l) => l.includes('error'));
                const appErrorLines = errorLines.filter((l) => !l.includes('update-batch') && !l.includes('watchdog.js') &&
                    !l.includes('.config.') && !l.includes('scripts/') &&
                    (l.includes('/app/') || l.includes('/src/') || l.includes('/lib/') ||
                        l.includes('/components/') || l.includes('/pages/')));
                // Only fail if there are errors in actual app code (not legacy scripts)
                const hasAppErrors = appErrorLines.length > 0;
                const severity = hasAppErrors ? 'medium' : 'low';
                return {
                    layer: 'build', checkName: 'lint',
                    passed: !hasAppErrors,
                    duration: Date.now() - start,
                    findings: [(0, types_1.createFinding)({
                            severity,
                            layer: 'build', subsystem: 'lint',
                            title: hasAppErrors
                                ? `Lint: ${errorCount} errors in app code`
                                : `Lint: ${errorCount} errors in non-app files (${warningCount} warnings)`,
                            description: hasAppErrors
                                ? 'ESLint found errors in application source code'
                                : 'ESLint errors are only in legacy scripts/config files — app code is clean',
                            evidence: output.slice(-500),
                            likelyCause: hasAppErrors
                                ? 'Code style or correctness issues in app code'
                                : 'Legacy scripts using CommonJS require() or other non-app patterns',
                            confidence: 'high',
                            recommendedAction: hasAppErrors
                                ? 'Fix lint errors in app code'
                                : 'Consider adding legacy scripts to .eslintignore',
                        })],
                    details: hasAppErrors
                        ? `Lint FAILED: ${errorCount} errors in app code`
                        : `Lint: ${errorCount} errors (non-app only), ${warningCount} warnings`,
                    skipped: false,
                };
            }
        }
    }
    catch { /* skip */ }
    return {
        layer: 'build', checkName: 'lint',
        passed: true, duration: Date.now() - start, findings: [],
        details: 'No lint script in package.json', skipped: true,
    };
}
function checkBuildFreshness(systemMap, config, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const buildDirs = ['.next', 'dist', 'build', 'out', 'target'];
    const findings = [];
    for (const dir of buildDirs) {
        const buildPath = path.join(root, dir);
        if (!fs.existsSync(buildPath))
            continue;
        try {
            const buildStat = fs.statSync(buildPath);
            const buildAge = Date.now() - buildStat.mtimeMs;
            const hoursSinceBuild = buildAge / (1000 * 60 * 60);
            // Find newest source file
            const srcDirs = ['src', 'app', 'pages', 'lib', 'components'];
            let newestSrc = 0;
            for (const srcDir of srcDirs) {
                const srcPath = path.join(root, srcDir);
                if (fs.existsSync(srcPath)) {
                    try {
                        const stat = fs.statSync(srcPath);
                        newestSrc = Math.max(newestSrc, stat.mtimeMs);
                    }
                    catch { /* skip */ }
                }
            }
            if (newestSrc > buildStat.mtimeMs) {
                findings.push((0, types_1.createFinding)({
                    severity: 'medium', layer: 'build', subsystem: 'freshness',
                    title: `Build output stale: ${dir}/`,
                    description: 'Source files are newer than build output',
                    evidence: `Build: ${new Date(buildStat.mtimeMs).toISOString()}, Source newer`,
                    likelyCause: 'Build not run after source changes',
                    confidence: 'medium',
                    recommendedAction: 'Rebuild the project',
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'build', checkName: 'build-freshness',
        passed: findings.length === 0,
        duration: Date.now() - start, findings,
        details: findings.length === 0 ? 'Build output is current' : `${findings.length} stale build(s)`,
        skipped: false,
    };
}
function checkPackageJson(systemMap, config, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        return {
            layer: 'build', checkName: 'package-json',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'No package.json', skipped: true,
        };
    }
    const findings = [];
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        // Check for missing important scripts
        const importantScripts = ['build', 'start'];
        for (const script of importantScripts) {
            if (!pkg.scripts?.[script]) {
                findings.push((0, types_1.createFinding)({
                    severity: 'low', layer: 'build', subsystem: 'package',
                    title: `Missing script: ${script}`,
                    description: `package.json has no "${script}" script`,
                    evidence: `scripts.${script} not defined`,
                    likelyCause: 'Script not configured',
                    confidence: 'high',
                    recommendedAction: `Add a "${script}" script to package.json`,
                }));
            }
        }
        // Check for missing engines field
        if (!pkg.engines) {
            findings.push((0, types_1.createFinding)({
                severity: 'low', layer: 'build', subsystem: 'package',
                title: 'Missing engines field',
                description: 'package.json has no engines field — Node version not specified',
                evidence: 'engines field not found',
                likelyCause: 'Not configured',
                confidence: 'high',
                recommendedAction: 'Add engines.node to specify required Node.js version',
            }));
        }
    }
    catch (err) {
        findings.push((0, types_1.createFinding)({
            severity: 'high', layer: 'build', subsystem: 'package',
            title: 'Invalid package.json',
            description: `Cannot parse package.json: ${err.message}`,
            evidence: err.message,
            likelyCause: 'Malformed JSON',
            confidence: 'high',
            recommendedAction: 'Fix package.json syntax',
        }));
    }
    return {
        layer: 'build', checkName: 'package-json',
        passed: findings.filter(f => f.severity !== 'low').length === 0,
        duration: Date.now() - start, findings,
        details: `${findings.length} package.json issue(s)`, skipped: false,
    };
}
//# sourceMappingURL=build.js.map