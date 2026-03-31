// core/sandbox.js — Lightweight command sandboxing for dangerous tool execution
// Wraps child_process.execSync with blocked-pattern detection, env filtering, and timeouts.
// Inspired by OpenClaw's Docker sandbox, but no Docker required.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── BLOCKED PATTERNS ───
// Commands that should never be executed, even by the operator.
const BLOCKED_PATTERNS = [
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*(\/|~\/?\s|\/\*)/, label: 'recursive delete of root/home' },
  { pattern: /:\(\)\s*\{[^}]*\}/, label: 'fork bomb' },
  { pattern: /dd\s+if=.*of=\/dev\//, label: 'raw disk write' },
  { pattern: /mkfs\./, label: 'filesystem format' },
  { pattern: />\s*\/dev\/sd/, label: 'raw device overwrite' },
  { pattern: /chmod\s+(-[a-zA-Z]+\s+)*777\s+\/($|\s)/, label: 'chmod 777 /' },
  { pattern: /wget\s[^|]*\|\s*(ba)?sh/, label: 'download and execute (wget)' },
  { pattern: /curl\s[^|]*\|\s*(ba)?sh/, label: 'download and execute (curl)' },
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/, label: 'system shutdown/reboot' },
  { pattern: /\bkill\s+-9\s+1\b/, label: 'kill init process' },
  { pattern: />\s*\/etc\/passwd/, label: 'overwrite passwd' },
  { pattern: />\s*\/etc\/shadow/, label: 'overwrite shadow' },
  { pattern: /\biptables\s+-F\b/, label: 'flush firewall rules' },
];

// ─── ENV FILTER ───
// Patterns for environment variable names that should be stripped from child processes
const SECRET_PATTERNS = [/key/i, /secret/i, /token/i, /password/i, /credential/i, /auth/i];

function filterEnv(env) {
  const filtered = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_PATTERNS.some(p => p.test(key))) continue;
    filtered[key] = value;
  }
  // Always keep PATH and basic system vars
  if (env.PATH) filtered.PATH = env.PATH;
  if (env.HOME) filtered.HOME = env.HOME;
  if (env.USER) filtered.USER = env.USER;
  if (env.LANG) filtered.LANG = env.LANG;
  if (env.TERM) filtered.TERM = env.TERM;
  return filtered;
}

// ─── LOAD CONFIG ───
function loadConfig() {
  try {
    const configPath = path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.sandbox || {};
    }
  } catch {}
  return {};
}

/**
 * Execute a command with safety checks.
 * @param {string} command - Shell command to execute
 * @param {object} options - Execution options
 * @param {number} options.timeout - Timeout in ms (default: 30000)
 * @param {number} options.maxBuffer - Max output buffer (default: 10MB)
 * @param {string} options.cwd - Working directory (default: /tmp)
 * @param {boolean} options.filterEnv - Strip secret env vars (default: true)
 * @returns {{ ok: boolean, output?: string, error?: string }}
 */
function safExec(command, options = {}) {
  const sandboxConfig = loadConfig();

  // Check if sandbox is disabled
  if (sandboxConfig.enabled === false) {
    try {
      const output = execSync(command, {
        timeout: options.timeout || 30000,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
        cwd: options.cwd || '/tmp',
      });
      return { ok: true, output };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 1. Check custom blocklist from config
  const customBlocked = sandboxConfig.blockedCommands || [];
  for (const blocked of customBlocked) {
    if (command.includes(blocked)) {
      return { ok: false, error: `Blocked by custom rule: "${blocked}"` };
    }
  }

  // 2. Check built-in blocked patterns
  for (const { pattern, label } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { ok: false, error: `Blocked: ${label}` };
    }
  }

  // 3. Execute with safety constraints
  try {
    const timeout = Math.min(
      options.timeout || 30000,
      sandboxConfig.maxTimeout || 30000
    );
    const maxBuffer = Math.min(
      options.maxBuffer || 10 * 1024 * 1024,
      sandboxConfig.maxBuffer || 10 * 1024 * 1024
    );

    const execOptions = {
      timeout,
      maxBuffer,
      encoding: 'utf8',
      cwd: options.cwd || '/tmp',
    };

    // Filter environment if requested (default: true)
    if (options.filterEnv !== false) {
      execOptions.env = filterEnv(process.env);
    }

    const output = execSync(command, execOptions);
    return { ok: true, output };
  } catch (e) {
    if (e.killed) {
      return { ok: false, error: `Timed out after ${options.timeout || 30000}ms` };
    }
    // Still return output if command exited non-zero but produced output
    if (e.stdout || e.stderr) {
      return { ok: false, error: e.message, output: (e.stdout || e.stderr || '').toString() };
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { safExec, BLOCKED_PATTERNS, filterEnv };
