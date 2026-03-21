"use strict";
// =============================================================================
// Guardian — Phase 13: Security / Safety Sanity Validation
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
exports.validateSecurity = validateSecurity;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const types_1 = require("../types");
async function validateSecurity(systemMap, features, config, log) {
    const results = [];
    log.info('  Security validation...');
    // Check 1: Secrets in frontend code
    results.push(checkFrontendSecrets(systemMap, config, log));
    // Check 2: Secrets in git
    results.push(checkGitSecrets(systemMap, config, log));
    // Check 3: Unsafe config defaults
    results.push(checkUnsafeDefaults(systemMap, config, log));
    // Check 4: Debug/admin surfaces
    results.push(checkDebugSurfaces(systemMap, config, log));
    // Check 5: CORS / security headers
    results.push(checkSecurityHeaders(systemMap, config, log));
    return results;
}
function checkFrontendSecrets(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    // Frontend files that get shipped to the browser
    const frontendFiles = systemMap.components.filter(c => (c.type === 'component' || c.type === 'route') &&
        !c.path.includes('/api/') && !c.path.includes('server')).slice(0, 80);
    let secretsFound = 0;
    const secretPatterns = [
        { name: 'API Secret Key', pattern: /(?:SECRET|PRIVATE)(?:_KEY)?.*=.*['"][a-zA-Z0-9]{20,}['"]/i },
        { name: 'Database URL', pattern: /(?:DATABASE_URL|DB_URL|MONGO_URI).*=.*['"][^'"]{10,}['"]/i },
        { name: 'AWS Secret', pattern: /(?:AWS_SECRET|aws_secret).*['"][a-zA-Z0-9/+=]{20,}['"]/i },
    ];
    for (const file of frontendFiles) {
        try {
            const content = fs.readFileSync(file.path, 'utf-8');
            for (const { name, pattern } of secretPatterns) {
                if (pattern.test(content)) {
                    secretsFound++;
                    findingsList.push((0, types_1.createFinding)({
                        severity: 'critical', layer: 'security', subsystem: 'frontend-secrets',
                        title: `${name} exposed in frontend: ${path.relative(root, file.path)}`,
                        description: 'Secrets in frontend code are visible to all users',
                        evidence: `Pattern match for ${name}`,
                        likelyCause: 'Secret hardcoded in client-side code',
                        confidence: 'medium',
                        recommendedAction: 'Move to server-side env var and proxy via API',
                        filePath: file.path,
                    }));
                    break;
                }
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'security', checkName: 'frontend-secrets',
        passed: secretsFound === 0,
        duration: Date.now() - start, findings: findingsList.slice(0, 10),
        details: `${secretsFound} potential secret(s) in frontend code`,
        skipped: !systemMap.hasFrontend,
    };
}
function checkGitSecrets(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    // Check gitignore for sensitive files
    const gitignorePath = path.join(root, '.gitignore');
    const sensitivePaths = ['.env', '.env.local', '.env.production', 'config.json', 'credentials.json', '*.pem', '*.key'];
    if (fs.existsSync(gitignorePath)) {
        const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
        for (const sp of sensitivePaths) {
            const envFile = path.join(root, sp.replace('*', 'test'));
            const isIgnored = gitignore.includes(sp) || gitignore.includes(sp.replace('*', ''));
            // Check if a real env file exists but is not gitignored
            if (sp === '.env' || sp === '.env.local') {
                const realFile = path.join(root, sp);
                if (fs.existsSync(realFile) && !isIgnored) {
                    findingsList.push((0, types_1.createFinding)({
                        severity: 'critical', layer: 'security', subsystem: 'git-secrets',
                        title: `${sp} not in .gitignore`,
                        description: `${sp} exists and is not gitignored — secrets may be committed`,
                        evidence: `${sp} exists, not found in .gitignore`,
                        likelyCause: '.gitignore not updated',
                        confidence: 'high',
                        recommendedAction: `Add ${sp} to .gitignore`,
                    }));
                }
            }
        }
    }
    else {
        // No .gitignore at all
        if (fs.existsSync(path.join(root, '.git'))) {
            findingsList.push((0, types_1.createFinding)({
                severity: 'high', layer: 'security', subsystem: 'git-secrets',
                title: 'No .gitignore file',
                description: 'Git repo has no .gitignore — sensitive files may be committed',
                evidence: '.gitignore not found',
                likelyCause: '.gitignore not created',
                confidence: 'high',
                recommendedAction: 'Create a .gitignore with standard exclusions',
            }));
        }
    }
    return {
        layer: 'security', checkName: 'git-secrets',
        passed: findingsList.filter(f => f.severity === 'critical').length === 0,
        duration: Date.now() - start, findings: findingsList,
        details: `${findingsList.length} secret exposure risk(s)`,
        skipped: false,
    };
}
function checkUnsafeDefaults(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const configFiles = systemMap.components.filter(c => c.type === 'config').slice(0, 20);
    for (const cf of configFiles) {
        try {
            const content = fs.readFileSync(cf.path, 'utf-8');
            // Check for debug mode enabled
            if (/debug\s*[:=]\s*true/i.test(content) || /NODE_ENV\s*[:=]\s*['"]development['"]/i.test(content)) {
                findingsList.push((0, types_1.createFinding)({
                    severity: 'medium', layer: 'security', subsystem: 'config',
                    title: `Debug mode may be enabled: ${path.relative(root, cf.path)}`,
                    description: 'Debug mode in production can expose sensitive information',
                    evidence: 'debug=true or NODE_ENV=development found in config',
                    likelyCause: 'Development config not updated for production',
                    confidence: 'low',
                    recommendedAction: 'Ensure debug mode is off in production',
                    filePath: cf.path,
                }));
            }
            // Check for CORS wildcard
            if (/cors.*\*|origin.*\*/i.test(content)) {
                findingsList.push((0, types_1.createFinding)({
                    severity: 'medium', layer: 'security', subsystem: 'config',
                    title: `CORS wildcard in ${path.relative(root, cf.path)}`,
                    description: 'CORS origin set to * allows any domain to access the API',
                    evidence: 'CORS wildcard (*) found',
                    likelyCause: 'Development CORS config left in place',
                    confidence: 'medium',
                    recommendedAction: 'Restrict CORS to specific allowed origins',
                    filePath: cf.path,
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'security', checkName: 'unsafe-defaults',
        passed: findingsList.filter(f => f.severity !== 'low').length === 0,
        duration: Date.now() - start, findings: findingsList,
        details: `${findingsList.length} unsafe default(s)`, skipped: false,
    };
}
function checkDebugSurfaces(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const apiFiles = systemMap.components.filter(c => c.type === 'api').slice(0, 50);
    for (const api of apiFiles) {
        const relPath = path.relative(root, api.path).toLowerCase();
        // Flag debug/admin routes that might be unprotected
        if (relPath.includes('debug') || relPath.includes('admin') || relPath.includes('internal')) {
            try {
                const content = fs.readFileSync(api.path, 'utf-8');
                const hasAuth = /auth|session|admin.*check|requireRole/i.test(content);
                if (!hasAuth) {
                    findingsList.push((0, types_1.createFinding)({
                        severity: 'high', layer: 'security', subsystem: 'admin-surface',
                        title: `Unprotected admin/debug route: ${relPath}`,
                        description: 'Admin or debug endpoints without auth are a security risk',
                        evidence: `No auth check found in ${relPath}`,
                        likelyCause: 'Auth check not implemented on sensitive route',
                        confidence: 'medium',
                        recommendedAction: 'Add authentication and authorization to this route',
                        filePath: api.path,
                    }));
                }
            }
            catch { /* skip */ }
        }
    }
    return {
        layer: 'security', checkName: 'debug-surfaces',
        passed: findingsList.length === 0,
        duration: Date.now() - start, findings: findingsList,
        details: `${findingsList.length} exposed debug/admin surface(s)`,
        skipped: false,
    };
}
function checkSecurityHeaders(systemMap, config, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    // Check for security headers in Next.js config
    const nextConfigFiles = ['next.config.ts', 'next.config.js', 'next.config.mjs'];
    let hasSecurityHeaders = false;
    for (const cf of nextConfigFiles) {
        const configPath = path.join(root, cf);
        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf-8');
                if (content.includes('headers') && (content.includes('X-Frame-Options') ||
                    content.includes('Content-Security-Policy') ||
                    content.includes('Strict-Transport-Security'))) {
                    hasSecurityHeaders = true;
                }
            }
            catch { /* skip */ }
        }
    }
    const findings = [];
    if (systemMap.hasFrontend && !hasSecurityHeaders) {
        findings.push((0, types_1.createFinding)({
            severity: 'low', layer: 'security', subsystem: 'headers',
            title: 'Security headers not configured',
            description: 'No security headers (CSP, X-Frame-Options, HSTS) found in config',
            evidence: 'No header configuration found in server/framework config',
            likelyCause: 'Security headers not yet configured',
            confidence: 'medium',
            recommendedAction: 'Add security headers (CSP, X-Frame-Options, HSTS)',
        }));
    }
    return {
        layer: 'security', checkName: 'security-headers',
        passed: findings.length === 0,
        duration: Date.now() - start, findings,
        details: hasSecurityHeaders ? 'Security headers configured' : 'No security headers found',
        skipped: !systemMap.hasFrontend,
    };
}
//# sourceMappingURL=security.js.map