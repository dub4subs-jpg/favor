"use strict";
// =============================================================================
// Guardian — Configuration Manager
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
exports.loadConfig = loadConfig;
exports.parseCliArgs = parseCliArgs;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DEFAULT_CONFIG = {
    target: '.',
    mode: 'deep',
    scope: 'full',
    riskTolerance: 'low',
    allowRepair: false,
    repairLevel: 'none',
    monitorInterval: 300, // 5 minutes
    baselineDir: '.guardian',
    ignorePatterns: [
        'node_modules', '.git', '.next', '__pycache__', 'dist', 'build',
        '.cache', 'coverage', '.nyc_output', 'vendor', 'target',
    ],
    verbose: false,
    maxConcurrency: 4,
    timeout: 30000,
};
const CONFIG_FILENAMES = [
    'guardian.config.json',
    '.guardianrc.json',
    '.guardian.json',
];
function loadConfig(overrides = {}) {
    const target = overrides.target || DEFAULT_CONFIG.target;
    const resolvedTarget = path.resolve(target);
    // Search for config file in target directory
    let fileConfig = {};
    for (const filename of CONFIG_FILENAMES) {
        const configPath = path.join(resolvedTarget, filename);
        if (fs.existsSync(configPath)) {
            try {
                const raw = fs.readFileSync(configPath, 'utf-8');
                fileConfig = JSON.parse(raw);
                break;
            }
            catch {
                // Invalid config file, skip
            }
        }
    }
    // Merge: defaults < file config < CLI overrides
    const config = {
        ...DEFAULT_CONFIG,
        ...fileConfig,
        ...overrides,
        target: resolvedTarget,
    };
    // Infer scope from mode if targeted
    if (config.mode === 'targeted' && !config.customScope) {
        config.customScope = config.target;
    }
    // Repair mode implies allowRepair
    if (config.mode === 'repair') {
        config.allowRepair = true;
        if (config.repairLevel === 'none') {
            config.repairLevel = 'safe';
        }
    }
    return config;
}
function parseCliArgs(args) {
    const overrides = {};
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (!arg.startsWith('-')) {
            // Positional arg = target path
            overrides.target = arg;
            i++;
            continue;
        }
        switch (arg) {
            case '--mode':
            case '-m':
                overrides.mode = args[++i];
                break;
            case '--scope':
            case '-s':
                overrides.scope = args[++i];
                break;
            case '--custom-scope':
                overrides.customScope = args[++i];
                break;
            case '--repair':
                overrides.allowRepair = true;
                overrides.repairLevel = 'safe';
                break;
            case '--repair-level':
                overrides.repairLevel = args[++i];
                break;
            case '--risk':
                overrides.riskTolerance = args[++i];
                break;
            case '--monitor-interval':
                overrides.monitorInterval = parseInt(args[++i], 10);
                break;
            case '--baseline-dir':
                overrides.baselineDir = args[++i];
                break;
            case '--ignore':
                overrides.ignorePatterns = args[++i].split(',');
                break;
            case '--critical':
                overrides.criticalPaths = args[++i].split(',');
                break;
            case '--env-file':
                overrides.envFile = args[++i];
                break;
            case '--notify':
                overrides.notifyCommand = args[++i];
                break;
            case '--verbose':
            case '-v':
                overrides.verbose = true;
                break;
            case '--concurrency':
                overrides.maxConcurrency = parseInt(args[++i], 10);
                break;
            case '--timeout':
                overrides.timeout = parseInt(args[++i], 10);
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
        i++;
    }
    return overrides;
}
function printHelp() {
    console.log(`
Guardian — Universal QA / Watchdog / Regression Detection Framework

USAGE:
  guardian [target] [options]

POSITIONAL:
  target                    Path to scan (default: current directory)

MODES (--mode / -m):
  smoke       Fast health checks for core viability
  feature     Verify discovered features and critical paths
  deep        Full multi-layer audit (default)
  regression  Compare current state vs known-good baseline
  repair      Attempt safe low-risk fixes and retest
  monitor     Recurring guardian mode (long-running)
  deploy      Post-deployment validation
  targeted    Scan specific subsystem only

SCOPE (--scope / -s):
  full         Scan everything (default)
  frontend     Frontend code only
  backend      Backend code only
  api          API routes/endpoints only
  workers      Workers/background jobs only
  agents       AI agent components only
  integrations External integrations only
  database     Database/data layer only
  custom       Use --custom-scope path

OPTIONS:
  --repair                  Enable safe auto-repair
  --repair-level <level>    none | safe | moderate (default: none)
  --risk <tolerance>        low | medium | high (default: low)
  --monitor-interval <sec>  Seconds between monitor runs (default: 300)
  --baseline-dir <path>     Where to store baselines (default: .guardian)
  --ignore <patterns>       Comma-separated glob patterns to ignore
  --critical <paths>        Comma-separated critical path overrides
  --env-file <path>         Path to .env for integration checks
  --notify <command>        Shell command for alert delivery
  --verbose / -v            Verbose output
  --concurrency <n>         Max concurrent checks (default: 4)
  --timeout <ms>            Per-check timeout in ms (default: 30000)
  --help / -h               Show this help

EXAMPLES:
  guardian .                           # Deep scan current directory
  guardian ./frontend --scope frontend # Scan frontend only
  guardian . --mode smoke              # Quick health check
  guardian . --mode repair --repair    # Find and fix low-risk issues
  guardian . --mode monitor            # Continuous monitoring
  guardian . --mode regression         # Compare against baseline
  guardian /path/to/repo --mode deploy # Post-deploy validation
  guardian ./api --mode targeted -s api # Scan API subsystem
`);
}
//# sourceMappingURL=config.js.map