"use strict";
// =============================================================================
// Guardian — Layer A: Frontend / UI Validation
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
exports.validateFrontend = validateFrontend;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const types_1 = require("../types");
async function validateFrontend(systemMap, features, config, log) {
    const results = [];
    if (!systemMap.hasFrontend) {
        results.push({
            layer: 'frontend',
            checkName: 'frontend-detection',
            passed: true,
            duration: 0,
            findings: [],
            details: 'No frontend detected — skipping frontend validation',
            skipped: true,
            skipReason: 'No frontend detected',
        });
        return results;
    }
    log.info('  Frontend validation...');
    // Check 1: Static asset integrity
    results.push(checkStaticAssets(systemMap, config, log));
    // Check 2: Component file health
    results.push(checkComponentHealth(systemMap, config, log));
    // Check 3: Dead imports / missing modules
    results.push(checkImportHealth(systemMap, config, log));
    // Check 4: Console error patterns in code
    results.push(checkConsoleErrorPatterns(systemMap, config, log));
    // Check 5: Render safety (null checks, optional chaining)
    results.push(checkRenderSafety(systemMap, config, log));
    // Check 6: Route completeness
    const routeFeatures = features.filter(f => f.category === 'route');
    if (routeFeatures.length > 0) {
        results.push(checkRouteCompleteness(systemMap, routeFeatures, config, log));
    }
    return results;
}
function checkStaticAssets(systemMap, config, log) {
    const start = Date.now();
    const findings = [];
    const root = systemMap.rootPath;
    // Check for public/static directory
    const publicDirs = ['public', 'static', 'assets', 'src/assets'];
    let assetDir = null;
    for (const dir of publicDirs) {
        const fullPath = path.join(root, dir);
        if (fs.existsSync(fullPath)) {
            assetDir = fullPath;
            break;
        }
    }
    // Check for referenced but missing assets in code
    const componentFiles = systemMap.components
        .filter(c => c.type === 'component' || c.type === 'route')
        .slice(0, 50); // Limit for performance
    let missingAssets = 0;
    for (const comp of componentFiles) {
        try {
            const content = fs.readFileSync(comp.path, 'utf-8');
            // Check for common asset reference patterns
            const assetRefs = content.match(/(?:src|href)=["']\/([^"']+\.(png|jpg|svg|css|ico|woff2?))["']/g);
            if (assetRefs && assetDir) {
                for (const ref of assetRefs) {
                    const assetPath = ref.match(/["']\/([^"']+)["']/)?.[1];
                    if (assetPath && !fs.existsSync(path.join(root, 'public', assetPath))) {
                        findings.push(`Missing asset: /${assetPath} referenced in ${path.relative(root, comp.path)}`);
                        missingAssets++;
                    }
                }
            }
        }
        catch { /* skip */ }
    }
    const passed = missingAssets === 0;
    return {
        layer: 'frontend',
        checkName: 'static-assets',
        passed,
        duration: Date.now() - start,
        findings: findings.slice(0, 10).map(f => (0, types_1.createFinding)({
            severity: 'medium',
            layer: 'frontend',
            subsystem: 'assets',
            title: 'Missing static asset',
            description: f,
            evidence: f,
            likelyCause: 'Asset file missing or path incorrect',
            confidence: 'medium',
            recommendedAction: 'Add the missing asset or fix the reference path',
        })),
        details: passed ? 'Static assets OK' : `${missingAssets} missing asset(s)`,
        skipped: false,
    };
}
function checkComponentHealth(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const components = systemMap.components
        .filter(c => c.type === 'component' || c.type === 'route')
        .slice(0, 100);
    let emptyComponents = 0;
    let oversizedComponents = 0;
    for (const comp of components) {
        try {
            const stat = fs.statSync(comp.path);
            if (stat.size === 0) {
                emptyComponents++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'medium',
                    layer: 'frontend',
                    subsystem: 'components',
                    title: 'Empty component file',
                    description: `${path.relative(root, comp.path)} is empty`,
                    evidence: `File size: 0 bytes`,
                    likelyCause: 'File was created but never populated',
                    confidence: 'high',
                    recommendedAction: 'Add content or remove the file',
                    filePath: comp.path,
                }));
            }
            else if (stat.size > 50000) {
                oversizedComponents++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'low',
                    layer: 'frontend',
                    subsystem: 'components',
                    title: 'Oversized component',
                    description: `${path.relative(root, comp.path)} is ${(stat.size / 1024).toFixed(1)}KB`,
                    evidence: `File size: ${stat.size} bytes`,
                    likelyCause: 'Component doing too much — consider splitting',
                    confidence: 'medium',
                    recommendedAction: 'Consider splitting into smaller components',
                    filePath: comp.path,
                }));
            }
        }
        catch { /* skip */ }
    }
    const passed = emptyComponents === 0;
    return {
        layer: 'frontend',
        checkName: 'component-health',
        passed,
        duration: Date.now() - start,
        findings: findingsList.slice(0, 10),
        details: `${components.length} components checked: ${emptyComponents} empty, ${oversizedComponents} oversized`,
        skipped: false,
    };
}
function checkImportHealth(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const codeFiles = systemMap.components
        .filter(c => ['component', 'route', 'service', 'util'].includes(c.type))
        .slice(0, 80);
    let brokenImports = 0;
    for (const file of codeFiles) {
        try {
            const content = fs.readFileSync(file.path, 'utf-8');
            const imports = content.match(/from\s+['"](\.[^'"]+)['"]/g);
            if (imports) {
                for (const imp of imports) {
                    const importPath = imp.match(/from\s+['"](\..*?)['"]/)?.[1];
                    if (!importPath)
                        continue;
                    const dir = path.dirname(file.path);
                    let resolvedPath = path.resolve(dir, importPath);
                    // Try common extensions
                    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
                    const exists = extensions.some(ext => fs.existsSync(resolvedPath + ext));
                    if (!exists) {
                        brokenImports++;
                        findingsList.push((0, types_1.createFinding)({
                            severity: 'high',
                            layer: 'frontend',
                            subsystem: 'imports',
                            title: 'Broken import',
                            description: `${path.relative(root, file.path)} imports non-existent '${importPath}'`,
                            evidence: imp,
                            likelyCause: 'File moved, renamed, or deleted',
                            confidence: 'medium',
                            recommendedAction: 'Fix the import path or create the missing module',
                            filePath: file.path,
                        }));
                    }
                }
            }
        }
        catch { /* skip */ }
    }
    const passed = brokenImports === 0;
    return {
        layer: 'frontend',
        checkName: 'import-health',
        passed,
        duration: Date.now() - start,
        findings: findingsList.slice(0, 10),
        details: passed ? 'All local imports resolve' : `${brokenImports} broken import(s)`,
        skipped: false,
    };
}
function checkConsoleErrorPatterns(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    let errorPatterns = 0;
    const codeFiles = systemMap.components
        .filter(c => ['component', 'route'].includes(c.type))
        .slice(0, 80);
    for (const file of codeFiles) {
        try {
            const content = fs.readFileSync(file.path, 'utf-8');
            // Check for unhandled error patterns
            if (/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/.test(content)) {
                errorPatterns++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'medium',
                    layer: 'frontend',
                    subsystem: 'error-handling',
                    title: 'Empty catch block',
                    description: `${path.relative(root, file.path)} has an empty catch block`,
                    evidence: 'catch (e) {} — swallows errors silently',
                    likelyCause: 'Missing error handling',
                    confidence: 'high',
                    recommendedAction: 'Add error handling or at least log the error',
                    filePath: file.path,
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'frontend',
        checkName: 'error-patterns',
        passed: errorPatterns === 0,
        duration: Date.now() - start,
        findings: findingsList.slice(0, 10),
        details: errorPatterns === 0 ? 'No suspicious error patterns' : `${errorPatterns} suspicious pattern(s)`,
        skipped: false,
    };
}
function checkRenderSafety(systemMap, config, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    let unsafePatterns = 0;
    const components = systemMap.components
        .filter(c => c.type === 'component' || c.type === 'route')
        .filter(c => c.path.endsWith('.tsx') || c.path.endsWith('.jsx'))
        .slice(0, 60);
    for (const comp of components) {
        try {
            const content = fs.readFileSync(comp.path, 'utf-8');
            // Check for dangerouslySetInnerHTML without sanitization context
            if (content.includes('dangerouslySetInnerHTML')) {
                unsafePatterns++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'high',
                    layer: 'frontend',
                    subsystem: 'render-safety',
                    title: 'dangerouslySetInnerHTML usage',
                    description: `${path.relative(root, comp.path)} uses dangerouslySetInnerHTML`,
                    evidence: 'dangerouslySetInnerHTML — XSS risk if input not sanitized',
                    likelyCause: 'Rendering raw HTML without sanitization',
                    confidence: 'medium',
                    recommendedAction: 'Ensure input is sanitized (DOMPurify or similar)',
                    filePath: comp.path,
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'frontend',
        checkName: 'render-safety',
        passed: unsafePatterns === 0,
        duration: Date.now() - start,
        findings: findingsList.slice(0, 10),
        details: unsafePatterns === 0 ? 'No unsafe render patterns' : `${unsafePatterns} unsafe pattern(s)`,
        skipped: false,
    };
}
function checkRouteCompleteness(systemMap, routeFeatures, config, log) {
    const start = Date.now();
    const findingsList = [];
    let missingPages = 0;
    for (const feature of routeFeatures) {
        if (!fs.existsSync(feature.location)) {
            missingPages++;
            findingsList.push((0, types_1.createFinding)({
                severity: 'high',
                layer: 'frontend',
                subsystem: 'routes',
                title: 'Missing route file',
                description: `Route file missing: ${feature.location}`,
                evidence: `Expected file does not exist`,
                likelyCause: 'Route was removed or moved',
                confidence: 'high',
                recommendedAction: 'Restore the route file or update navigation',
            }));
        }
    }
    return {
        layer: 'frontend',
        checkName: 'route-completeness',
        passed: missingPages === 0,
        duration: Date.now() - start,
        findings: findingsList,
        details: `${routeFeatures.length} routes checked, ${missingPages} missing`,
        skipped: false,
    };
}
//# sourceMappingURL=frontend.js.map