"use strict";
// =============================================================================
// Guardian — Layer E: Integration Validation
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
exports.validateIntegrations = validateIntegrations;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const types_1 = require("../types");
async function validateIntegrations(systemMap, features, config, log) {
    const results = [];
    log.info('  Integration validation...');
    // Check 1: Environment variables for integrations
    results.push(checkIntegrationEnvVars(systemMap, config, log));
    // Check 2: External service references
    results.push(checkExternalServiceRefs(systemMap, config, log));
    // Check 3: Webhook handler health
    results.push(checkWebhookHandlers(systemMap, config, log));
    // Check 4: API key/token patterns
    results.push(checkApiKeyPatterns(systemMap, config, log));
    return results;
}
function checkIntegrationEnvVars(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    // Collect all env var references from code
    const referencedVars = new Set();
    const codeFiles = systemMap.components
        .filter(c => ['api', 'service', 'integration', 'agent', 'worker', 'config'].includes(c.type))
        .slice(0, 50);
    for (const file of codeFiles) {
        try {
            const content = fs.readFileSync(file.path, 'utf-8');
            const envRefs = content.match(/process\.env\.(\w+)/g);
            if (envRefs) {
                envRefs.forEach(ref => {
                    const varName = ref.replace('process.env.', '');
                    referencedVars.add(varName);
                });
            }
            // Python style
            const pyRefs = content.match(/os\.environ(?:\.get)?\s*\(\s*['"](\w+)['"]/g);
            if (pyRefs) {
                pyRefs.forEach(ref => {
                    const match = ref.match(/['"](\w+)['"]/);
                    if (match)
                        referencedVars.add(match[1]);
                });
            }
        }
        catch { /* skip */ }
    }
    // Check which env vars are actually set
    const envFilePath = config.envFile || path.join(root, '.env.local');
    const envFiles = [
        envFilePath,
        path.join(root, '.env'),
        path.join(root, '.env.local'),
        path.join(root, '.env.production'),
    ];
    const definedVars = new Set();
    for (const envFile of envFiles) {
        if (fs.existsSync(envFile)) {
            try {
                const content = fs.readFileSync(envFile, 'utf-8');
                const vars = content.match(/^(\w+)=/gm);
                if (vars)
                    vars.forEach(v => definedVars.add(v.replace('=', '')));
            }
            catch { /* skip */ }
        }
    }
    // Also check runtime env
    for (const key of Object.keys(process.env)) {
        definedVars.add(key);
    }
    // Find missing critical env vars
    const integrationVarPatterns = [
        /API_KEY/i, /SECRET/i, /TOKEN/i, /DATABASE_URL/i, /REDIS_URL/i,
        /STRIPE/i, /WEBHOOK/i, /AWS/i, /GOOGLE/i, /OPENAI/i, /ANTHROPIC/i,
    ];
    let missingCritical = 0;
    for (const varName of referencedVars) {
        if (!definedVars.has(varName)) {
            const isCritical = integrationVarPatterns.some(p => p.test(varName));
            if (isCritical) {
                missingCritical++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'high', layer: 'integration', subsystem: 'env-vars',
                    title: `Missing env var: ${varName}`,
                    description: `${varName} is referenced in code but not defined in env files`,
                    evidence: `process.env.${varName} referenced but not found`,
                    likelyCause: 'Env var not set or env file missing',
                    confidence: 'medium',
                    recommendedAction: `Set ${varName} in your .env file`,
                }));
            }
        }
    }
    return {
        layer: 'integration', checkName: 'env-vars',
        passed: missingCritical === 0,
        duration: Date.now() - start, findings: findingsList.slice(0, 10),
        details: `${referencedVars.size} env vars referenced, ${missingCritical} critical missing`,
        skipped: false,
    };
}
function checkExternalServiceRefs(systemMap, config, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const externalUrls = new Set();
    const codeFiles = systemMap.components
        .filter(c => ['api', 'service', 'integration', 'agent'].includes(c.type))
        .slice(0, 50);
    for (const file of codeFiles) {
        try {
            const content = fs.readFileSync(file.path, 'utf-8');
            const urls = content.match(/https?:\/\/[^\s'"`)]+/g);
            if (urls) {
                urls.forEach(url => {
                    // Filter out localhost and common non-service URLs
                    if (!url.includes('localhost') && !url.includes('127.0.0.1') &&
                        !url.includes('example.com') && !url.includes('schemas.') &&
                        !url.includes('www.w3.org') && !url.includes('github.com')) {
                        externalUrls.add(url.split('/').slice(0, 3).join('/'));
                    }
                });
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'integration', checkName: 'external-services',
        passed: true, duration: Date.now() - start, findings: [],
        details: `${externalUrls.size} external service(s) referenced: ${Array.from(externalUrls).slice(0, 5).join(', ')}`,
        skipped: false,
    };
}
function checkWebhookHandlers(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const webhookFiles = systemMap.components.filter(c => c.name.toLowerCase().includes('webhook') || c.name.toLowerCase().includes('hook'));
    for (const wh of webhookFiles) {
        try {
            const content = fs.readFileSync(wh.path, 'utf-8');
            // Check for signature verification
            const hasSignatureCheck = /signature|verify|hmac|sha256|x-hub-signature/i.test(content);
            if (!hasSignatureCheck) {
                findingsList.push((0, types_1.createFinding)({
                    severity: 'medium', layer: 'integration', subsystem: 'webhooks',
                    title: `Webhook handler may lack signature verification`,
                    description: `${path.relative(root, wh.path)} has no apparent signature/HMAC check`,
                    evidence: 'No signature/verify/hmac patterns found',
                    likelyCause: 'Webhook signature verification not implemented',
                    confidence: 'low',
                    recommendedAction: 'Add webhook signature verification for security',
                    filePath: wh.path,
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'integration', checkName: 'webhook-handlers',
        passed: findingsList.length === 0,
        duration: Date.now() - start, findings: findingsList,
        details: `${webhookFiles.length} webhook handler(s) checked`,
        skipped: webhookFiles.length === 0,
    };
}
function checkApiKeyPatterns(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const codeFiles = systemMap.components
        .filter(c => c.type !== 'test' && c.type !== 'config')
        .slice(0, 80);
    let hardcodedKeys = 0;
    for (const file of codeFiles) {
        try {
            const content = fs.readFileSync(file.path, 'utf-8');
            // Look for hardcoded API keys/secrets (common patterns)
            const patterns = [
                /['"]sk[-_][a-zA-Z0-9]{20,}['"]/, // Stripe-style
                /['"]AIza[a-zA-Z0-9_-]{35}['"]/, // Google API key
                /['"][a-f0-9]{32,64}['"]\s*;?\s*\/\/.*(?:key|secret|token)/i, // Hex key with comment
            ];
            for (const pattern of patterns) {
                if (pattern.test(content)) {
                    hardcodedKeys++;
                    findingsList.push((0, types_1.createFinding)({
                        severity: 'high', layer: 'integration', subsystem: 'secrets',
                        title: `Possible hardcoded API key in ${path.relative(root, file.path)}`,
                        description: 'Code contains what appears to be a hardcoded API key',
                        evidence: 'Pattern match for known API key formats',
                        likelyCause: 'API key not moved to environment variable',
                        confidence: 'medium',
                        recommendedAction: 'Move the API key to an environment variable',
                        filePath: file.path,
                    }));
                    break; // One finding per file
                }
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'integration', checkName: 'api-key-patterns',
        passed: hardcodedKeys === 0,
        duration: Date.now() - start, findings: findingsList.slice(0, 10),
        details: `${hardcodedKeys} possible hardcoded key(s)`,
        skipped: false,
    };
}
//# sourceMappingURL=integration.js.map