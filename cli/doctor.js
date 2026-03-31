#!/usr/bin/env node
// cli/doctor.js — Favor diagnostic CLI
// Usage: node cli/doctor.js
// Checks system health, dependencies, config, and platform readiness.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ─── COLORS ───
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const PASS = `${GREEN}[pass]${RESET}`;
const WARN = `${YELLOW}[warn]${RESET}`;
const FAIL = `${RED}[FAIL]${RESET}`;

// ─── HELPERS ───
function which(cmd) {
  try {
    return execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim();
  } catch { return null; }
}

function tryExec(cmd, timeout = 5000) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
}

function fileSize(filepath) {
  try {
    const stat = fs.statSync(filepath);
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    return `${mb}MB`;
  } catch { return null; }
}

// ─── CHECK FUNCTIONS ───
// Each returns { status: 'pass'|'warn'|'fail', category: string, message: string }

function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1));
  if (major >= 18) {
    return { status: 'pass', category: 'Runtime', message: `Node.js ${version} (>= 18 required)` };
  }
  return { status: 'fail', category: 'Runtime', message: `Node.js ${version} — requires >= 18` };
}

function checkNpmDeps() {
  const nmPath = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nmPath)) {
    return { status: 'fail', category: 'Runtime', message: 'node_modules missing — run npm install' };
  }
  // Check a few critical packages
  const critical = ['@whiskeysockets/baileys', 'better-sqlite3', 'openai'];
  const missing = critical.filter(p => !fs.existsSync(path.join(nmPath, p)));
  if (missing.length > 0) {
    return { status: 'fail', category: 'Runtime', message: `Missing packages: ${missing.join(', ')}` };
  }
  return { status: 'pass', category: 'Runtime', message: 'npm dependencies installed' };
}

function checkClaudeCLI() {
  try {
    const { detectClaudeCLI, isAvailable } = require(path.join(ROOT, 'utils', 'claude'));
    detectClaudeCLI();
    if (isAvailable()) {
      return { status: 'pass', category: 'Runtime', message: `Claude CLI detected` };
    }
  } catch {}
  // Fallback: check PATH
  const bin = which('claude');
  if (bin) return { status: 'pass', category: 'Runtime', message: `Claude CLI at ${bin}` };
  return { status: 'warn', category: 'Runtime', message: 'Claude CLI not found — bot will use API fallbacks only' };
}

function checkConfig() {
  const configPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { status: 'fail', category: 'Config', message: 'config.json not found — copy config.example.json' };
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const issues = [];
    if (!config.platform) issues.push('missing "platform"');
    if (!config.api) issues.push('missing "api" section');
    if (!config.memory) issues.push('missing "memory" section');
    if (issues.length > 0) {
      return { status: 'fail', category: 'Config', message: `config.json issues: ${issues.join(', ')}` };
    }
    return { status: 'pass', category: 'Config', message: 'config.json valid' };
  } catch (e) {
    return { status: 'fail', category: 'Config', message: `config.json parse error: ${e.message}` };
  }
}

function checkApiKeys() {
  const configPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) return null; // skip if no config
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const checks = [];
    const api = config.api || {};
    if (api.openaiApiKey && api.openaiApiKey !== 'YOUR_OPENAI_API_KEY') {
      checks.push({ status: 'pass', category: 'Config', message: 'OpenAI API key configured' });
    } else {
      checks.push({ status: 'warn', category: 'Config', message: 'OpenAI API key not set (tool loop fallback disabled)' });
    }
    if (api.geminiApiKey && api.geminiApiKey !== 'YOUR_GEMINI_API_KEY') {
      checks.push({ status: 'pass', category: 'Config', message: 'Gemini API key configured' });
    } else {
      checks.push({ status: 'warn', category: 'Config', message: 'Gemini API key not set (optional)' });
    }
    const vault = config.vault || {};
    if (vault.secret && vault.secret !== 'CHANGE_THIS_TO_A_RANDOM_SECRET') {
      checks.push({ status: 'pass', category: 'Config', message: 'Vault secret configured' });
    } else {
      checks.push({ status: 'warn', category: 'Config', message: 'Vault secret not set — vault features disabled' });
    }
    return checks;
  } catch { return null; }
}

