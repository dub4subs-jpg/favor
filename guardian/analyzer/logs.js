"use strict";
// =============================================================================
// Guardian — Phase 6: Runtime, Log, and Error Intelligence
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
exports.analyzeLogs = analyzeLogs;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const types_1 = require("../types");
async function analyzeLogs(systemMap, config, log) {
    log.section('LOG ANALYSIS');
    const findings = [];
    const errorGroups = [];
    const logSources = [];
    // ─── PM2 Logs ──────────────────────────────────────────────────────
    try {
        const pm2Errors = getPm2ErrorLogs(systemMap, config);
        if (pm2Errors.length > 0) {
            log.info(`Analyzing ${pm2Errors.length} pm2 error log lines...`);
            const groups = groupErrors(pm2Errors);
            errorGroups.push(...groups);
            logSources.push('pm2');
        }
    }
    catch {
        log.debug('pm2 logs not available');
    }
    // ─── Application Logs ─────────────────────────────────────────────
    const appLogDirs = ['logs', 'log', 'data/logs', '.logs'];
    for (const dir of appLogDirs) {
        const logDir = path.join(systemMap.rootPath, dir);
        if (fs.existsSync(logDir) && fs.statSync(logDir).isDirectory()) {
            try {
                const logFiles = fs.readdirSync(logDir)
                    .filter(f => f.endsWith('.log') || f.endsWith('.err'))
                    .slice(0, 5);
                for (const logFile of logFiles) {
                    const logPath = path.join(logDir, logFile);
                    const lines = readLastLines(logPath, 500);
                    if (lines.length > 0) {
                        const groups = groupErrors(lines);
                        errorGroups.push(...groups);
                        logSources.push(`${dir}/${logFile}`);
                    }
                }
            }
            catch { /* skip */ }
        }
    }
    // ─── Journal/Syslog ───────────────────────────────────────────────
    try {
        const journalOutput = (0, child_process_1.execSync)(`journalctl --no-pager -n 200 --since "1 hour ago" -p err 2>/dev/null || true`, { encoding: 'utf-8', timeout: 10000 }).trim();
        if (journalOutput && journalOutput.length > 10) {
            const lines = journalOutput.split('\n').filter(Boolean);
            if (lines.length > 0) {
                const groups = groupErrors(lines);
                errorGroups.push(...groups);
                logSources.push('journalctl');
            }
        }
    }
    catch { /* skip */ }
    // ─── Docker Logs ──────────────────────────────────────────────────
    try {
        const containers = (0, child_process_1.execSync)('docker ps --format "{{.Names}}" 2>/dev/null', {
            encoding: 'utf-8', timeout: 5000,
        }).trim().split('\n').filter(Boolean);
        for (const container of containers.slice(0, 5)) {
            try {
                const dockerLogs = (0, child_process_1.execSync)(`docker logs ${container} --since 1h --tail 200 2>&1 | grep -i "error\\|fatal\\|panic\\|exception" || true`, { encoding: 'utf-8', timeout: 10000 }).trim();
                if (dockerLogs) {
                    const lines = dockerLogs.split('\n').filter(Boolean);
                    const groups = groupErrors(lines);
                    errorGroups.push(...groups);
                    logSources.push(`docker:${container}`);
                }
            }
            catch { /* skip */ }
        }
    }
    catch { /* skip */ }
    // ─── Convert Error Groups to Findings ─────────────────────────────
    const mergedGroups = mergeErrorGroups(errorGroups);
    for (const group of mergedGroups) {
        if (group.severity === 'noise')
            continue;
        const severity = group.severity === 'fatal' ? 'critical' :
            group.severity === 'error' ? 'high' : 'medium';
        findings.push((0, types_1.createFinding)({
            severity,
            layer: 'runtime',
            subsystem: 'logs',
            title: `${group.severity.toUpperCase()}: ${group.pattern.slice(0, 80)}`,
            description: `Occurred ${group.count} time(s) in logs`,
            evidence: group.sample.slice(0, 500),
            likelyCause: inferCause(group.pattern),
            confidence: group.count > 5 ? 'high' : 'medium',
            recommendedAction: group.severity === 'fatal'
                ? 'Investigate immediately — this is causing crashes'
                : 'Review error pattern and fix root cause',
        }));
    }
    const summary = `Analyzed ${logSources.length} log source(s): ${logSources.join(', ')}. ` +
        `Found ${mergedGroups.length} unique error pattern(s), ` +
        `${mergedGroups.filter(g => g.severity === 'fatal').length} fatal, ` +
        `${mergedGroups.filter(g => g.severity === 'error').length} errors, ` +
        `${mergedGroups.filter(g => g.severity === 'warning').length} warnings.`;
    log.info(summary);
    return { findings, errorGroups: mergedGroups, summary };
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
function getPm2ErrorLogs(systemMap, config) {
    try {
        // Get PM2 error log path
        const pm2Home = process.env.PM2_HOME || path.join(process.env.HOME || '/root', '.pm2');
        const logDir = path.join(pm2Home, 'logs');
        if (!fs.existsSync(logDir))
            return [];
        const errorLogs = fs.readdirSync(logDir)
            .filter(f => f.endsWith('-error.log'))
            .slice(0, 5);
        const lines = [];
        for (const logFile of errorLogs) {
            lines.push(...readLastLines(path.join(logDir, logFile), 200));
        }
        return lines;
    }
    catch {
        return [];
    }
}
function readLastLines(filePath, count) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        return lines.slice(-count);
    }
    catch {
        return [];
    }
}
function groupErrors(lines) {
    const groups = new Map();
    // Noise patterns to filter out
    const noisePatterns = [
        /punycode/i, /DEP\d+/i, /DeprecationWarning/i,
        /ExperimentalWarning/i, /MaxListenersExceeded/i,
    ];
    for (const line of lines) {
        if (!line.trim())
            continue;
        // Skip noise
        if (noisePatterns.some(p => p.test(line)))
            continue;
        const severity = classifyLine(line);
        if (severity === 'noise')
            continue;
        // Normalize the line to group similar errors
        const pattern = normalizeLine(line);
        const existing = groups.get(pattern);
        if (existing) {
            existing.count++;
            existing.lastSeen = new Date().toISOString();
        }
        else {
            groups.set(pattern, {
                pattern,
                count: 1,
                severity,
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                sample: line.slice(0, 500),
            });
        }
    }
    return Array.from(groups.values());
}
function classifyLine(line) {
    const lower = line.toLowerCase();
    if (/fatal|panic|segfault|killed|oom|out of memory/i.test(lower))
        return 'fatal';
    if (/unhandled.*rejection|uncaught.*exception/i.test(lower))
        return 'fatal';
    if (/typeerror|referenceerror|syntaxerror|rangeerror/i.test(lower))
        return 'error';
    if (/error:|error\s|enoent|eacces|econnrefused|eaddrinuse/i.test(lower))
        return 'error';
    if (/500|503|502/i.test(lower) && /status|response|http/i.test(lower))
        return 'error';
    if (/warn|warning/i.test(lower))
        return 'warning';
    return 'noise';
}
function normalizeLine(line) {
    return line
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '<TIME>')
        .replace(/0x[a-f0-9]+/gi, '<ADDR>')
        .replace(/\b\d{5,}\b/g, '<NUM>')
        .replace(/\/[^\s:]+\/[^\s:]+/g, '<PATH>')
        .trim()
        .slice(0, 200);
}
function mergeErrorGroups(groups) {
    const merged = new Map();
    for (const group of groups) {
        const key = group.pattern;
        const existing = merged.get(key);
        if (existing) {
            existing.count += group.count;
            if (group.lastSeen > existing.lastSeen)
                existing.lastSeen = group.lastSeen;
            if (group.firstSeen < existing.firstSeen)
                existing.firstSeen = group.firstSeen;
            // Promote severity
            if (severityRank(group.severity) > severityRank(existing.severity)) {
                existing.severity = group.severity;
            }
        }
        else {
            merged.set(key, { ...group });
        }
    }
    // Sort by severity then count
    return Array.from(merged.values()).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.count - a.count);
}
function severityRank(s) {
    return { fatal: 3, error: 2, warning: 1, noise: 0 }[s];
}
function inferCause(pattern) {
    const lower = pattern.toLowerCase();
    if (lower.includes('typeerror'))
        return 'Accessing property of null/undefined or wrong type usage';
    if (lower.includes('referenceerror'))
        return 'Using an undefined variable';
    if (lower.includes('syntaxerror'))
        return 'Malformed code or JSON parsing failure';
    if (lower.includes('econnrefused'))
        return 'Service or dependency is not running';
    if (lower.includes('enoent'))
        return 'File or path does not exist';
    if (lower.includes('eaddrinuse'))
        return 'Port already in use by another process';
    if (lower.includes('out of memory') || lower.includes('oom'))
        return 'Process exceeded memory limits';
    if (lower.includes('unhandled') || lower.includes('uncaught'))
        return 'Exception not caught by error handler';
    if (lower.includes('timeout'))
        return 'Operation took too long — network or resource issue';
    return 'Review the error pattern for specifics';
}
//# sourceMappingURL=logs.js.map