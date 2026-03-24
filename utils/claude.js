// utils/claude.js — Shared Claude CLI detection and execution helpers
// Single source of truth — replaces 4 duplicate detectClaudeCLI() implementations
// across router.js, compactor.js, alive/checkins.js, alive/callbacks.js

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const pathModule = require('path');

let CLAUDE_BIN = null;
let CLAUDE_AVAILABLE = false;

/**
 * Detect Claude Code CLI location.
 * Checks common install paths then falls back to PATH lookup.
 * Call once at startup — results are cached.
 */
function detectClaudeCLI() {
  const candidates = [
    process.env.CLAUDE_BIN,
    '/root/.local/bin/claude',
    '/usr/local/bin/claude',
    '/home/' + (process.env.USER || 'root') + '/.local/bin/claude',
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) {
        CLAUDE_BIN = bin;
        CLAUDE_AVAILABLE = true;
        return bin;
      }
    } catch {}
  }

  // Last resort: check PATH
  try {
    const which = execSync('which claude 2>/dev/null', { encoding: 'utf8' }).trim();
    if (which) {
      CLAUDE_BIN = which;
      CLAUDE_AVAILABLE = true;
      return which;
    }
  } catch {}

  return null;
}

/**
 * Get the detected Claude CLI binary path.
 * @returns {string|null}
 */
function getClaudeBin() {
  return CLAUDE_BIN;
}

/**
 * Check if Claude CLI is available.
 * @returns {boolean}
 */
function isAvailable() {
  return CLAUDE_AVAILABLE;
}

/**
 * Build a sanitized environment for Claude CLI subprocesses.
 * Strips ANTHROPIC_API_KEY so Claude CLI uses Max/Pro subscription (free).
 * @returns {Object} env object
 */
function claudeEnv() {
  const binDir = CLAUDE_BIN ? pathModule.dirname(CLAUDE_BIN) : '/root/.local/bin';
  return Object.fromEntries(
    Object.entries({ ...process.env, PATH: `${binDir}:${process.env.PATH}` })
      .filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ANTHROPIC_REUSE') && k !== 'ANTHROPIC_API_KEY')
  );
}

/**
 * Run Claude CLI with a prompt via stdin (handles long prompts safely).
 * @param {string} prompt - The prompt text
 * @param {Object} opts
 * @param {string} [opts.model='haiku'] - Model name
 * @param {number} [opts.timeout=30000] - Timeout in ms
 * @param {string} [opts.allowedTools=''] - Comma-separated tool names
 * @returns {Promise<string>} CLI output text
 */
function runCLI(prompt, opts = {}) {
  const model = opts.model || 'haiku';
  const timeout = opts.timeout || 30000;
  const allowedTools = opts.allowedTools || '';

  if (!CLAUDE_BIN) return Promise.reject(new Error('Claude Code CLI not installed'));

  return new Promise((resolve, reject) => {
    const args = ['--print', '--model', model];
    if (allowedTools) {
      args.push('--allowedTools', allowedTools);
    } else {
      args.push('--allowedTools', '');
    }
    args.push('-'); // read from stdin

    const proc = spawn(CLAUDE_BIN, args, {
      timeout,
      env: claudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', (code) => {
      const out = stdout.trim() || stderr.trim() || '';
      if (code === 0 || out) resolve(out);
      else reject(new Error(`Claude CLI exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// Auto-detect on first require
detectClaudeCLI();

module.exports = {
  detectClaudeCLI,
  getClaudeBin,
  isAvailable,
  claudeEnv,
  runCLI,
};
