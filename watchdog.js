/**
 * watchdog.js — Health, Security & Self-Healing Monitor for Favor WhatsApp Bot
 *
 * Monitors the favor-whatsapp pm2 process, WhatsApp connection health,
 * SQLite database integrity, credential file safety, and security threats.
 *
 * Uses ONLY Node.js built-in modules + child_process. No external deps.
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');

// ── Configuration ──────────────────────────────────────────────────────────────

const BOT_DIR = path.resolve(__dirname);
const CONFIG = {
  botDir: BOT_DIR,
  pm2Name: 'favor-whatsapp',
  pm2Id: 9,
  botFile: path.join(BOT_DIR, 'favor.js'),
  dbPath: path.join(BOT_DIR, 'data', 'favor.db'),
  configPath: path.join(BOT_DIR, 'config.json'),
  credsDir: path.join(BOT_DIR, 'auth-state'),
  credsFile: path.join(BOT_DIR, 'auth-state', 'creds.json'),
  credsBackup1: path.join(BOT_DIR, 'auth-state', 'creds.json.bak2'),
  credsBackup2: path.join(BOT_DIR, 'auth-state', 'creds.json.bak'),
  reportsDir: path.join(BOT_DIR, 'watchdog-reports'),
  notifyUrl: 'http://localhost:3099/notify',
  operatorJid: '', // Set from config.whatsapp.operatorNumber

  // Intervals (ms)
  healthInterval: 3 * 60 * 1000,       // 3 minutes
  securityInterval: 5 * 60 * 1000,     // 5 minutes
  selfImproveInterval: 6 * 60 * 60 * 1000, // 6 hours

  // Thresholds
  restartThreshold5m: 5,     // max restarts in 10 min before alert
  restartStormThreshold: 10, // max restarts before kill+wait+restart
  diskCriticalPct: 90,       // disk usage % to trigger cleanup
  memWarnMb: 512,            // memory usage warning threshold (MB)

  // Alert cooldowns — critical alerts fire ONCE per process lifetime
  alertCooldown: 3600000, // 1 hour cooldown between repeated alerts

  // Known files that should exist in the bot directory (top-level)
  knownFiles: new Set([
    'CLAUDE.md', 'bot.js', 'bot.js.backup', 'bot.js.old', 'browser.js',
    'compactor.js', 'config.example.json', 'config.json', 'cron.js',
    'data', 'db.js', 'deploy.sh', 'favor.js', 'favor.service',
    'knowledge', 'memory.json', 'migrate.js', 'node_modules',
    'package-lock.json', 'package.json', 'router.js', 'vault.js',
    'video.js', 'watchdog.js', 'watchdog-reports', '.git', '.gitignore',
    '.env', 'config.json.bak', 'tmp'
  ]),

  // Prompt injection patterns
  injectionPatterns: [
    /ignore\s+(all\s+)?previous/i,
    /ignore\s+(all\s+)?prior/i,
    /forget\s+(all\s+)?previous/i,
    /forget\s+(your|all)\s+instructions/i,
    /new\s+rules?\s*:/i,
    /system\s+prompt/i,
    /you\s+are\s+now\s+/i,
    /act\s+as\s+if\s+/i,
    /pretend\s+(you('re|\s+are))\s+/i,
    /disregard\s+(all|your|the)/i,
    /override\s+(your|all|the)\s+(instructions|rules|prompt)/i,
    /reveal\s+(your|the)\s+(system|instructions|prompt|rules)/i,
    /jailbreak/i,
    /DAN\s+mode/i,
    /developer\s+mode/i,
  ],
};

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
  configHash: null,          // SHA-256 of config.json at startup
  lastAlerts: new Map(),     // alertType -> timestamp (cooldown tracking)
  restartTimestamps: [],     // recent restart timestamps for storm detection
  knownFileSnapshot: null,   // Set of filenames at startup
  startTime: Date.now(),
  healthChecks: 0,
  securityChecks: 0,
  alertsSent: 0,
  autoFixes: 0,
  logBuffer: [],             // buffer recent log entries for self-improvement analysis
};

// ── Logging ────────────────────────────────────────────────────────────────────

function log(level, component, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [WATCHDOG] [${level}] [${component}] ${message}`;
  console.log(line);
  // Keep last 500 log lines for self-improvement analysis
  state.logBuffer.push(line);
  if (state.logBuffer.length > 500) state.logBuffer.shift();
}

function info(component, msg) { log('INFO', component, msg); }
function warn(component, msg) { log('WARN', component, msg); }
function error(component, msg) { log('ERROR', component, msg); }

// ── Utilities ──────────────────────────────────────────────────────────────────

function shell(cmd, timeoutMs = 10000) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
}

function fileHash(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return -1;
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    info('UTIL', `Created directory: ${dirPath}`);
  }
}

// ── Alerting ───────────────────────────────────────────────────────────────────

function canAlert(alertType) {
  const last = state.lastAlerts.get(alertType) || 0;
  return (Date.now() - last) > CONFIG.alertCooldown;
}

function markAlerted(alertType) {
  state.lastAlerts.set(alertType, Date.now());
}

// ONLY alert the operator for things that CANNOT be auto-fixed or are security threats.
// Everything else is handled silently (auto-fix, auto-restart, or log-only).
const CRITICAL_ALERTS = new Set([
  'creds_unrecoverable',   // creds broken, all backups failed — needs manual re-auth
  'db_corrupt',            // database corruption — needs manual recovery
  'prompt_injection',      // someone trying to hack the bot
  'brute_force',           // unusually high SSH attacks (beyond fail2ban)
]);

function sendAlert(alertType, message) {
  if (!canAlert(alertType)) {
    info('ALERT', `Suppressed (cooldown): [${alertType}] ${message}`);
    return;
  }

  markAlerted(alertType);
  state.alertsSent++;

  // Only send to WhatsApp for critical alerts — everything else is log-only
  if (!CRITICAL_ALERTS.has(alertType)) {
    info('ALERT', `[SILENT] [${alertType}] ${message}`);
    return;
  }

  const tz = (() => { try { return JSON.parse(fs.readFileSync(CONFIG.configPath, 'utf8')).alive?.timezone || 'America/New_York'; } catch { return 'America/New_York'; } })();
  const fullMsg = `🛡️ WATCHDOG [${alertType}]\n${message}\n\n⏰ ${new Date().toLocaleString('en-US', { timeZone: tz })}`;

  info('ALERT', `Sending: [${alertType}] ${message}`);

  const payload = JSON.stringify({
    contact: CONFIG.operatorJid,
    message: fullMsg,
  });

  const url = new URL(CONFIG.notifyUrl);
  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 5000,
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      if (res.statusCode === 200) {
        info('ALERT', `Delivered: [${alertType}]`);
      } else {
        warn('ALERT', `Notify API returned ${res.statusCode}: ${body}`);
      }
    });
  });

  req.on('error', (err) => {
    warn('ALERT', `Failed to send alert (notify API down?): ${err.message}`);
  });

  req.write(payload);
  req.end();
}

// ── PM2 Helpers ────────────────────────────────────────────────────────────────

function getPm2Info() {
  const raw = shell(`pm2 jlist 2>/dev/null`);
  if (!raw) return null;

  try {
    const list = JSON.parse(raw);
    return list.find(p => p.name === CONFIG.pm2Name || p.pm_id === CONFIG.pm2Id) || null;
  } catch {
    return null;
  }
}

function getPm2Logs(lines = 100) {
  return shell(`pm2 logs ${CONFIG.pm2Name} --nostream --lines ${lines} 2>/dev/null`, 15000) || '';
}

function restartBot() {
  info('AUTOFIX', 'Restarting favor-whatsapp via pm2...');
  shell(`pm2 restart ${CONFIG.pm2Name} 2>/dev/null`);
  state.autoFixes++;
}

function stopBot() {
  info('AUTOFIX', 'Stopping favor-whatsapp via pm2...');
  shell(`pm2 stop ${CONFIG.pm2Name} 2>/dev/null`);
}

function startBot() {
  info('AUTOFIX', 'Starting favor-whatsapp via pm2...');
  shell(`pm2 start ${CONFIG.pm2Name} 2>/dev/null`);
  state.autoFixes++;
}

// ── Health Monitoring ──────────────────────────────────────────────────────────

function checkHealth() {
  state.healthChecks++;
  info('HEALTH', `--- Health check #${state.healthChecks} ---`);

  // 1. Process status
  const pm2 = getPm2Info();
  if (!pm2) {
    error('HEALTH', 'Cannot get pm2 process info — pm2 may be down');
    sendAlert('pm2_down', 'Cannot read pm2 process list. Is pm2 running?');
    return;
  }

  const status = pm2.pm2_env?.status;
  const restarts = pm2.pm2_env?.restart_time || 0;
  const uptime = pm2.pm2_env?.pm_uptime || 0;
  const memBytes = pm2.monit?.memory || 0;
  const memMb = Math.round(memBytes / 1024 / 1024);
  const cpu = pm2.monit?.cpu || 0;

  info('HEALTH', `Status: ${status} | Restarts: ${restarts} | Mem: ${memMb}MB | CPU: ${cpu}% | Uptime: ${Math.round((Date.now() - uptime) / 1000)}s`);

  // Check if process is running
  if (status !== 'online') {
    error('HEALTH', `Bot is NOT online — status: ${status}`);
    sendAlert('bot_offline', `Bot status is "${status}" (not online). Attempting restart...`);
    restartBot();
  }

  // 2. Restart storm detection
  state.restartTimestamps.push({ time: Date.now(), count: restarts });
  // Keep only last 10 minutes of data
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  state.restartTimestamps = state.restartTimestamps.filter(r => r.time > tenMinAgo);

  if (state.restartTimestamps.length >= 2) {
    const oldest = state.restartTimestamps[0];
    const newest = state.restartTimestamps[state.restartTimestamps.length - 1];
    const restartsInWindow = newest.count - oldest.count;

    if (restartsInWindow >= CONFIG.restartStormThreshold) {
      error('HEALTH', `RESTART STORM: ${restartsInWindow} restarts in 10 min — entering recovery mode`);
      sendAlert('restart_storm', `Restart storm detected: ${restartsInWindow} restarts in 10 min.\nStopping bot, restoring creds, waiting 90s, then restarting.`);
      handleRestartStorm();
      return;
    }

    if (restartsInWindow >= CONFIG.restartThreshold5m) {
      warn('HEALTH', `High restart rate: ${restartsInWindow} restarts in 10 min`);
      sendAlert('restart_high', `Bot has restarted ${restartsInWindow} times in the last 10 minutes. Investigate logs.`);
    }
  }

  // 3. WhatsApp connection — check pm2 logs for disconnect/440 errors
  const logs = getPm2Logs(50);
  if (logs) {
    const recentLines = logs.split('\n').slice(-50);
    const disconnects = recentLines.filter(l =>
      /disconnect/i.test(l) || /440/i.test(l) || /connection\s+closed/i.test(l)
    );
    if (disconnects.length > 3) {
      warn('HEALTH', `Found ${disconnects.length} disconnect indicators in recent logs`);
      sendAlert('wa_disconnect', `${disconnects.length} disconnect/440 errors found in recent pm2 logs.\nLast: ${disconnects[disconnects.length - 1].substring(0, 200)}`);
    }
  }

  // 4. Check message activity (look for timestamps in logs indicating messages)
  if (logs) {
    const msgLines = logs.split('\n').filter(l =>
      /\[FAVOR\]/.test(l) || /incoming|outgoing|received|sent|handling/i.test(l)
    );
    if (msgLines.length === 0) {
      info('HEALTH', 'No recent message activity found in logs (may be normal during quiet hours)');
    } else {
      info('HEALTH', `Found ${msgLines.length} message-related log lines`);
    }
  }

  // 5. Memory usage
  if (memMb > CONFIG.memWarnMb) {
    warn('HEALTH', `High memory usage: ${memMb}MB (threshold: ${CONFIG.memWarnMb}MB)`);
    sendAlert('high_memory', `Bot memory usage is ${memMb}MB (threshold: ${CONFIG.memWarnMb}MB). Consider restarting.`);
  }

  // 6. Disk space
  checkDiskSpace();

  // 7. SQLite database
  checkDatabase();

  info('HEALTH', '--- Health check complete ---');
}

function checkDiskSpace() {
  const dfOutput = shell('df -h / | tail -1');
  if (!dfOutput) return;

  const parts = dfOutput.split(/\s+/);
  const usePct = parseInt(parts[4]) || 0;
  const avail = parts[3] || '?';

  info('HEALTH', `Disk: ${usePct}% used, ${avail} available`);

  if (usePct >= CONFIG.diskCriticalPct) {
    warn('HEALTH', `Disk usage critical: ${usePct}%`);
    sendAlert('disk_critical', `Disk usage is ${usePct}% — cleaning up old files...`);
    cleanupDisk();
  }
}

function cleanupDisk() {
  info('AUTOFIX', 'Running disk cleanup...');

  // Clean pm2 logs older than 7 days
  shell('find /root/.pm2/logs -name "*.log" -mtime +7 -delete 2>/dev/null');

  // Clean /tmp files older than 3 days
  shell('find /tmp -type f -mtime +3 -delete 2>/dev/null');

  // Truncate large pm2 log files to last 1000 lines
  const logDir = '/root/.pm2/logs';
  try {
    const logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
    for (const lf of logFiles) {
      const fp = path.join(logDir, lf);
      const size = fileSize(fp);
      if (size > 50 * 1024 * 1024) { // > 50MB
        info('AUTOFIX', `Truncating large log: ${lf} (${Math.round(size / 1024 / 1024)}MB)`);
        shell(`tail -1000 "${fp}" > "${fp}.tmp" && mv "${fp}.tmp" "${fp}"`);
      }
    }
  } catch (e) {
    warn('AUTOFIX', `Log cleanup error: ${e.message}`);
  }

  state.autoFixes++;
  info('AUTOFIX', 'Disk cleanup complete');
}

function checkDatabase() {
  // Use better-sqlite3 (already a dependency) instead of sqlite3 CLI
  let result;
  try {
    const Database = require('better-sqlite3');
    const testDb = new Database(CONFIG.dbPath, { readonly: true });
    result = String(testDb.prepare('SELECT COUNT(*) AS cnt FROM memories').get().cnt);
    testDb.close();
  } catch (e) {
    result = null;
  }

  if (result === null) {
    error('HEALTH', 'sqlite3 command failed — database may be inaccessible');
    sendAlert('db_error', 'Cannot query SQLite database. sqlite3 command failed.');
    return;
  }

  if (/locked/i.test(result)) {
    warn('HEALTH', 'Database is locked');
    sendAlert('db_locked', 'SQLite database is locked. Attempting to clear stale connections.');
    fixLockedDb();
    return;
  }

  if (/corrupt/i.test(result) || /malformed/i.test(result)) {
    error('HEALTH', `Database corruption detected: ${result}`);
    sendAlert('db_corrupt', `Database corruption detected!\n${result}`);
    return;
  }

  const count = parseInt(result);
  if (!isNaN(count)) {
    info('HEALTH', `Database OK — ${count} memories`);
  } else {
    warn('HEALTH', `Unexpected DB query result: ${result}`);
  }

  // Quick integrity check using better-sqlite3
  try {
    const Database = require('better-sqlite3');
    const testDb = new Database(CONFIG.dbPath, { readonly: true });
    const integrity = testDb.pragma('integrity_check')[0]?.integrity_check;
    testDb.close();
    if (integrity && integrity !== 'ok') {
      error('HEALTH', `DB integrity check failed: ${(integrity + '').substring(0, 200)}`);
      sendAlert('db_integrity', `Database integrity check returned: ${(integrity + '').substring(0, 200)}`);
    }
  } catch (e) {
    error('HEALTH', `DB integrity check error: ${e.message}`);
  }
}

function fixLockedDb() {
  info('AUTOFIX', 'Attempting to clear locked database...');

  // Find processes holding the DB open (other than the bot itself)
  const lsof = shell(`lsof "${CONFIG.dbPath}" 2>/dev/null`);
  if (lsof) {
    const lines = lsof.split('\n').slice(1); // skip header
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const pid = parts[1];
      const cmd = parts[0];
      // Don't kill the bot or watchdog itself
      if (pid && cmd !== 'node' && parseInt(pid) !== process.pid) {
        info('AUTOFIX', `Killing stale DB connection: PID ${pid} (${cmd})`);
        shell(`kill ${pid} 2>/dev/null`);
      }
    }
  }

  // Force WAL checkpoint using better-sqlite3
  try {
    const Database = require('better-sqlite3');
    const walDb = new Database(CONFIG.dbPath);
    walDb.pragma('wal_checkpoint(TRUNCATE)');
    walDb.close();
  } catch (e) {
    warn('AUTOFIX', `WAL checkpoint failed: ${e.message}`);
  }
  state.autoFixes++;
  info('AUTOFIX', 'Database lock fix attempted');
}

// ── Security Monitoring ────────────────────────────────────────────────────────

function checkSecurity() {
  state.securityChecks++;
  info('SECURITY', `--- Security check #${state.securityChecks} ---`);

  checkPromptInjection();
  checkConfigIntegrity();
  checkNewFiles();
  checkCredentials();
  checkUnauthorizedAccess();

  info('SECURITY', '--- Security check complete ---');
}

function checkPromptInjection() {
  const logs = getPm2Logs(200);
  if (!logs) return;

  const matches = [];
  const lines = logs.split('\n');

  for (const line of lines) {
    for (const pattern of CONFIG.injectionPatterns) {
      if (pattern.test(line)) {
        matches.push({
          pattern: pattern.toString(),
          line: line.substring(0, 300),
        });
        break; // one match per line is enough
      }
    }
  }

  if (matches.length > 0) {
    warn('SECURITY', `Found ${matches.length} potential prompt injection attempts`);
    const summary = matches.slice(0, 5).map(m => `  Pattern: ${m.pattern}\n  Line: ${m.line}`).join('\n---\n');
    sendAlert('prompt_injection', `Detected ${matches.length} potential prompt injection attempts in recent logs:\n\n${summary}`);
  } else {
    info('SECURITY', 'No prompt injection patterns found in recent logs');
  }
}

function checkConfigIntegrity() {
  const currentHash = fileHash(CONFIG.configPath);

  if (!currentHash) {
    error('SECURITY', 'Cannot read config.json — file missing or unreadable');
    sendAlert('config_missing', 'config.json is missing or unreadable!');
    return;
  }

  if (state.configHash === null) {
    // First run — record baseline
    state.configHash = currentHash;
    info('SECURITY', `Config hash baseline recorded: ${currentHash.substring(0, 16)}...`);
    return;
  }

  if (currentHash !== state.configHash) {
    warn('SECURITY', 'config.json has been modified since watchdog started');
    sendAlert('config_changed', `config.json was modified unexpectedly.\nOld hash: ${state.configHash.substring(0, 16)}...\nNew hash: ${currentHash.substring(0, 16)}...\n\nIf this was intentional (reload/edit), this alert is safe to ignore.`);
    state.configHash = currentHash; // update baseline to avoid repeat alerts
  } else {
    info('SECURITY', 'config.json integrity OK');
  }
}

function checkNewFiles() {
  try {
    const entries = fs.readdirSync(CONFIG.botDir);
    const unknowns = entries.filter(f => !CONFIG.knownFiles.has(f));

    if (state.knownFileSnapshot === null) {
      // First run — snapshot current state including any unknowns
      state.knownFileSnapshot = new Set(entries);
      if (unknowns.length > 0) {
        info('SECURITY', `Note: ${unknowns.length} unrecognized files at startup: ${unknowns.join(', ')}`);
      }
      return;
    }

    // Check for NEW files that weren't there before
    const newFiles = entries.filter(f => !state.knownFileSnapshot.has(f));
    if (newFiles.length > 0) {
      warn('SECURITY', `New files detected in bot directory: ${newFiles.join(', ')}`);
      sendAlert('new_files', `New files appeared in ${CONFIG.botDir}:\n${newFiles.join('\n')}\n\nVerify these are expected.`);
      // Update snapshot
      for (const f of newFiles) state.knownFileSnapshot.add(f);
    } else {
      info('SECURITY', 'No new files in bot directory');
    }
  } catch (e) {
    error('SECURITY', `File check error: ${e.message}`);
  }
}

function checkCredentials() {
  const credsSize = fileSize(CONFIG.credsFile);

  if (credsSize === -1) {
    error('SECURITY', 'creds.json does not exist!');
    sendAlert('creds_missing', 'creds.json is MISSING. Attempting restore from backup...');
    restoreCredentials();
    return;
  }

  if (credsSize === 0) {
    error('SECURITY', 'creds.json is 0 bytes — KNOWN BUG TRIGGERED');
    sendAlert('creds_zeroed', 'creds.json has been wiped to 0 bytes (recurring bug). Auto-restoring from backup...');
    restoreCredentials();
    return;
  }

  // Basic JSON validity check
  try {
    const content = fs.readFileSync(CONFIG.credsFile, 'utf8');
    JSON.parse(content);
    info('SECURITY', `creds.json OK (${credsSize} bytes, valid JSON)`);
  } catch (e) {
    error('SECURITY', `creds.json is corrupted (not valid JSON): ${e.message}`);
    sendAlert('creds_corrupt', `creds.json exists (${credsSize} bytes) but is not valid JSON. Restoring from backup...`);
    restoreCredentials();
  }
}

function restoreCredentials() {
  info('AUTOFIX', 'Attempting credential restore...');

  // Try bak2 first (usually more recent), then bak
  const backups = [CONFIG.credsBackup1, CONFIG.credsBackup2];

  for (const backup of backups) {
    const size = fileSize(backup);
    if (size > 0) {
      try {
        const content = fs.readFileSync(backup, 'utf8');
        JSON.parse(content); // validate JSON
        fs.copyFileSync(backup, CONFIG.credsFile);
        info('AUTOFIX', `Restored creds.json from ${path.basename(backup)} (${size} bytes)`);
        state.autoFixes++;

        // Wait 60 seconds then restart bot
        info('AUTOFIX', 'Waiting 60 seconds before restarting bot...');
        setTimeout(() => {
          restartBot();
          info('AUTOFIX', 'Bot restarted after credential restore');
        }, 60 * 1000);

        return;
      } catch (e) {
        warn('AUTOFIX', `Backup ${path.basename(backup)} is not valid JSON, trying next...`);
      }
    } else {
      warn('AUTOFIX', `Backup ${path.basename(backup)} is missing or empty`);
    }
  }

  error('AUTOFIX', 'ALL credential backups are unusable! Manual intervention required.');
  sendAlert('creds_unrecoverable', 'CRITICAL: creds.json is broken and ALL backups are unusable.\nManual re-authentication required. Bot will not connect to WhatsApp.');
}

function handleRestartStorm() {
  info('AUTOFIX', 'Handling restart storm — stop, restore creds, wait 90s, restart');

  stopBot();

  // Restore creds as a precaution (0-byte creds is the most common cause)
  const credsSize = fileSize(CONFIG.credsFile);
  if (credsSize <= 0) {
    info('AUTOFIX', 'creds.json is empty/missing — restoring as part of storm recovery');
    restoreCredentials();
    // restoreCredentials already schedules a restart after 60s; extend to 90s
    return;
  }

  // If creds are fine, just wait 90s and restart
  info('AUTOFIX', 'Creds appear intact. Waiting 90 seconds before restart...');
  setTimeout(() => {
    startBot();
    info('AUTOFIX', 'Bot restarted after restart storm recovery');
  }, 90 * 1000);

  state.autoFixes++;
}

function checkUnauthorizedAccess() {
  // Check for failed SSH attempts in the last check period
  const authLog = shell('tail -100 /var/log/auth.log 2>/dev/null || tail -100 /var/log/secure 2>/dev/null');

  if (!authLog) {
    info('SECURITY', 'Cannot read auth logs (may need elevated permissions)');
    return;
  }

  const failedLines = authLog.split('\n').filter(l =>
    /failed\s+password/i.test(l) || /invalid\s+user/i.test(l) || /authentication\s+failure/i.test(l)
  );

  // Only alert on unusually high spikes — fail2ban handles normal brute force
  if (failedLines.length > 80) {
    warn('SECURITY', `${failedLines.length} failed auth attempts in recent auth.log`);
    const ips = new Set();
    for (const line of failedLines) {
      const ipMatch = line.match(/from\s+(\d+\.\d+\.\d+\.\d+)/);
      if (ipMatch) ips.add(ipMatch[1]);
    }
    sendAlert('brute_force', `${failedLines.length} failed login attempts detected.\nSource IPs: ${[...ips].join(', ')}`);
  } else {
    info('SECURITY', `Auth log OK (${failedLines.length} failures — within normal range)`);
  }
}

// ── Self-Improvement ───────────────────────────────────────────────────────────

function selfImprove() {
  info('IMPROVE', '--- Self-improvement analysis starting ---');

  ensureDir(CONFIG.reportsDir);

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const reportPath = path.join(CONFIG.reportsDir, `${dateStr}.md`);

  // Gather data
  const logs = getPm2Logs(500);
  const logLines = logs ? logs.split('\n') : [];

  // Analyze patterns
  const errorCounts = {};
  const warnCounts = {};
  const restartCount = logLines.filter(l => /restart/i.test(l)).length;
  const disconnectCount = logLines.filter(l => /disconnect/i.test(l) || /440/.test(l)).length;
  const apiErrors = logLines.filter(l => /api.*error|error.*api|rate.limit|429|500|503/i.test(l));
  const timeouts = logLines.filter(l => /timeout|timed?\s*out/i.test(l));

  // Categorize errors
  for (const line of logLines) {
    if (/error/i.test(line)) {
      const key = line.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '<TS>')
                       .replace(/\d+/g, '<N>')
                       .substring(0, 100);
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
  }

  // Get top errors
  const topErrors = Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Build report
  const report = [
    `# Watchdog Report — ${dateStr}`,
    '',
    `**Generated:** ${now.toISOString()}`,
    `**Uptime:** ${Math.round((Date.now() - state.startTime) / 3600000)}h`,
    `**Health checks:** ${state.healthChecks}`,
    `**Security checks:** ${state.securityChecks}`,
    `**Alerts sent:** ${state.alertsSent}`,
    `**Auto-fixes applied:** ${state.autoFixes}`,
    '',
    '## Log Analysis (last ~500 lines)',
    '',
    `- **Total lines analyzed:** ${logLines.length}`,
    `- **Restart indicators:** ${restartCount}`,
    `- **Disconnect events:** ${disconnectCount}`,
    `- **API errors:** ${apiErrors.length}`,
    `- **Timeouts:** ${timeouts.length}`,
    '',
  ];

  if (topErrors.length > 0) {
    report.push('## Top Recurring Errors', '');
    for (const [pattern, count] of topErrors) {
      report.push(`- **${count}x** — \`${pattern}\``);
    }
    report.push('');
  }

  // Recommendations
  report.push('## Recommendations', '');

  if (disconnectCount > 5) {
    report.push('- High disconnect rate — investigate WhatsApp session stability');
  }
  if (apiErrors.length > 10) {
    report.push('- Frequent API errors — check rate limits and API key validity');
  }
  if (timeouts.length > 5) {
    report.push('- Multiple timeouts — check network connectivity and API response times');
  }
  if (state.autoFixes > 3) {
    report.push('- Multiple auto-fixes triggered — root cause investigation recommended');
  }
  if (topErrors.length === 0 && disconnectCount <= 2 && apiErrors.length <= 2) {
    report.push('- System is running healthy. No issues detected.');
  }

  report.push('');

  // Write or append to report
  const reportContent = report.join('\n');
  try {
    if (fs.existsSync(reportPath)) {
      // Append a new section for this analysis period
      fs.appendFileSync(reportPath, '\n---\n\n' + reportContent);
    } else {
      fs.writeFileSync(reportPath, reportContent);
    }
    info('IMPROVE', `Report written to ${reportPath}`);
  } catch (e) {
    error('IMPROVE', `Failed to write report: ${e.message}`);
  }

  // Send daily summary via notify (once per day, using alertCooldown on 'daily_summary')
  const summaryMsg = [
    `📊 DAILY WATCHDOG SUMMARY`,
    `Uptime: ${Math.round((Date.now() - state.startTime) / 3600000)}h`,
    `Health checks: ${state.healthChecks}`,
    `Security checks: ${state.securityChecks}`,
    `Alerts: ${state.alertsSent}`,
    `Auto-fixes: ${state.autoFixes}`,
    `Disconnects: ${disconnectCount}`,
    `API errors: ${apiErrors.length}`,
    disconnectCount <= 2 && apiErrors.length <= 2 ? `\nStatus: All systems nominal.` : `\nStatus: Issues detected — check report.`,
  ].join('\n');

  // Use a 23-hour cooldown for daily summary to avoid duplicate sends
  const dailyKey = 'daily_summary';
  const lastDaily = state.lastAlerts.get(dailyKey) || 0;
  if (Date.now() - lastDaily > 23 * 60 * 60 * 1000) {
    state.lastAlerts.set(dailyKey, Date.now());
    sendAlert(dailyKey, summaryMsg);
  }

  info('IMPROVE', '--- Self-improvement analysis complete ---');
}

// ── Main Loop ──────────────────────────────────────────────────────────────────

function init() {
  console.log('========================================');
  console.log(' WATCHDOG — Favor Security Guard');
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`  PID: ${process.pid}`);
  console.log('========================================');

  // Ensure reports directory exists
  ensureDir(CONFIG.reportsDir);

  // Record initial config hash
  state.configHash = fileHash(CONFIG.configPath);
  info('INIT', `Config hash: ${state.configHash ? state.configHash.substring(0, 16) + '...' : 'UNAVAILABLE'}`);

  // Record initial file snapshot
  try {
    state.knownFileSnapshot = new Set(fs.readdirSync(CONFIG.botDir));
    info('INIT', `File snapshot: ${state.knownFileSnapshot.size} entries`);
  } catch (e) {
    error('INIT', `Cannot read bot directory: ${e.message}`);
  }

  // Run initial checks immediately
  info('INIT', 'Running initial health check...');
  checkHealth();

  info('INIT', 'Running initial security check...');
  checkSecurity();

  // Schedule recurring checks
  setInterval(() => {
    try {
      checkHealth();
    } catch (e) {
      error('HEALTH', `Uncaught error in health check: ${e.message}`);
    }
  }, CONFIG.healthInterval);

  setInterval(() => {
    try {
      checkSecurity();
    } catch (e) {
      error('SECURITY', `Uncaught error in security check: ${e.message}`);
    }
  }, CONFIG.securityInterval);

  setInterval(() => {
    try {
      selfImprove();
    } catch (e) {
      error('IMPROVE', `Uncaught error in self-improvement: ${e.message}`);
    }
  }, CONFIG.selfImproveInterval);

  info('INIT', `Scheduled: health every ${CONFIG.healthInterval / 60000}m, security every ${CONFIG.securityInterval / 60000}m, self-improve every ${CONFIG.selfImproveInterval / 3600000}h`);
  info('INIT', 'Watchdog is active.');
}

// ── Graceful Shutdown ──────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  info('SHUTDOWN', 'Received SIGINT — shutting down watchdog');
  process.exit(0);
});

process.on('SIGTERM', () => {
  info('SHUTDOWN', 'Received SIGTERM — shutting down watchdog');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  error('FATAL', `Uncaught exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason) => {
  error('FATAL', `Unhandled rejection: ${reason}`);
});

// ── Start ──────────────────────────────────────────────────────────────────────

init();

// ── PM2 Ecosystem Config (for reference) ───────────────────────────────────────
//
// Add to ecosystem.config.js or start with:
//
//   pm2 start /path/to/favor/watchdog.js --name favor-watchdog --max-memory-restart 200M
//
// Full ecosystem entry:
//
// {
//   name: 'favor-watchdog',
//   script: '/path/to/favor/watchdog.js',
//   cwd: '/path/to/favor',
//   max_memory_restart: '200M',
//   autorestart: true,
//   watch: false,
//   env: {
//     NODE_ENV: 'production',
//   },
//   log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
//   error_file: '/root/.pm2/logs/favor-watchdog-error.log',
//   out_file: '/root/.pm2/logs/favor-watchdog-out.log',
//   merge_logs: true,
// }
//
