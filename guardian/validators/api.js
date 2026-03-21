"use strict";
// =============================================================================
// Guardian — Layer C: API Validation
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
exports.validateApi = validateApi;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const types_1 = require("../types");
async function validateApi(systemMap, features, config, log) {
    const results = [];
    const apiFeatures = features.filter(f => f.category === 'api');
    if (apiFeatures.length === 0 && !systemMap.hasBackend) {
        results.push({
            layer: 'api', checkName: 'api-detection', passed: true, duration: 0,
            findings: [], details: 'No API layer detected — skipping', skipped: true,
            skipReason: 'No API layer detected',
        });
        return results;
    }
    log.info('  API validation...');
    // Check 1: API route file health
    results.push(checkApiFileHealth(systemMap, config, log));
    // Check 2: Error handling in API routes
    results.push(checkApiErrorHandling(systemMap, config, log));
    // Check 3: Auth protection on API routes
    results.push(checkApiAuth(systemMap, config, log));
    // Check 4: Response structure consistency
    results.push(checkApiResponsePatterns(systemMap, config, log));
    // Check 5: Live endpoint availability (if ports detected)
    if (systemMap.ports.length > 0) {
        for (const port of systemMap.ports.slice(0, 3)) {
            const liveResult = await checkLiveEndpoints(systemMap, apiFeatures, port, config, log);
            results.push(liveResult);
        }
    }
    return results;
}
function checkApiFileHealth(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const apiFiles = systemMap.components.filter(c => c.type === 'api');
    let issues = 0;
    for (const api of apiFiles) {
        try {
            const content = fs.readFileSync(api.path, 'utf-8');
            const stat = fs.statSync(api.path);
            if (stat.size === 0) {
                issues++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'high', layer: 'api', subsystem: 'api-routes',
                    title: 'Empty API route',
                    description: `${path.relative(root, api.path)} is empty`,
                    evidence: 'File size: 0 bytes', likelyCause: 'Route not implemented',
                    confidence: 'high', recommendedAction: 'Implement the route or remove it',
                    filePath: api.path,
                }));
            }
            // Check for TODO/FIXME in API routes
            const todoMatches = content.match(/(TODO|FIXME|HACK|XXX)[\s:].*/gi);
            if (todoMatches && todoMatches.length > 0) {
                findingsList.push((0, types_1.createFinding)({
                    severity: 'low', layer: 'api', subsystem: 'api-routes',
                    title: `API route has ${todoMatches.length} TODO(s)`,
                    description: `${path.relative(root, api.path)}: ${todoMatches[0]}`,
                    evidence: todoMatches.slice(0, 3).join('\n'),
                    likelyCause: 'Incomplete implementation', confidence: 'high',
                    recommendedAction: 'Address TODOs before shipping',
                    filePath: api.path,
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'api', checkName: 'api-file-health', passed: issues === 0,
        duration: Date.now() - start, findings: findingsList.slice(0, 10),
        details: `${apiFiles.length} API files checked, ${issues} issue(s)`, skipped: false,
    };
}
function checkApiErrorHandling(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const apiFiles = systemMap.components.filter(c => c.type === 'api');
    let missingErrorHandling = 0;
    for (const api of apiFiles) {
        try {
            const content = fs.readFileSync(api.path, 'utf-8');
            // Check if any exported handler has try/catch or error response
            const hasTryCatch = /try\s*\{/.test(content);
            const hasErrorResponse = /catch|\.status\s*\(\s*[45]\d{2}\s*\)|Response\.json.*error|NextResponse.*error|res\.status\s*\(\s*[45]/i.test(content);
            if (!hasTryCatch && !hasErrorResponse && content.length > 100) {
                missingErrorHandling++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'medium', layer: 'api', subsystem: 'error-handling',
                    title: 'API route missing error handling',
                    description: `${path.relative(root, api.path)} has no try/catch or error responses`,
                    evidence: 'No try/catch blocks or error status codes found',
                    likelyCause: 'Error handling not implemented',
                    confidence: 'medium',
                    recommendedAction: 'Wrap handler logic in try/catch and return appropriate error responses',
                    filePath: api.path,
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'api', checkName: 'api-error-handling',
        passed: missingErrorHandling === 0,
        duration: Date.now() - start, findings: findingsList.slice(0, 10),
        details: `${missingErrorHandling} route(s) missing error handling`, skipped: false,
    };
}
function checkApiAuth(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const apiFiles = systemMap.components.filter(c => c.type === 'api');
    let unprotectedRoutes = 0;
    // Detect if the project uses framework-level or middleware-level auth
    // Next.js middleware.ts, Express middleware, layout-level auth guards, etc.
    const hasAuthMiddleware = systemMap.components.some(c => c.type === 'middleware' && (c.name.includes('auth') || c.name.includes('session')));
    // Next.js middleware.ts at project root guards all routes
    const hasNextMiddleware = fs.existsSync(path.join(root, 'middleware.ts')) ||
        fs.existsSync(path.join(root, 'middleware.js')) ||
        fs.existsSync(path.join(root, 'src', 'middleware.ts'));
    // Layout-level auth (e.g. Next.js layout.tsx with session/auth check)
    const hasLayoutAuth = systemMap.components
        .filter(c => c.type === 'route' && c.name.includes('layout'))
        .some(c => {
        try {
            const content = fs.readFileSync(c.path, 'utf-8');
            return /session|auth|cookie|redirect.*login|getServerSession|requireAuth/i.test(content);
        }
        catch {
            return false;
        }
    });
    // Cookie-based session (e.g. he_session cookie checked by the frontend/layout)
    const hasCookieAuth = systemMap.components
        .filter(c => c.name.toLowerCase().includes('auth'))
        .some(c => {
        try {
            const content = fs.readFileSync(c.path, 'utf-8');
            return /cookie|session|he_session/i.test(content);
        }
        catch {
            return false;
        }
    });
    // If the project has a global auth layer, individual routes don't need their own checks
    const hasGlobalAuth = hasAuthMiddleware || hasNextMiddleware || hasLayoutAuth || hasCookieAuth;
    if (hasGlobalAuth) {
        return {
            layer: 'api', checkName: 'api-auth-coverage',
            passed: true,
            duration: Date.now() - start, findings: [],
            details: 'Auth handled at framework/middleware/layout level', skipped: false,
        };
    }
    for (const api of apiFiles) {
        try {
            const content = fs.readFileSync(api.path, 'utf-8');
            const relPath = path.relative(root, api.path).toLowerCase();
            // Skip auth routes themselves and common public endpoints
            if (relPath.includes('auth') || relPath.includes('login') || relPath.includes('health') ||
                relPath.includes('public') || relPath.includes('webhook') || relPath.includes('status') ||
                relPath.includes('robots') || relPath.includes('sitemap') || relPath.includes('manifest'))
                continue;
            // Check for auth patterns — broader detection
            const hasAuthCheck = /session|auth|token|cookie|bearer|getServerSession|getToken|requireAuth|middleware|he_session|x-api-key|authorization|credentials/i.test(content);
            if (!hasAuthCheck && content.length > 100) {
                unprotectedRoutes++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'medium', layer: 'api', subsystem: 'auth',
                    title: 'API route may lack auth protection',
                    description: `${path.relative(root, api.path)} has no apparent auth check`,
                    evidence: 'No auth/session/token references found in handler',
                    likelyCause: 'Auth check missing or handled elsewhere',
                    confidence: 'low',
                    recommendedAction: 'Verify this route is intentionally public or add auth',
                    filePath: api.path,
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'api', checkName: 'api-auth-coverage',
        passed: unprotectedRoutes === 0,
        duration: Date.now() - start, findings: findingsList.slice(0, 10),
        details: `${unprotectedRoutes} possibly unprotected route(s)`, skipped: false,
    };
}
function checkApiResponsePatterns(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const apiFiles = systemMap.components.filter(c => c.type === 'api');
    let inconsistencies = 0;
    // Look for inconsistent response patterns
    const responsePatterns = {};
    for (const api of apiFiles) {
        try {
            const content = fs.readFileSync(api.path, 'utf-8');
            if (content.includes('NextResponse.json'))
                responsePatterns['NextResponse.json'] = (responsePatterns['NextResponse.json'] || 0) + 1;
            if (content.includes('Response.json'))
                responsePatterns['Response.json'] = (responsePatterns['Response.json'] || 0) + 1;
            if (/res\.json\s*\(/.test(content))
                responsePatterns['res.json()'] = (responsePatterns['res.json()'] || 0) + 1;
            if (/res\.send\s*\(/.test(content))
                responsePatterns['res.send()'] = (responsePatterns['res.send()'] || 0) + 1;
        }
        catch { /* skip */ }
    }
    const patterns = Object.keys(responsePatterns);
    if (patterns.length > 2) {
        inconsistencies++;
        findingsList.push((0, types_1.createFinding)({
            severity: 'low', layer: 'api', subsystem: 'consistency',
            title: 'Inconsistent API response patterns',
            description: `Multiple response styles found: ${patterns.join(', ')}`,
            evidence: JSON.stringify(responsePatterns),
            likelyCause: 'Different developers or incremental migration',
            confidence: 'medium',
            recommendedAction: 'Standardize on one response pattern',
        }));
    }
    return {
        layer: 'api', checkName: 'api-response-patterns',
        passed: inconsistencies === 0,
        duration: Date.now() - start, findings: findingsList,
        details: `Response patterns: ${JSON.stringify(responsePatterns)}`, skipped: false,
    };
}
async function checkLiveEndpoints(systemMap, apiFeatures, port, config, log) {
    const start = Date.now();
    const findingsList = [];
    let reachable = 0;
    let unreachable = 0;
    // First check if the port is even listening
    const baseReachable = await httpGet(`http://localhost:${port}/`, config.timeout);
    if (!baseReachable.ok && !baseReachable.status) {
        return {
            layer: 'api', checkName: `live-endpoints-port-${port}`,
            passed: true, duration: Date.now() - start, findings: [],
            details: `Port ${port} not responding — service may not be running`,
            skipped: true, skipReason: `Port ${port} not responding`,
        };
    }
    // Check discovered API paths
    for (const feature of apiFeatures.slice(0, 10)) {
        const apiPath = feature.name.replace('API: ', '');
        if (!apiPath.startsWith('/'))
            continue;
        try {
            const result = await httpGet(`http://localhost:${port}${apiPath}`, 5000);
            if (result.status && result.status < 500) {
                reachable++;
            }
            else {
                unreachable++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'high', layer: 'api', subsystem: 'live-endpoints',
                    title: `API endpoint unavailable: ${apiPath}`,
                    description: `${apiPath} returned status ${result.status || 'timeout'}`,
                    evidence: `Status: ${result.status}, Body: ${(result.body || '').slice(0, 200)}`,
                    likelyCause: 'Endpoint down, misconfigured, or server error',
                    confidence: 'high',
                    recommendedAction: 'Check server logs and endpoint implementation',
                }));
            }
        }
        catch {
            unreachable++;
        }
    }
    const passed = unreachable === 0;
    return {
        layer: 'api', checkName: `live-endpoints-port-${port}`,
        passed, duration: Date.now() - start, findings: findingsList,
        details: `Port ${port}: ${reachable} reachable, ${unreachable} unreachable`,
        skipped: false,
    };
}
function httpGet(url, timeout) {
    return new Promise((resolve) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                resolve({
                    ok: res.statusCode !== undefined && res.statusCode < 400,
                    status: res.statusCode,
                    body: body.slice(0, 1000),
                });
            });
        });
        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    });
}
//# sourceMappingURL=api.js.map