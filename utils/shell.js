// utils/shell.js — Safe shell execution helpers
// Prevents command injection by using execFile with argument arrays
// and proper input escaping.

const { execFile, execFileSync } = require('child_process');

/**
 * Escape a string for safe inclusion in a PowerShell command.
 * Wraps in single quotes and escapes embedded single quotes.
 */
function psSafeString(str) {
  return "'" + String(str).replace(/'/g, "''") + "'";
}

/**
 * Encode a PowerShell command as base64 for -EncodedCommand.
 * This avoids ALL shell escaping issues — the command is never parsed by any shell.
 */
function psEncodedCommand(psCode) {
  return Buffer.from(psCode, 'utf16le').toString('base64');
}

/**
 * Execute a command on a remote machine via SSH using execFile (no shell interpolation).
 * @param {{ user: string, host: string, port: number, connectTimeout: number, execTimeout: number }} sshConfig
 * @param {string} remoteCommand - Command to run on the remote machine
 * @param {{ stdin?: string, timeout?: number }} opts
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
function sshExec(sshConfig, remoteCommand, opts = {}) {
  return new Promise((resolve) => {
    const args = [
      '-o', `ConnectTimeout=${Math.floor((sshConfig.connectTimeout || 5000) / 1000)}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(sshConfig.port || 22),
      `${sshConfig.user}@${sshConfig.host}`,
      remoteCommand,
    ];
    const execOpts = { timeout: opts.timeout || sshConfig.execTimeout || 15000 };
    if (opts.stdin != null) execOpts.input = opts.stdin;
    execFile('ssh', args, execOpts, (err, stdout, stderr) => {
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (err) {
        if (err.message.includes('Connection refused') || err.message.includes('timed out'))
          resolve({ ok: false, output: 'Laptop is not connected.' });
        else resolve({ ok: false, output: combined || err.message });
      } else resolve({ ok: true, output: combined || '(no output)' });
    });
  });
}

/**
 * Synchronous SSH execution using execFileSync (no shell interpolation).
 * @param {{ user: string, host: string, port: number, connectTimeout: number }} sshConfig
 * @param {string} remoteCommand - Command to run on the remote machine
 * @param {{ timeout?: number }} opts
 * @returns {string} stdout
 */
function sshExecSync(sshConfig, remoteCommand, opts = {}) {
  const args = [
    '-o', `ConnectTimeout=${Math.floor((sshConfig.connectTimeout || 5000) / 1000)}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(sshConfig.port || 22),
    `${sshConfig.user}@${sshConfig.host}`,
    remoteCommand,
  ];
  return execFileSync('ssh', args, {
    timeout: opts.timeout || 15000,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Build a safe PowerShell command that uses -EncodedCommand to avoid injection.
 * @param {string} psCode - Raw PowerShell code
 * @returns {string} Full powershell invocation string
 */
function safePowerShell(psCode) {
  return `powershell -NoProfile -EncodedCommand ${psEncodedCommand(psCode)}`;
}

/**
 * Execute an ADB command using execFileSync (no shell interpolation).
 * @param {string} adbBinary - Path to adb binary
 * @param {string} target - device target (host:port)
 * @param {string[]} adbArgs - Arguments to pass to adb
 * @param {{ timeout?: number }} opts
 * @returns {string} stdout
 */
function adbExecSync(adbBinary, target, adbArgs, opts = {}) {
  const args = ['-s', target, ...adbArgs];
  return execFileSync(adbBinary, args, {
    timeout: opts.timeout || 15000,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

module.exports = {
  psSafeString,
  psEncodedCommand,
  safePowerShell,
  sshExec,
  sshExecSync,
  adbExecSync,
};
