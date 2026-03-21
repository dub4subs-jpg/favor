"use strict";
// =============================================================================
// Guardian — Universal QA Framework — Shared Types
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEVER_AUTO_REPAIR = void 0;
exports.createLogger = createLogger;
exports.generateId = generateId;
exports.createFinding = createFinding;
// Sensitive areas that must NEVER be auto-repaired
exports.NEVER_AUTO_REPAIR = [
    'auth', 'authentication', 'authorization', 'permission',
    'payment', 'billing', 'pricing', 'charge', 'stripe', 'paypal',
    'delete', 'drop', 'truncate', 'destroy',
    'compliance', 'legal', 'gdpr', 'hipaa',
    'encryption', 'decrypt', 'secret', 'credential',
];
function createLogger(verbose) {
    return {
        info: (msg) => console.log(`  ${msg}`),
        warn: (msg) => console.log(`  ⚠ ${msg}`),
        error: (msg) => console.log(`  ✗ ${msg}`),
        debug: (msg) => { if (verbose)
            console.log(`  · ${msg}`); },
        success: (msg) => console.log(`  ✓ ${msg}`),
        section: (title) => console.log(`\n━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}`),
    };
}
function generateId() {
    return `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function createFinding(partial) {
    return {
        ...partial,
        id: generateId(),
        timestamp: new Date().toISOString(),
        repairAttempted: false,
        status: 'new',
    };
}
//# sourceMappingURL=types.js.map