function checkDatabase() {
  const configPath = path.join(ROOT, 'config.json');
  let dbPath = path.join(ROOT, 'data', 'favor.db');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.memory?.dbPath) {
      dbPath = path.isAbsolute(config.memory.dbPath) ? config.memory.dbPath : path.join(ROOT, config.memory.dbPath);
    }
  } catch {}

  if (!fs.existsSync(dbPath)) {
    return { status: 'warn', category: 'Database', message: 'SQLite DB not found (will be created on first run)' };
  }
  const size = fileSize(dbPath);
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const integrity = db.pragma('integrity_check');
    const memCount = db.prepare('SELECT COUNT(*) as cnt FROM memories').get();
    db.close();
    const integrityOk = integrity[0]?.integrity_check === 'ok';
    if (integrityOk) {
      return { status: 'pass', category: 'Database', message: `SQLite integrity OK (${size}, ${memCount.cnt} memories)` };
    }
    return { status: 'fail', category: 'Database', message: `SQLite integrity FAILED (${size})` };
  } catch (e) {
    return { status: 'warn', category: 'Database', message: `SQLite check skipped: ${e.message}` };
  }
}

function checkSystem() {
  const results = [];
  // RAM
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedPct = Math.round((1 - freeMem / totalMem) * 100);
  const freeMB = Math.round(freeMem / 1024 / 1024);
  if (usedPct > 90) {
    results.push({ status: 'fail', category: 'System', message: `RAM: ${usedPct}% used (${freeMB}MB free) — CRITICAL` });
  } else if (usedPct > 75) {
    results.push({ status: 'warn', category: 'System', message: `RAM: ${usedPct}% used (${freeMB}MB free)` });
  } else {
    results.push({ status: 'pass', category: 'System', message: `RAM: ${usedPct}% used (${freeMB}MB free)` });
  }

  // Disk
  const df = tryExec("df -h / | tail -1 | awk '{print $5}'");
  if (df) {
    const diskPct = parseInt(df);
    if (diskPct > 90) {
      results.push({ status: 'fail', category: 'System', message: `Disk: ${df} used — CRITICAL` });
    } else if (diskPct > 75) {
      results.push({ status: 'warn', category: 'System', message: `Disk: ${df} used` });
    } else {
      results.push({ status: 'pass', category: 'System', message: `Disk: ${df} used` });
    }
  }

  // Swap
  const swapTotal = tryExec("free -m | grep Swap | awk '{print $2}'");
  const swapUsed = tryExec("free -m | grep Swap | awk '{print $3}'");
  if (swapTotal && swapUsed && parseInt(swapTotal) > 0) {
    const swapPct = Math.round((parseInt(swapUsed) / parseInt(swapTotal)) * 100);
    if (swapPct > 80) {
      results.push({ status: 'warn', category: 'System', message: `Swap: ${swapPct}% used (${swapUsed}MB/${swapTotal}MB)` });
    } else {
      results.push({ status: 'pass', category: 'System', message: `Swap: ${swapPct}% used` });
    }
  }
  return results;
}

function checkExternalTools(quiet) {
  const results = [];
  const tools = [
    { cmd: 'ffmpeg', label: 'ffmpeg', required: false },
    { cmd: 'yt-dlp', label: 'yt-dlp', required: false },
    { cmd: 'pm2', label: 'pm2', required: false },
  ];

  if (!quiet) {
    tools.push(
      { cmd: 'chromium-browser', alt: ['chromium', 'google-chrome'], label: 'chromium', required: false },
      { cmd: 'python3', label: 'python3', required: false },
    );
  }

  for (const tool of tools) {
    let found = which(tool.cmd);
    if (!found && tool.alt) {
      for (const alt of tool.alt) {
        found = which(alt);
        if (found) break;
      }
    }
    if (found) {
      results.push({ status: 'pass', category: 'Tools', message: tool.label });
    } else {
      results.push({ status: 'warn', category: 'Tools', message: `${tool.label} not found (${tool.label} features will not work)` });
    }
  }

  // Check faster-whisper (Python)
  if (!quiet) {
    const whisper = tryExec('python3 -c "import faster_whisper; print(\'ok\')" 2>/dev/null');
    if (whisper === 'ok') {
      results.push({ status: 'pass', category: 'Tools', message: 'faster-whisper' });
    } else {
      results.push({ status: 'warn', category: 'Tools', message: 'faster-whisper not installed (voice transcription limited)' });
    }
  }

  return results;
}

