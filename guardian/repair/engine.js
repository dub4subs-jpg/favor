"use strict";
// =============================================================================
// Guardian — Phase 8: Safe Self-Healing / Repair Engine
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
exports.RepairEngine = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const types_1 = require("../types");
class RepairEngine {
    config;
    log;
    repairs = [];
    constructor(config, log) {
        this.config = config;
        this.log = log;
    }
    async processFindings(layerResults) {
        if (!this.config.allowRepair || this.config.repairLevel === 'none') {
            this.log.info('Repair mode disabled — skipping');
            return [];
        }
        this.log.section('REPAIR ENGINE');
        const findings = layerResults.flatMap(lr => lr.results.flatMap(r => r.findings));
        // Filter to repairable findings
        const repairable = findings.filter(f => this.isRepairable(f));
        this.log.info(`${repairable.length} potentially repairable finding(s) out of ${findings.length}`);
        for (const finding of repairable) {
            const repair = await this.attemptRepair(finding);
            if (repair) {
                this.repairs.push(repair);
            }
        }
        const applied = this.repairs.filter(r => r.applied);
        const succeeded = this.repairs.filter(r => r.retestPassed);
        this.log.success(`Repairs: ${applied.length} applied, ${succeeded.length} verified`);
        return this.repairs;
    }
    // ─── Safety Checks ────────────────────────────────────────────────
    isRepairable(finding) {
        // Never auto-repair sensitive areas
        const lower = (finding.title + finding.description + finding.subsystem + (finding.filePath || '')).toLowerCase();
        for (const keyword of types_1.NEVER_AUTO_REPAIR) {
            if (lower.includes(keyword)) {
                this.log.debug(`Skipping repair for "${finding.title}" — touches sensitive area: ${keyword}`);
                return false;
            }
        }
        // Only repair if we have a file path
        if (!finding.filePath)
            return false;
        // Only repair low-severity issues unless moderate level
        if (this.config.repairLevel === 'safe') {
            return finding.severity === 'low' || finding.severity === 'info';
        }
        if (this.config.repairLevel === 'moderate') {
            return finding.severity !== 'critical';
        }
        return false;
    }
    assessRisk(finding) {
        const filePath = finding.filePath?.toLowerCase() || '';
        if (types_1.NEVER_AUTO_REPAIR.some(k => filePath.includes(k)))
            return 'dangerous';
        if (filePath.includes('config') || filePath.includes('migration') ||
            filePath.includes('middleware'))
            return 'moderate';
        if (finding.severity === 'low' || finding.severity === 'info')
            return 'safe';
        if (finding.severity === 'medium')
            return 'low';
        if (finding.severity === 'high')
            return 'moderate';
        return 'high';
    }
    // ─── Repair Strategies ────────────────────────────────────────────
    async attemptRepair(finding) {
        const risk = this.assessRisk(finding);
        const maxRisk = this.config.repairLevel === 'safe' ? 'low' :
            this.config.repairLevel === 'moderate' ? 'moderate' : 'safe';
        const riskOrder = {
            safe: 0, low: 1, moderate: 2, high: 3, dangerous: 4,
        };
        if (riskOrder[risk] > riskOrder[maxRisk]) {
            this.log.debug(`Skipping repair for "${finding.title}" — risk ${risk} exceeds threshold ${maxRisk}`);
            return null;
        }
        const filePath = finding.filePath;
        if (!fs.existsSync(filePath))
            return null;
        const originalContent = fs.readFileSync(filePath, 'utf-8');
        let proposedContent = null;
        let description = '';
        // Strategy: Fix empty catch blocks
        if (finding.title.includes('Empty catch block')) {
            proposedContent = originalContent.replace(/catch\s*\(\s*(\w*)\s*\)\s*\{\s*\}/g, (match, varName) => {
                const name = varName || 'err';
                return `catch (${name}) {\n    console.error('Caught error:', ${name});\n  }`;
            });
            description = 'Added console.error to empty catch blocks';
        }
        // Strategy: Fix missing null checks (simple cases)
        if (finding.title.includes('render-safety') && finding.description.includes('dangerouslySetInnerHTML')) {
            // Don't auto-fix dangerouslySetInnerHTML — too risky
            return null;
        }
        if (!proposedContent || proposedContent === originalContent) {
            // No applicable strategy found
            return null;
        }
        // Apply the repair
        const repair = {
            finding,
            risk,
            description,
            filePath,
            originalContent,
            proposedContent,
            applied: false,
        };
        try {
            // Create backup
            const backupPath = filePath + '.guardian-backup';
            fs.writeFileSync(backupPath, originalContent);
            // Apply change
            fs.writeFileSync(filePath, proposedContent);
            repair.applied = true;
            this.log.info(`  Applied: ${description} in ${path.relative(this.config.target, filePath)}`);
            // Retest
            repair.retestPassed = await this.retest(filePath);
            if (!repair.retestPassed) {
                // Rollback
                fs.writeFileSync(filePath, originalContent);
                repair.applied = false;
                this.log.warn(`  Rolled back: ${description} (retest failed)`);
            }
            else {
                this.log.success(`  Verified: ${description}`);
            }
            // Clean up backup
            if (fs.existsSync(backupPath)) {
                fs.unlinkSync(backupPath);
            }
        }
        catch (err) {
            this.log.error(`  Failed to apply repair: ${err.message}`);
            // Ensure original content is restored
            try {
                fs.writeFileSync(filePath, originalContent);
            }
            catch { /* last resort */ }
        }
        return repair;
    }
    async retest(filePath) {
        const root = this.config.target;
        // TypeScript check if it's a .ts file
        if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
            try {
                (0, child_process_1.execSync)('npx tsc --noEmit 2>&1', {
                    cwd: root, encoding: 'utf-8', timeout: 30000,
                });
                return true;
            }
            catch {
                return false;
            }
        }
        // For JS files, just check syntax
        if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
            try {
                (0, child_process_1.execSync)(`node --check "${filePath}" 2>&1`, {
                    encoding: 'utf-8', timeout: 10000,
                });
                return true;
            }
            catch {
                return false;
            }
        }
        // Default: assume OK if file writes successfully
        return true;
    }
    getRepairs() {
        return this.repairs;
    }
}
exports.RepairEngine = RepairEngine;
//# sourceMappingURL=engine.js.map