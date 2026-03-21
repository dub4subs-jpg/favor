"use strict";
// =============================================================================
// Guardian — Layers F+G: Runtime & Operational Health Validation
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
exports.validateRuntime = validateRuntime;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const types_1 = require("../types");
async function validateRuntime(systemMap, features, testCoverage, config, log) {
    const results = [];
    log.info('  Runtime validation...');
    // Check 1: Process health (pm2, systemd, docker)
    results.push(checkProcessHealth(systemMap, config, log));
    // Check 2: Port availability
    results.push(checkPortHealth(systemMap, config, log));
    // Check 3: Disk space
    results.push(checkDiskSpace(config, log));
    // Check 4: Memory usage
    results.push(checkMemoryUsage(config, log));
    // Check 5: Node.js version compatibility
    if (systemMap.languages.includes('typescript') || systemMap.languages.includes('javascript')) {
        results.push(checkNodeVersion(systemMap, config, log));
    }
    // Check 6: Dependency health
    results.push(checkDependencyHealth(systemMap, config, log));
    // Check 7: Lock file consistency
    results.push(checkLockFileConsistency(systemMap, config, log));
    return results;
}
function checkProcessHealth(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    // Check pm2 processes
    try {
        const pm2Output = (0, child_process_1.execSync)('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 10000 });
        const processes = JSON.parse(pm2Output);
        for (const proc of processes) {
            if (proc.pm2_env?.status === 'errored') {
                findingsList.push((0, types_1.createFinding)({
                    severity: 'critical', layer: 'runtime', subsystem: 'process',
                    title: `pm2 process errored: ${proc.name}`,
                    description: `Process ${proc.name} (id ${proc.pm_id}) is in errored state`,
                    evidence: `Status: ${proc.pm2_env.status}, Restarts: ${proc.pm2_env.restart_time}`,
                    likelyCause: 'Process crashed and cannot recover',
                    confidence: 'high',
                    recommendedAction: 'Check pm2 logs and fix the error, then restart',
                }));
            }
            else if (proc.pm2_env?.restart_time > 50) {
                // High restart count (>50) suggests a crash loop. Lower counts (10-50)
                // are normal over days/weeks of uptime with deployments and updates.
                findingsList.push((0, types_1.createFinding)({
                    severity: 'high', layer: 'runtime', subsystem: 'process',
                    title: `pm2 process unstable: ${proc.name}`,
                    description: `Process ${proc.name} has restarted ${proc.pm2_env.restart_time} times`,
                    evidence: `Restart count: ${proc.pm2_env.restart_time}`,
                    likelyCause: 'Recurring crash causing restart loop',
                    confidence: 'high',
                    recommendedAction: 'Investigate crash cause in pm2 error logs',
                }));
            }
        }
    }
    catch {
        // pm2 not installed or not running — that's OK
    }
    // Check docker
    try {
        const dockerOutput = (0, child_process_1.execSync)('docker ps --format "{{.Names}}\t{{.Status}}" 2>/dev/null', {
            encoding: 'utf-8', timeout: 10000,
        });
        for (const line of dockerOutput.trim().split('\n').filter(Boolean)) {
            const [name, status] = line.split('\t');
            if (status && !status.includes('Up')) {
                findingsList.push((0, types_1.createFinding)({
                    severity: 'high', layer: 'runtime', subsystem: 'docker',
                    title: `Docker container not running: ${name}`,
                    description: `Container ${name} status: ${status}`,
                    evidence: `Status: ${status}`,
                    likelyCause: 'Container crashed or was stopped',
                    confidence: 'high',
                    recommendedAction: 'Check docker logs and restart the container',
                }));
            }
        }
    }
    catch {
        // Docker not installed — that's OK
    }
    return {
        layer: 'runtime', checkName: 'process-health',
        passed: findingsList.filter(f => f.severity === 'critical' || f.severity === 'high').length === 0,
        duration: Date.now() - start, findings: findingsList,
        details: `${findingsList.length} process issue(s)`, skipped: false,
    };
}
function checkPortHealth(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    for (const port of systemMap.ports) {
        try {
            const result = (0, child_process_1.execSync)(`ss -tlnp 2>/dev/null | grep :${port} || true`, {
                encoding: 'utf-8', timeout: 5000,
            }).trim();
            if (!result) {
                findingsList.push((0, types_1.createFinding)({
                    severity: 'high', layer: 'runtime', subsystem: 'ports',
                    title: `Expected port ${port} not listening`,
                    description: `Port ${port} is referenced in config but nothing is listening`,
                    evidence: `ss -tlnp shows no listener on port ${port}`,
                    likelyCause: 'Service not started or using a different port',
                    confidence: 'medium',
                    recommendedAction: 'Start the service or update the port configuration',
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'runtime', checkName: 'port-health',
        passed: findingsList.length === 0,
        duration: Date.now() - start, findings: findingsList,
        details: `${systemMap.ports.length} port(s) checked`,
        skipped: systemMap.ports.length === 0,
    };
}
function checkDiskSpace(config, log) {
    const start = Date.now();
    try {
        const dfOutput = (0, child_process_1.execSync)(`df -h "${config.target}" | tail -1`, {
            encoding: 'utf-8', timeout: 5000,
        });
        const parts = dfOutput.trim().split(/\s+/);
        const usePercent = parseInt(parts[4]?.replace('%', '') || '0', 10);
        const findings = [];
        if (usePercent > 90) {
            findings.push((0, types_1.createFinding)({
                severity: 'critical', layer: 'runtime', subsystem: 'disk',
                title: `Disk usage critical: ${usePercent}%`,
                description: `Disk is ${usePercent}% full (${parts[3]} available)`,
                evidence: dfOutput.trim(),
                likelyCause: 'Logs, data, or builds consuming disk space',
                confidence: 'high',
                recommendedAction: 'Free up disk space immediately',
            }));
        }
        else if (usePercent > 80) {
            findings.push((0, types_1.createFinding)({
                severity: 'medium', layer: 'runtime', subsystem: 'disk',
                title: `Disk usage high: ${usePercent}%`,
                description: `Disk is ${usePercent}% full (${parts[3]} available)`,
                evidence: dfOutput.trim(),
                likelyCause: 'Data accumulation',
                confidence: 'high',
                recommendedAction: 'Monitor disk usage and clean up old files',
            }));
        }
        return {
            layer: 'runtime', checkName: 'disk-space',
            passed: usePercent <= 90,
            duration: Date.now() - start, findings,
            details: `Disk usage: ${usePercent}% (${parts[3]} free)`,
            skipped: false,
        };
    }
    catch {
        return {
            layer: 'runtime', checkName: 'disk-space',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'Could not check disk space', skipped: true,
        };
    }
}
function checkMemoryUsage(config, log) {
    const start = Date.now();
    try {
        const memOutput = (0, child_process_1.execSync)('free -m 2>/dev/null | grep Mem:', {
            encoding: 'utf-8', timeout: 5000,
        });
        const parts = memOutput.trim().split(/\s+/);
        const total = parseInt(parts[1], 10);
        const used = parseInt(parts[2], 10);
        const usePercent = Math.round((used / total) * 100);
        const findings = [];
        if (usePercent > 90) {
            findings.push((0, types_1.createFinding)({
                severity: 'high', layer: 'runtime', subsystem: 'memory',
                title: `Memory usage high: ${usePercent}%`,
                description: `${used}MB / ${total}MB used`,
                evidence: memOutput.trim(),
                likelyCause: 'Memory leak or too many processes',
                confidence: 'high',
                recommendedAction: 'Investigate memory-heavy processes',
            }));
        }
        return {
            layer: 'runtime', checkName: 'memory-usage',
            passed: usePercent <= 90,
            duration: Date.now() - start, findings,
            details: `Memory: ${used}MB / ${total}MB (${usePercent}%)`,
            skipped: false,
        };
    }
    catch {
        return {
            layer: 'runtime', checkName: 'memory-usage',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'Could not check memory', skipped: true,
        };
    }
}
function checkNodeVersion(systemMap, config, log) {
    const start = Date.now();
    try {
        const nodeVersion = (0, child_process_1.execSync)('node --version', { encoding: 'utf-8', timeout: 5000 }).trim();
        const majorVersion = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
        // Check engines field in package.json
        const pkgPath = path.join(systemMap.rootPath, 'package.json');
        let requiredVersion = '>=18';
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.engines?.node)
                    requiredVersion = pkg.engines.node;
            }
            catch { /* skip */ }
        }
        const findings = [];
        if (majorVersion < 18) {
            findings.push((0, types_1.createFinding)({
                severity: 'high', layer: 'runtime', subsystem: 'node',
                title: `Node.js version too old: ${nodeVersion}`,
                description: `Running ${nodeVersion}, project requires ${requiredVersion}`,
                evidence: `node --version: ${nodeVersion}`,
                likelyCause: 'System Node.js not updated',
                confidence: 'high',
                recommendedAction: `Update Node.js to meet requirement: ${requiredVersion}`,
            }));
        }
        return {
            layer: 'runtime', checkName: 'node-version',
            passed: findings.length === 0,
            duration: Date.now() - start, findings,
            details: `Node.js ${nodeVersion} (requires ${requiredVersion})`,
            skipped: false,
        };
    }
    catch {
        return {
            layer: 'runtime', checkName: 'node-version',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'Node.js not available', skipped: true,
        };
    }
}
function checkDependencyHealth(systemMap, config, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const findings = [];
    // Check if node_modules exists when package.json does
    const hasPkgJson = fs.existsSync(path.join(root, 'package.json'));
    const hasNodeModules = fs.existsSync(path.join(root, 'node_modules'));
    if (hasPkgJson && !hasNodeModules) {
        findings.push((0, types_1.createFinding)({
            severity: 'high', layer: 'runtime', subsystem: 'dependencies',
            title: 'node_modules missing',
            description: 'package.json exists but node_modules does not',
            evidence: 'node_modules directory not found',
            likelyCause: 'Dependencies not installed',
            confidence: 'high',
            recommendedAction: 'Run npm install',
        }));
    }
    // Check for outdated/vulnerable deps (quick check)
    if (hasPkgJson && hasNodeModules) {
        try {
            const auditOutput = (0, child_process_1.execSync)('npm audit --json 2>/dev/null', {
                cwd: root, encoding: 'utf-8', timeout: 30000,
            });
            const audit = JSON.parse(auditOutput);
            if (audit.metadata?.vulnerabilities) {
                const vulns = audit.metadata.vulnerabilities;
                const critical = vulns.critical || 0;
                const high = vulns.high || 0;
                if (critical > 0 || high > 0) {
                    findings.push((0, types_1.createFinding)({
                        severity: critical > 0 ? 'high' : 'medium',
                        layer: 'runtime', subsystem: 'dependencies',
                        title: `npm audit: ${critical} critical, ${high} high vulnerabilities`,
                        description: `Security vulnerabilities found in dependencies`,
                        evidence: JSON.stringify(vulns),
                        likelyCause: 'Outdated dependencies with known vulnerabilities',
                        confidence: 'high',
                        recommendedAction: 'Run npm audit fix or update vulnerable packages',
                    }));
                }
            }
        }
        catch {
            // npm audit can fail for various reasons — not critical
        }
    }
    return {
        layer: 'runtime', checkName: 'dependency-health',
        passed: findings.filter(f => f.severity === 'critical' || f.severity === 'high').length === 0,
        duration: Date.now() - start, findings,
        details: `${findings.length} dependency issue(s)`,
        skipped: !hasPkgJson,
    };
}
function checkLockFileConsistency(systemMap, config, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const lockFiles = [
        'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
    ];
    let foundLocks = 0;
    for (const lf of lockFiles) {
        if (fs.existsSync(path.join(root, lf)))
            foundLocks++;
    }
    const findings = [];
    if (foundLocks > 1) {
        findings.push((0, types_1.createFinding)({
            severity: 'medium', layer: 'runtime', subsystem: 'dependencies',
            title: 'Multiple lock files detected',
            description: 'Having multiple lock files can cause inconsistent installs',
            evidence: `${foundLocks} lock files found`,
            likelyCause: 'Mixed package manager usage',
            confidence: 'high',
            recommendedAction: 'Standardize on one package manager and remove extra lock files',
        }));
    }
    return {
        layer: 'runtime', checkName: 'lock-file-consistency',
        passed: foundLocks <= 1,
        duration: Date.now() - start, findings,
        details: `${foundLocks} lock file(s) found`,
        skipped: false,
    };
}
//# sourceMappingURL=runtime.js.map