function checkPlatformAuth() {
  const configPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const platform = config.platform || 'whatsapp';

    if (platform === 'whatsapp') {
      const authDir = config.whatsapp?.credentialsDir || './auth-state';
      const fullPath = path.isAbsolute(authDir) ? authDir : path.join(ROOT, authDir);
      if (fs.existsSync(fullPath) && fs.readdirSync(fullPath).length > 0) {
        return { status: 'pass', category: 'Platform', message: 'WhatsApp credentials found' };
      }
      return { status: 'warn', category: 'Platform', message: 'WhatsApp auth-state empty — will need QR scan' };
    } else if (platform === 'telegram') {
      const token = config.telegram?.botToken;
      if (token && token !== 'YOUR_BOT_TOKEN_FROM_BOTFATHER') {
        return { status: 'pass', category: 'Platform', message: 'Telegram bot token configured' };
      }
      return { status: 'fail', category: 'Platform', message: 'Telegram botToken not set' };
    } else if (platform === 'evolution') {
      const evoConfig = config.evolution || {};
      if (evoConfig.apiUrl && evoConfig.apiKey) {
        return { status: 'pass', category: 'Platform', message: 'Evolution API configured' };
      }
      return { status: 'warn', category: 'Platform', message: 'Evolution API not configured' };
    }
  } catch {}
  return null;
}

function checkNetwork(quiet) {
  if (quiet) return [];
  const results = [];

  // Check port 3099
  const portCheck = tryExec('ss -tlnp sport = :3099 2>/dev/null || netstat -tlnp 2>/dev/null | grep :3099');
  if (portCheck && portCheck.includes('3099')) {
    results.push({ status: 'pass', category: 'Network', message: 'Port 3099 in use (notify server running)' });
  } else {
    results.push({ status: 'pass', category: 'Network', message: 'Port 3099 available' });
  }

  return results;
}

// ─── MAIN ───

/**
 * Run all doctor checks.
 * @param {object} options
 * @param {boolean} options.quiet - Skip slow checks (for /health endpoint)
 * @returns {Array<{ status: string, category: string, message: string }>}
 */
async function runDoctor(options = {}) {
  const quiet = options.quiet || false;
  const checks = [];

  checks.push(checkNodeVersion());
  checks.push(checkNpmDeps());
  checks.push(checkClaudeCLI());
  checks.push(checkConfig());

  const apiChecks = checkApiKeys();
  if (apiChecks) checks.push(...apiChecks);

  checks.push(checkDatabase());
  checks.push(...checkSystem());
  checks.push(...checkExternalTools(quiet));

  const platformCheck = checkPlatformAuth();
  if (platformCheck) checks.push(platformCheck);

  checks.push(...checkNetwork(quiet));

  return checks.filter(Boolean);
}

// ─── CLI OUTPUT ───

function statusIcon(status) {
  if (status === 'pass') return PASS;
  if (status === 'warn') return WARN;
  return FAIL;
}

async function main() {
  let version = '?';
  try { version = require(path.join(ROOT, 'package.json')).version; } catch {}

  console.log(`\n${BOLD}Favor Doctor v${version}${RESET}`);
  console.log('='.repeat(30) + '\n');

  const checks = await runDoctor();

  // Group by category
  const groups = {};
  for (const check of checks) {
    if (!groups[check.category]) groups[check.category] = [];
    groups[check.category].push(check);
  }

  for (const [category, items] of Object.entries(groups)) {
    console.log(`${BOLD}${category}${RESET}`);
    for (const item of items) {
      console.log(`  ${statusIcon(item.status)} ${item.message}`);
    }
    console.log();
  }

  // Summary
  const passed = checks.filter(c => c.status === 'pass').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const failed = checks.filter(c => c.status === 'fail').length;

  const summaryColor = failed > 0 ? RED : warned > 0 ? YELLOW : GREEN;
  console.log(`${summaryColor}Summary: ${passed} passed, ${warned} warnings, ${failed} failures${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

// Export for /health endpoint and tests
module.exports = { runDoctor };

// Run if called directly
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
