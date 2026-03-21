"use strict";
// =============================================================================
// Guardian — CLI Entrypoint
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const index_1 = require("./index");
async function main() {
    const args = process.argv.slice(2);
    // Parse CLI arguments
    const overrides = (0, config_1.parseCliArgs)(args);
    const config = (0, config_1.loadConfig)(overrides);
    try {
        if (config.mode === 'monitor') {
            await (0, index_1.runGuardianMonitor)(config);
        }
        else {
            const report = await (0, index_1.runGuardian)(config);
            // Exit with error code if health score is critical
            if (report.healthScore.overall < 30) {
                process.exit(2); // Critical health
            }
            else if (report.findings.some(f => f.severity === 'critical')) {
                process.exit(1); // Has critical findings
            }
        }
    }
    catch (err) {
        console.error(`\nGuardian error: ${err.message}`);
        if (config.verbose) {
            console.error(err.stack);
        }
        process.exit(1);
    }
}
main();
//# sourceMappingURL=cli.js.map