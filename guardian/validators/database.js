"use strict";
// =============================================================================
// Guardian — Layer D: Database / Data Sanity Validation
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
exports.validateDatabase = validateDatabase;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const types_1 = require("../types");
async function validateDatabase(systemMap, features, config, log) {
    const results = [];
    if (systemMap.databases.length === 0) {
        results.push({
            layer: 'database', checkName: 'db-detection', passed: true, duration: 0,
            findings: [], details: 'No database detected — skipping', skipped: true,
            skipReason: 'No database detected',
        });
        return results;
    }
    log.info('  Database validation...');
    // SQLite-specific checks
    if (systemMap.databases.includes('sqlite') || systemMap.databases.includes('better-sqlite3')) {
        const dbFiles = findSqliteFiles(systemMap.rootPath);
        for (const dbFile of dbFiles.slice(0, 3)) {
            results.push(checkSqliteIntegrity(dbFile, systemMap, log));
            results.push(checkSqliteSize(dbFile, systemMap, log));
            results.push(checkSqliteTables(dbFile, systemMap, log));
        }
    }
    // Prisma checks
    if (systemMap.databases.includes('prisma')) {
        results.push(checkPrismaSchema(systemMap, log));
    }
    // Migration health
    results.push(checkMigrationHealth(systemMap, log));
    // Database code patterns
    results.push(checkDbCodePatterns(systemMap, log));
    return results;
}
function findSqliteFiles(root) {
    const files = [];
    const dataDirs = ['.', 'data', 'db', 'database', 'prisma'];
    for (const dir of dataDirs) {
        const fullDir = path.join(root, dir);
        if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory())
            continue;
        try {
            const entries = fs.readdirSync(fullDir);
            for (const entry of entries) {
                if (entry.endsWith('.db') || entry.endsWith('.sqlite') || entry.endsWith('.sqlite3')) {
                    files.push(path.join(fullDir, entry));
                }
            }
        }
        catch { /* skip */ }
    }
    return files;
}
function checkSqliteIntegrity(dbPath, systemMap, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const relPath = path.relative(root, dbPath);
    try {
        const result = (0, child_process_1.execSync)(`sqlite3 "${dbPath}" "PRAGMA integrity_check;"`, {
            encoding: 'utf-8', timeout: 15000,
        }).trim();
        const passed = result === 'ok';
        return {
            layer: 'database', checkName: `sqlite-integrity: ${relPath}`,
            passed, duration: Date.now() - start,
            findings: passed ? [] : [(0, types_1.createFinding)({
                    severity: 'critical', layer: 'database', subsystem: 'sqlite',
                    title: `SQLite integrity check failed: ${relPath}`,
                    description: `PRAGMA integrity_check returned: ${result}`,
                    evidence: result, likelyCause: 'Database corruption',
                    confidence: 'high',
                    recommendedAction: 'Restore from backup or run .recover',
                })],
            details: passed ? `${relPath}: integrity OK` : `${relPath}: INTEGRITY FAILURE`,
            skipped: false,
        };
    }
    catch (err) {
        return {
            layer: 'database', checkName: `sqlite-integrity: ${relPath}`,
            passed: false, duration: Date.now() - start,
            findings: [(0, types_1.createFinding)({
                    severity: 'high', layer: 'database', subsystem: 'sqlite',
                    title: `Cannot check SQLite integrity: ${relPath}`,
                    description: err.message,
                    evidence: err.message, likelyCause: 'Database locked or sqlite3 not installed',
                    confidence: 'medium',
                    recommendedAction: 'Ensure sqlite3 is installed and database is not locked',
                })],
            details: `${relPath}: could not check — ${err.message.slice(0, 100)}`,
            skipped: false,
        };
    }
}
function checkSqliteSize(dbPath, systemMap, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const relPath = path.relative(root, dbPath);
    try {
        const stat = fs.statSync(dbPath);
        const sizeMB = stat.size / (1024 * 1024);
        const passed = sizeMB < 500; // Flag if over 500MB
        const findings = [];
        if (!passed) {
            findings.push((0, types_1.createFinding)({
                severity: 'medium', layer: 'database', subsystem: 'sqlite',
                title: `Large SQLite database: ${relPath}`,
                description: `Database is ${sizeMB.toFixed(1)}MB`,
                evidence: `File size: ${stat.size} bytes`,
                likelyCause: 'Data accumulation without cleanup',
                confidence: 'high',
                recommendedAction: 'Consider archiving old data or running VACUUM',
            }));
        }
        return {
            layer: 'database', checkName: `sqlite-size: ${relPath}`,
            passed, duration: Date.now() - start, findings,
            details: `${relPath}: ${sizeMB.toFixed(1)}MB`,
            skipped: false,
        };
    }
    catch {
        return {
            layer: 'database', checkName: `sqlite-size: ${relPath}`,
            passed: true, duration: Date.now() - start, findings: [],
            details: `Could not stat ${relPath}`, skipped: true,
        };
    }
}
function checkSqliteTables(dbPath, systemMap, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const relPath = path.relative(root, dbPath);
    try {
        const tables = (0, child_process_1.execSync)(`sqlite3 "${dbPath}" ".tables"`, {
            encoding: 'utf-8', timeout: 10000,
        }).trim();
        const tableList = tables.split(/\s+/).filter(Boolean);
        const findings = [];
        if (tableList.length === 0) {
            findings.push((0, types_1.createFinding)({
                severity: 'high', layer: 'database', subsystem: 'sqlite',
                title: `Empty database: ${relPath}`,
                description: 'Database has no tables',
                evidence: 'No tables found',
                likelyCause: 'Migrations not run or wrong database file',
                confidence: 'high',
                recommendedAction: 'Run migrations or check database path',
            }));
        }
        // Check each table has rows
        for (const table of tableList.slice(0, 20)) {
            try {
                const count = (0, child_process_1.execSync)(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM ${table};"`, { encoding: 'utf-8', timeout: 5000 }).trim();
                if (count === '0' && !table.includes('migration') && !table.includes('_prisma')) {
                    findings.push((0, types_1.createFinding)({
                        severity: 'low', layer: 'database', subsystem: 'sqlite',
                        title: `Empty table: ${table}`,
                        description: `Table ${table} in ${relPath} has 0 rows`,
                        evidence: `SELECT COUNT(*) FROM ${table} = 0`,
                        likelyCause: 'No data yet or data was cleared',
                        confidence: 'medium',
                        recommendedAction: 'Verify this is expected',
                    }));
                }
            }
            catch { /* skip */ }
        }
        return {
            layer: 'database', checkName: `sqlite-tables: ${relPath}`,
            passed: tableList.length > 0,
            duration: Date.now() - start, findings: findings.slice(0, 10),
            details: `${relPath}: ${tableList.length} tables (${tableList.slice(0, 5).join(', ')}${tableList.length > 5 ? '...' : ''})`,
            skipped: false,
        };
    }
    catch (err) {
        return {
            layer: 'database', checkName: `sqlite-tables: ${relPath}`,
            passed: false, duration: Date.now() - start,
            findings: [], details: `Could not read tables: ${err.message.slice(0, 100)}`,
            skipped: true,
        };
    }
}
function checkPrismaSchema(systemMap, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const schemaPath = path.join(root, 'prisma', 'schema.prisma');
    if (!fs.existsSync(schemaPath)) {
        return {
            layer: 'database', checkName: 'prisma-schema',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'No Prisma schema found', skipped: true,
        };
    }
    try {
        const result = (0, child_process_1.execSync)('npx prisma validate 2>&1', {
            cwd: root, encoding: 'utf-8', timeout: 30000,
        });
        return {
            layer: 'database', checkName: 'prisma-schema',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'Prisma schema valid', skipped: false,
        };
    }
    catch (err) {
        return {
            layer: 'database', checkName: 'prisma-schema',
            passed: false, duration: Date.now() - start,
            findings: [(0, types_1.createFinding)({
                    severity: 'high', layer: 'database', subsystem: 'prisma',
                    title: 'Prisma schema validation failed',
                    description: (err.stdout || err.message || '').slice(0, 500),
                    evidence: (err.stdout || err.message || '').slice(0, 500),
                    likelyCause: 'Invalid schema definition',
                    confidence: 'high',
                    recommendedAction: 'Fix Prisma schema errors',
                })],
            details: 'Prisma schema INVALID', skipped: false,
        };
    }
}
function checkMigrationHealth(systemMap, log) {
    const start = Date.now();
    const root = systemMap.rootPath;
    const migrationDirs = ['prisma/migrations', 'migrations', 'db/migrate', 'alembic/versions'];
    let migrationDir = null;
    let migrationCount = 0;
    for (const dir of migrationDirs) {
        const fullPath = path.join(root, dir);
        if (fs.existsSync(fullPath)) {
            migrationDir = dir;
            try {
                migrationCount = fs.readdirSync(fullPath).filter(f => !f.startsWith('.')).length;
            }
            catch { /* skip */ }
            break;
        }
    }
    if (!migrationDir) {
        return {
            layer: 'database', checkName: 'migration-health',
            passed: true, duration: Date.now() - start, findings: [],
            details: 'No migrations directory found', skipped: true,
        };
    }
    return {
        layer: 'database', checkName: 'migration-health',
        passed: true, duration: Date.now() - start, findings: [],
        details: `${migrationDir}: ${migrationCount} migration(s)`, skipped: false,
    };
}
function checkDbCodePatterns(systemMap, log) {
    const start = Date.now();
    const findingsList = [];
    const root = systemMap.rootPath;
    const dbFiles = systemMap.components.filter(c => c.type === 'database' || c.type === 'model' || c.type === 'api').slice(0, 50);
    let sqlInjectionRisk = 0;
    for (const file of dbFiles) {
        try {
            const content = fs.readFileSync(file.path, 'utf-8');
            // Check for string interpolation in SQL
            const sqlInterp = content.match(/(?:query|exec|run|prepare|sql)\s*\(\s*`[^`]*\$\{/gi);
            if (sqlInterp) {
                sqlInjectionRisk++;
                findingsList.push((0, types_1.createFinding)({
                    severity: 'high', layer: 'database', subsystem: 'sql-safety',
                    title: 'Possible SQL injection risk',
                    description: `${path.relative(root, file.path)} uses string interpolation in SQL`,
                    evidence: sqlInterp[0].slice(0, 100),
                    likelyCause: 'Template literals in SQL queries without parameterization',
                    confidence: 'medium',
                    recommendedAction: 'Use parameterized queries instead of string interpolation',
                    filePath: file.path,
                }));
            }
        }
        catch { /* skip */ }
    }
    return {
        layer: 'database', checkName: 'db-code-patterns',
        passed: sqlInjectionRisk === 0,
        duration: Date.now() - start, findings: findingsList.slice(0, 10),
        details: `${sqlInjectionRisk} SQL injection risk(s)`, skipped: false,
    };
}
//# sourceMappingURL=database.js.map