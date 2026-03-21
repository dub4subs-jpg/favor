"use strict";
// =============================================================================
// Guardian — Phase 3: Feature & Critical Path Mapping
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
exports.discoverFeatures = discoverFeatures;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
async function discoverFeatures(systemMap, config, log) {
    log.section('FEATURE DISCOVERY');
    const features = [];
    const root = systemMap.rootPath;
    // ─── Detect Routes/Pages ─────────────────────────────────────────────
    const routes = systemMap.components.filter(c => c.type === 'route');
    for (const route of routes) {
        const routePath = inferRoutePath(route.name, systemMap.frameworks);
        features.push({
            name: routePath || route.name,
            category: 'route',
            location: route.path,
            dependencies: route.dependencies,
            expectedOutcome: `Page renders successfully at ${routePath || '/'}`,
            criticality: inferPageCriticality(route.name),
            validationLayers: ['frontend', 'runtime'],
        });
    }
    // ─── Detect API Endpoints ────────────────────────────────────────────
    const apis = systemMap.components.filter(c => c.type === 'api');
    for (const api of apis) {
        const apiPath = inferApiPath(api.name, systemMap.frameworks);
        const methods = detectApiMethods(api.path);
        features.push({
            name: `API: ${apiPath || api.name}`,
            category: 'api',
            location: api.path,
            dependencies: api.dependencies,
            expectedOutcome: `API responds with valid data (${methods.join(', ')})`,
            criticality: inferApiCriticality(api.name),
            validationLayers: ['api', 'database', 'security'],
        });
    }
    // ─── Detect Services ─────────────────────────────────────────────────
    const services = systemMap.components.filter(c => c.type === 'service');
    for (const svc of services) {
        features.push({
            name: `Service: ${path.basename(svc.name, path.extname(svc.name))}`,
            category: 'service',
            location: svc.path,
            dependencies: svc.dependencies,
            expectedOutcome: 'Service executes correctly',
            criticality: 'high',
            validationLayers: ['runtime', 'integration'],
        });
    }
    // ─── Detect Workers/Jobs ─────────────────────────────────────────────
    const workers = systemMap.components.filter(c => c.type === 'worker' || c.type === 'job');
    for (const worker of workers) {
        features.push({
            name: `Worker: ${path.basename(worker.name, path.extname(worker.name))}`,
            category: 'job',
            location: worker.path,
            dependencies: worker.dependencies,
            expectedOutcome: 'Worker runs without errors',
            criticality: 'high',
            validationLayers: ['runtime', 'database'],
        });
    }
    // ─── Detect Agent/AI Components ──────────────────────────────────────
    const agents = systemMap.components.filter(c => c.type === 'agent');
    for (const agent of agents) {
        features.push({
            name: `Agent: ${path.basename(agent.name, path.extname(agent.name))}`,
            category: 'agent',
            location: agent.path,
            dependencies: agent.dependencies,
            expectedOutcome: 'Agent responds correctly',
            criticality: 'high',
            validationLayers: ['runtime', 'integration', 'api'],
        });
    }
    // ─── Detect Integrations ─────────────────────────────────────────────
    const integrations = systemMap.components.filter(c => c.type === 'integration');
    for (const integ of integrations) {
        features.push({
            name: `Integration: ${path.basename(integ.name, path.extname(integ.name))}`,
            category: 'integration',
            location: integ.path,
            dependencies: integ.dependencies,
            expectedOutcome: 'Integration connects and exchanges data correctly',
            criticality: 'high',
            validationLayers: ['integration', 'api', 'security'],
        });
    }
    // ─── Detect Auth Flows ───────────────────────────────────────────────
    const authComponents = systemMap.components.filter(c => c.name.toLowerCase().includes('auth') || c.name.toLowerCase().includes('login') ||
        c.name.toLowerCase().includes('session'));
    if (authComponents.length > 0) {
        features.push({
            name: 'Authentication Flow',
            category: 'auth',
            location: authComponents[0].path,
            dependencies: authComponents.map(c => c.path),
            expectedOutcome: 'Users can authenticate and sessions persist',
            criticality: 'critical',
            validationLayers: ['api', 'frontend', 'security', 'database'],
        });
    }
    // ─── Detect Database Layer ───────────────────────────────────────────
    const dbComponents = systemMap.components.filter(c => c.type === 'database');
    if (dbComponents.length > 0 || systemMap.databases.length > 0) {
        features.push({
            name: 'Database Layer',
            category: 'service',
            location: dbComponents[0]?.path || root,
            dependencies: dbComponents.map(c => c.path),
            expectedOutcome: 'Database connects, reads, and writes correctly',
            criticality: 'critical',
            validationLayers: ['database', 'runtime'],
        });
    }
    // ─── Apply User-Defined Critical Paths ───────────────────────────────
    if (config.criticalPaths) {
        for (const cp of config.criticalPaths) {
            const existing = features.find(f => f.name.includes(cp) || f.location.includes(cp));
            if (existing) {
                existing.criticality = 'critical';
            }
        }
    }
    // Sort by criticality
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    features.sort((a, b) => priorityOrder[a.criticality] - priorityOrder[b.criticality]);
    log.success(`Features discovered: ${features.length}`);
    log.info(`  Critical: ${features.filter(f => f.criticality === 'critical').length}`);
    log.info(`  High: ${features.filter(f => f.criticality === 'high').length}`);
    log.info(`  Medium: ${features.filter(f => f.criticality === 'medium').length}`);
    log.info(`  Low: ${features.filter(f => f.criticality === 'low').length}`);
    return features;
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
function inferRoutePath(componentName, frameworks) {
    // Next.js App Router: app/dashboard/page.tsx → /dashboard
    const appMatch = componentName.match(/(?:src\/)?app\/(.*?)\/?(?:page|layout)\.\w+$/);
    if (appMatch) {
        const segments = appMatch[1].replace(/\(.*?\)\/?/g, ''); // Remove route groups
        return '/' + segments.replace(/\/+$/, '') || '/';
    }
    // Next.js Pages Router: pages/products/index.tsx → /products
    const pagesMatch = componentName.match(/(?:src\/)?pages\/(.*?)\.\w+$/);
    if (pagesMatch) {
        let route = pagesMatch[1].replace(/\/index$/, '');
        return '/' + route || '/';
    }
    return null;
}
function inferApiPath(componentName, frameworks) {
    // Next.js API routes: app/api/products/route.ts → /api/products
    const match = componentName.match(/(?:src\/)?(?:app|pages)\/(api\/.*?)(?:\/route)?\.\w+$/);
    if (match)
        return '/' + match[1];
    // Express-style: routes/products.ts → /products
    const routeMatch = componentName.match(/routes?\/(.*?)\.\w+$/);
    if (routeMatch)
        return '/' + routeMatch[1];
    return null;
}
function detectApiMethods(filePath) {
    const methods = [];
    try {
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 3000);
        if (/export\s+(async\s+)?function\s+GET|app\.get\s*\(|router\.get\s*\(/i.test(content))
            methods.push('GET');
        if (/export\s+(async\s+)?function\s+POST|app\.post\s*\(|router\.post\s*\(/i.test(content))
            methods.push('POST');
        if (/export\s+(async\s+)?function\s+PUT|app\.put\s*\(|router\.put\s*\(/i.test(content))
            methods.push('PUT');
        if (/export\s+(async\s+)?function\s+PATCH|app\.patch\s*\(|router\.patch\s*\(/i.test(content))
            methods.push('PATCH');
        if (/export\s+(async\s+)?function\s+DELETE|app\.delete\s*\(|router\.delete\s*\(/i.test(content))
            methods.push('DELETE');
    }
    catch { /* skip */ }
    return methods.length > 0 ? methods : ['GET'];
}
function inferPageCriticality(name) {
    const lower = name.toLowerCase();
    if (lower.includes('login') || lower.includes('auth') || lower.includes('checkout') ||
        lower.includes('payment') || lower.includes('admin'))
        return 'critical';
    if (lower.includes('dashboard') || lower.includes('home') || lower.includes('index') ||
        lower.includes('layout'))
        return 'high';
    if (lower.includes('settings') || lower.includes('profile') || lower.includes('report'))
        return 'medium';
    return 'medium';
}
function inferApiCriticality(name) {
    const lower = name.toLowerCase();
    if (lower.includes('auth') || lower.includes('login') || lower.includes('payment') ||
        lower.includes('session') || lower.includes('user'))
        return 'critical';
    if (lower.includes('dashboard') || lower.includes('product') || lower.includes('order'))
        return 'high';
    return 'high';
}
//# sourceMappingURL=features.js.map