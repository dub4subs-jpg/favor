"use strict";
// =============================================================================
// Guardian — Phase 1: Project Discovery Engine
// =============================================================================
// Inspects any target path and builds a structured SystemMap of what exists.
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
exports.discoverProject = discoverProject;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ─── File Pattern Detection ──────────────────────────────────────────────────
const LANGUAGE_PATTERNS = {
    typescript: ['.ts', '.tsx'],
    javascript: ['.js', '.jsx', '.mjs', '.cjs'],
    python: ['.py'],
    go: ['.go'],
    rust: ['.rs'],
    java: ['.java'],
    ruby: ['.rb'],
    php: ['.php'],
    csharp: ['.cs'],
    swift: ['.swift'],
    kotlin: ['.kt', '.kts'],
    dart: ['.dart'],
    other: [],
};
const FRAMEWORK_INDICATORS = {
    nextjs: { files: ['next.config.ts', 'next.config.js', 'next.config.mjs'], deps: ['next'] },
    react: { files: [], deps: ['react', 'react-dom'] },
    vue: { files: ['vue.config.js', 'nuxt.config.ts'], deps: ['vue', 'nuxt'] },
    angular: { files: ['angular.json'], deps: ['@angular/core'] },
    svelte: { files: ['svelte.config.js'], deps: ['svelte'] },
    express: { files: [], deps: ['express'] },
    fastify: { files: [], deps: ['fastify'] },
    koa: { files: [], deps: ['koa'] },
    nestjs: { files: ['nest-cli.json'], deps: ['@nestjs/core'] },
    django: { files: ['manage.py', 'settings.py'], deps: ['django'] },
    flask: { files: [], deps: ['flask'] },
    fastapi: { files: [], deps: ['fastapi'] },
    rails: { files: ['Gemfile', 'config/routes.rb'], deps: ['rails'] },
    laravel: { files: ['artisan'], deps: ['laravel/framework'] },
    spring: { files: ['pom.xml'], deps: ['spring-boot'] },
    gin: { files: [], deps: ['github.com/gin-gonic/gin'] },
    actix: { files: [], deps: ['actix-web'] },
    phoenix: { files: ['mix.exs'], deps: ['phoenix'] },
    other: { files: [], deps: [] },
};
const DB_INDICATORS = {
    sqlite: { files: [], deps: ['sqlite3'], patterns: ['*.db', '*.sqlite', '*.sqlite3'] },
    'better-sqlite3': { files: [], deps: ['better-sqlite3'], patterns: [] },
    postgres: { files: [], deps: ['pg', 'postgres', 'psycopg2'], patterns: [] },
    mysql: { files: [], deps: ['mysql', 'mysql2'], patterns: [] },
    mongodb: { files: [], deps: ['mongoose', 'mongodb', 'pymongo'], patterns: [] },
    redis: { files: [], deps: ['redis', 'ioredis'], patterns: [] },
    prisma: { files: ['prisma/schema.prisma'], deps: ['@prisma/client', 'prisma'], patterns: [] },
    drizzle: { files: ['drizzle.config.ts'], deps: ['drizzle-orm'], patterns: [] },
    sequelize: { files: ['.sequelizerc'], deps: ['sequelize'], patterns: [] },
    typeorm: { files: ['ormconfig.json', 'ormconfig.ts'], deps: ['typeorm'], patterns: [] },
    knex: { files: ['knexfile.js', 'knexfile.ts'], deps: ['knex'], patterns: [] },
    other: { files: [], deps: [], patterns: [] },
};
// ─── Discovery Engine ────────────────────────────────────────────────────────
async function discoverProject(config, log) {
    log.section('PROJECT DISCOVERY');
    const root = config.target;
    log.info(`Scanning: ${root}`);
    const allFiles = walkDirectory(root, config.ignorePatterns || [], 5);
    log.info(`Found ${allFiles.length} files`);
    const languages = detectLanguages(allFiles);
    log.info(`Languages: ${languages.join(', ') || 'none detected'}`);
    const deps = loadDependencies(root);
    const frameworks = detectFrameworks(root, allFiles, deps);
    log.info(`Frameworks: ${frameworks.join(', ') || 'none detected'}`);
    const packageManagers = detectPackageManagers(root, allFiles);
    log.info(`Package managers: ${packageManagers.join(', ') || 'none detected'}`);
    const buildSystems = detectBuildSystems(root, allFiles, deps);
    const databases = detectDatabases(root, allFiles, deps);
    log.info(`Databases: ${databases.join(', ') || 'none detected'}`);
    const testFrameworks = detectTestFrameworks(root, allFiles, deps);
    log.info(`Test frameworks: ${testFrameworks.join(', ') || 'none detected'}`);
    const components = discoverComponents(root, allFiles, frameworks, config);
    log.info(`Components discovered: ${components.length}`);
    const hasFrontend = detectFrontend(allFiles, frameworks);
    const hasBackend = detectBackend(allFiles, frameworks, components);
    const hasWorkers = components.some(c => c.type === 'worker' || c.type === 'job');
    const hasAgents = components.some(c => c.type === 'agent');
    const hasCICD = allFiles.some(f => f.includes('.github/workflows') || f.includes('.gitlab-ci') ||
        f.includes('Jenkinsfile') || f.includes('.circleci') ||
        f.includes('Dockerfile') || f.includes('docker-compose'));
    const entryPoints = findEntryPoints(root, allFiles, frameworks);
    const configFiles = allFiles.filter(f => isConfigFile(f));
    const envFiles = allFiles.filter(f => path.basename(f).startsWith('.env'));
    const startupScripts = findStartupScripts(root, allFiles);
    const deployScripts = findDeployScripts(root, allFiles);
    const ports = detectPorts(root, allFiles);
    const projectName = path.basename(root);
    const systemMap = {
        projectName,
        rootPath: root,
        languages,
        frameworks,
        packageManagers,
        buildSystems,
        databases,
        testFrameworks,
        hasFrontend,
        hasBackend,
        hasWorkers,
        hasAgents,
        hasCICD,
        components,
        entryPoints,
        configFiles,
        envFiles,
        startupScripts,
        deployScripts,
        ports,
        timestamp: new Date().toISOString(),
    };
    log.success(`Discovery complete: ${projectName}`);
    log.info(`  Frontend: ${hasFrontend} | Backend: ${hasBackend} | Workers: ${hasWorkers} | Agents: ${hasAgents}`);
    return systemMap;
}
// ─── Internal Helpers ────────────────────────────────────────────────────────
function walkDirectory(dir, ignorePatterns, maxDepth, depth = 0) {
    if (depth > maxDepth)
        return [];
    const files = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativeName = entry.name;
            // Skip ignored patterns
            if (ignorePatterns.some(p => relativeName === p || fullPath.includes(`/${p}/`))) {
                continue;
            }
            if (entry.isDirectory()) {
                files.push(...walkDirectory(fullPath, ignorePatterns, maxDepth, depth + 1));
            }
            else if (entry.isFile()) {
                files.push(fullPath);
            }
        }
    }
    catch {
        // Permission denied or other read error
    }
    return files;
}
function detectLanguages(files) {
    const found = new Set();
    for (const file of files) {
        const ext = path.extname(file);
        for (const [lang, exts] of Object.entries(LANGUAGE_PATTERNS)) {
            if (exts.includes(ext)) {
                found.add(lang);
            }
        }
    }
    return Array.from(found);
}
function loadDependencies(root) {
    const deps = {};
    // Node.js
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            Object.assign(deps, pkg.dependencies || {}, pkg.devDependencies || {});
        }
        catch { /* skip */ }
    }
    // Python
    const reqPath = path.join(root, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
        try {
            const lines = fs.readFileSync(reqPath, 'utf-8').split('\n');
            for (const line of lines) {
                const pkg = line.trim().split(/[=<>!]/)[0].trim();
                if (pkg)
                    deps[pkg] = '*';
            }
        }
        catch { /* skip */ }
    }
    // Go
    const goModPath = path.join(root, 'go.mod');
    if (fs.existsSync(goModPath)) {
        try {
            const content = fs.readFileSync(goModPath, 'utf-8');
            const requireMatch = content.match(/require\s*\(([\s\S]*?)\)/);
            if (requireMatch) {
                for (const line of requireMatch[1].split('\n')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts[0] && !parts[0].startsWith('//'))
                        deps[parts[0]] = parts[1] || '*';
                }
            }
        }
        catch { /* skip */ }
    }
    // Cargo.toml
    const cargoPath = path.join(root, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
        try {
            const content = fs.readFileSync(cargoPath, 'utf-8');
            const depSection = content.match(/\[dependencies\]([\s\S]*?)(\[|$)/);
            if (depSection) {
                for (const line of depSection[1].split('\n')) {
                    const match = line.match(/^(\w[\w-]*)\s*=/);
                    if (match)
                        deps[match[1]] = '*';
                }
            }
        }
        catch { /* skip */ }
    }
    return deps;
}
function detectFrameworks(root, files, deps) {
    const found = new Set();
    for (const [fw, indicators] of Object.entries(FRAMEWORK_INDICATORS)) {
        if (fw === 'other')
            continue;
        // Check for indicator files
        for (const file of indicators.files) {
            if (fs.existsSync(path.join(root, file)) || files.some(f => f.endsWith(`/${file}`))) {
                found.add(fw);
            }
        }
        // Check dependencies
        for (const dep of indicators.deps) {
            if (deps[dep]) {
                found.add(fw);
            }
        }
    }
    return Array.from(found);
}
function detectPackageManagers(root, files) {
    const found = new Set();
    const checks = [
        ['package-lock.json', 'npm'],
        ['yarn.lock', 'yarn'],
        ['pnpm-lock.yaml', 'pnpm'],
        ['bun.lockb', 'bun'],
        ['requirements.txt', 'pip'],
        ['pyproject.toml', 'poetry'],
        ['Cargo.lock', 'cargo'],
        ['go.sum', 'go-mod'],
        ['pom.xml', 'maven'],
        ['build.gradle', 'gradle'],
        ['composer.json', 'composer'],
        ['Gemfile.lock', 'bundler'],
    ];
    for (const [file, pm] of checks) {
        if (fs.existsSync(path.join(root, file))) {
            found.add(pm);
        }
    }
    return Array.from(found);
}
function detectBuildSystems(root, files, deps) {
    const found = new Set();
    const checks = [
        [['webpack'], 'webpack'],
        [['vite'], 'vite'],
        [['esbuild'], 'esbuild'],
        [['rollup'], 'rollup'],
        [['@vercel/turbopack', 'turbopack'], 'turbopack'],
        [['parcel'], 'parcel'],
        [['typescript'], 'tsc'],
        [['@swc/core'], 'swc'],
    ];
    for (const [depNames, bs] of checks) {
        if (depNames.some(d => deps[d])) {
            found.add(bs);
        }
    }
    if (files.some(f => f.endsWith('Makefile')))
        found.add('make');
    if (files.some(f => f.endsWith('CMakeLists.txt')))
        found.add('cmake');
    if (fs.existsSync(path.join(root, 'Cargo.toml')))
        found.add('cargo');
    return Array.from(found);
}
function detectDatabases(root, files, deps) {
    const found = new Set();
    for (const [db, indicators] of Object.entries(DB_INDICATORS)) {
        if (db === 'other')
            continue;
        for (const file of indicators.files) {
            if (fs.existsSync(path.join(root, file)))
                found.add(db);
        }
        for (const dep of indicators.deps) {
            if (deps[dep])
                found.add(db);
        }
        for (const pattern of indicators.patterns) {
            const ext = pattern.replace('*', '');
            if (files.some(f => f.endsWith(ext)))
                found.add(db);
        }
    }
    return Array.from(found);
}
function detectTestFrameworks(root, files, deps) {
    const found = new Set();
    const checks = [
        [['@playwright/test', 'playwright'], 'playwright'],
        [['cypress'], 'cypress'],
        [['jest', '@jest/core'], 'jest'],
        [['vitest'], 'vitest'],
        [['mocha'], 'mocha'],
    ];
    for (const [depNames, fw] of checks) {
        if (depNames.some(d => deps[d]))
            found.add(fw);
    }
    // Python
    if (files.some(f => f.includes('conftest.py') || f.includes('test_')))
        found.add('pytest');
    if (files.some(f => f.includes('_test.go')))
        found.add('go-test');
    if (files.some(f => f.includes('_spec.rb')))
        found.add('rspec');
    if (files.some(f => f.includes('Test.php')))
        found.add('phpunit');
    // Config files
    if (fs.existsSync(path.join(root, 'playwright.config.ts')) ||
        fs.existsSync(path.join(root, 'playwright.config.js')))
        found.add('playwright');
    if (fs.existsSync(path.join(root, 'cypress.config.ts')) ||
        fs.existsSync(path.join(root, 'cypress.config.js')))
        found.add('cypress');
    if (fs.existsSync(path.join(root, 'jest.config.ts')) ||
        fs.existsSync(path.join(root, 'jest.config.js')))
        found.add('jest');
    if (fs.existsSync(path.join(root, 'vitest.config.ts')))
        found.add('vitest');
    return Array.from(found);
}
function discoverComponents(root, files, frameworks, config) {
    const components = [];
    const relFiles = files.map(f => path.relative(root, f));
    for (const rel of relFiles) {
        const comp = classifyFile(rel, frameworks);
        if (comp) {
            components.push({
                ...comp,
                path: path.join(root, rel),
            });
        }
    }
    return components;
}
function classifyFile(relPath, frameworks) {
    const parts = relPath.split('/');
    const filename = parts[parts.length - 1];
    const dir = parts.slice(0, -1).join('/');
    const ext = path.extname(filename);
    // Skip non-code files
    if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb', '.php', '.java'].includes(ext)) {
        return null;
    }
    // API routes
    if (dir.includes('api/') || dir.includes('routes/') || filename.includes('route')) {
        return {
            name: relPath, type: 'api', role: 'API endpoint',
            dependencies: [], criticality: 'high', testable: true, runtimeSensitive: true,
        };
    }
    // Next.js pages/app routes
    if (dir.startsWith('app/') || dir.startsWith('pages/') || dir.startsWith('src/app/') || dir.startsWith('src/pages/')) {
        if (filename.startsWith('page.') || filename.startsWith('layout.') || filename.startsWith('index.')) {
            return {
                name: relPath, type: 'route', role: 'Page/route',
                dependencies: [], criticality: 'high', testable: true, runtimeSensitive: false,
            };
        }
    }
    // Components
    if (dir.includes('components/') || dir.includes('Components/')) {
        return {
            name: relPath, type: 'component', role: 'UI component',
            dependencies: [], criticality: 'medium', testable: true, runtimeSensitive: false,
        };
    }
    // Services
    if (dir.includes('services/') || dir.includes('service/')) {
        return {
            name: relPath, type: 'service', role: 'Service layer',
            dependencies: [], criticality: 'high', testable: true, runtimeSensitive: true,
        };
    }
    // Controllers
    if (dir.includes('controllers/') || filename.includes('controller')) {
        return {
            name: relPath, type: 'controller', role: 'Controller',
            dependencies: [], criticality: 'high', testable: true, runtimeSensitive: true,
        };
    }
    // Models
    if (dir.includes('models/') || dir.includes('model/') || filename.includes('model')) {
        return {
            name: relPath, type: 'model', role: 'Data model',
            dependencies: [], criticality: 'high', testable: true, runtimeSensitive: false,
        };
    }
    // Database/lib files
    if (filename === 'db.ts' || filename === 'db.js' || filename === 'database.ts' ||
        dir.includes('db/') || dir.includes('database/')) {
        return {
            name: relPath, type: 'database', role: 'Database layer',
            dependencies: [], criticality: 'critical', testable: true, runtimeSensitive: true,
        };
    }
    // Middleware
    if (dir.includes('middleware/') || filename.includes('middleware')) {
        return {
            name: relPath, type: 'middleware', role: 'Middleware',
            dependencies: [], criticality: 'high', testable: true, runtimeSensitive: true,
        };
    }
    // Workers/jobs
    if (dir.includes('workers/') || dir.includes('jobs/') || dir.includes('queues/') ||
        filename.includes('worker') || filename.includes('job') || filename.includes('cron')) {
        return {
            name: relPath, type: 'worker', role: 'Background worker/job',
            dependencies: [], criticality: 'high', testable: true, runtimeSensitive: true,
        };
    }
    // Agent/AI components
    if (dir.includes('agents/') || dir.includes('agent/') || dir.includes('ai/') ||
        filename.includes('agent') || filename.includes('llm') || filename.includes('bot')) {
        return {
            name: relPath, type: 'agent', role: 'AI/Agent component',
            dependencies: [], criticality: 'high', testable: true, runtimeSensitive: true,
        };
    }
    // Migrations
    if (dir.includes('migrations/') || dir.includes('migrate/')) {
        return {
            name: relPath, type: 'migration', role: 'Database migration',
            dependencies: [], criticality: 'high', testable: false, runtimeSensitive: false,
        };
    }
    // Tests
    if (dir.includes('test') || dir.includes('spec') || dir.includes('__tests__') ||
        filename.includes('.test.') || filename.includes('.spec.') || filename.startsWith('test_')) {
        return {
            name: relPath, type: 'test', role: 'Test file',
            dependencies: [], criticality: 'low', testable: false, runtimeSensitive: false,
        };
    }
    // Config
    if (isConfigFile(relPath)) {
        return {
            name: relPath, type: 'config', role: 'Configuration',
            dependencies: [], criticality: 'medium', testable: false, runtimeSensitive: true,
        };
    }
    // Integrations
    if (dir.includes('integrations/') || dir.includes('webhooks/') || dir.includes('hooks/')) {
        return {
            name: relPath, type: 'integration', role: 'Integration/webhook',
            dependencies: [], criticality: 'high', testable: true, runtimeSensitive: true,
        };
    }
    // Scripts
    if (dir.includes('scripts/') || dir.includes('bin/')) {
        return {
            name: relPath, type: 'script', role: 'Script/tool',
            dependencies: [], criticality: 'low', testable: false, runtimeSensitive: false,
        };
    }
    // Utility/lib
    if (dir.includes('lib/') || dir.includes('utils/') || dir.includes('helpers/') || dir.includes('util/')) {
        return {
            name: relPath, type: 'util', role: 'Utility/library',
            dependencies: [], criticality: 'medium', testable: true, runtimeSensitive: false,
        };
    }
    return null;
}
function detectFrontend(files, frameworks) {
    const frontendFws = ['react', 'vue', 'angular', 'svelte', 'nextjs'];
    if (frameworks.some(fw => frontendFws.includes(fw)))
        return true;
    return files.some(f => f.endsWith('.tsx') || f.endsWith('.jsx') || f.endsWith('.vue') ||
        f.endsWith('.svelte') || f.includes('/pages/') || f.includes('/app/'));
}
function detectBackend(files, frameworks, components) {
    const backendFws = ['express', 'fastify', 'koa', 'nestjs', 'django', 'flask', 'fastapi', 'rails', 'laravel', 'spring', 'gin', 'actix'];
    if (frameworks.some(fw => backendFws.includes(fw)))
        return true;
    return components.some(c => c.type === 'api' || c.type === 'controller' || c.type === 'service');
}
function findEntryPoints(root, files, frameworks) {
    const entries = [];
    const candidates = [
        'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
        'server.ts', 'server.js', 'src/index.ts', 'src/main.ts', 'src/app.ts',
        'src/server.ts', 'manage.py', 'main.go', 'cmd/main.go', 'src/main.rs',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(root, candidate))) {
            entries.push(candidate);
        }
    }
    return entries;
}
function isConfigFile(relPath) {
    const filename = path.basename(relPath);
    const configPatterns = [
        /^\.env/, /config\.(ts|js|json|ya?ml|toml)$/i,
        /tsconfig/, /jest\.config/, /vitest\.config/, /webpack\.config/,
        /vite\.config/, /next\.config/, /tailwind\.config/, /postcss\.config/,
        /eslint/, /prettier/, /babel\.config/, /rollup\.config/,
    ];
    return configPatterns.some(p => p.test(filename));
}
function findStartupScripts(root, files) {
    const scripts = [];
    const candidates = [
        'start.sh', 'entrypoint.sh', 'docker-entrypoint.sh',
        'Procfile', 'ecosystem.config.js', 'pm2.config.js',
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(root, c)))
            scripts.push(c);
    }
    // Check package.json scripts
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (pkg.scripts?.start)
                scripts.push('npm start');
            if (pkg.scripts?.dev)
                scripts.push('npm run dev');
        }
        catch { /* skip */ }
    }
    return scripts;
}
function findDeployScripts(root, files) {
    const scripts = [];
    const relFiles = files.map(f => path.relative(root, f));
    for (const f of relFiles) {
        if (f.includes('deploy') || f.includes('Dockerfile') ||
            f.includes('docker-compose') || f.includes('.github/workflows/') ||
            f.includes('.gitlab-ci') || f.includes('Jenkinsfile')) {
            scripts.push(f);
        }
    }
    return scripts;
}
function detectPorts(root, files) {
    const ports = new Set();
    // Check common config files for port numbers
    const filesToCheck = files.filter(f => f.endsWith('.env') || f.endsWith('.env.local') ||
        f.endsWith('config.ts') || f.endsWith('config.js') ||
        f.endsWith('config.json') || f.endsWith('server.ts') ||
        f.endsWith('server.js') || f.endsWith('docker-compose.yml')).slice(0, 10); // Limit to avoid reading too many files
    for (const file of filesToCheck) {
        try {
            const content = fs.readFileSync(file, 'utf-8');
            const portMatches = content.match(/(?:PORT|port)\s*[=:]\s*(\d{4,5})/g);
            if (portMatches) {
                for (const match of portMatches) {
                    const num = parseInt(match.match(/(\d{4,5})/)[1], 10);
                    if (num >= 1024 && num <= 65535)
                        ports.add(num);
                }
            }
        }
        catch { /* skip */ }
    }
    return Array.from(ports);
}
//# sourceMappingURL=project.js.map