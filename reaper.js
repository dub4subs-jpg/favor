'use strict';

/**
 * Claude CLI Process Reaper
 * - Scans every 3 minutes for stale registered + orphan processes
 * - Kills with SIGTERM then SIGKILL after 10s
 * - Logs to state/reaper.log
 * - Notifies operator via POST localhost:3099/notify (max 1 per 5 min)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const registry = require('./process-registry');

const LOG_PATH = path.join(__dirname, 'state', 'reaper.log');
const SCAN_INTERVAL = 180000;    // 3 minutes
const GRACE_MS = 120000;         // 2 min grace beyond declared timeout
const ORPHAN_MAX_AGE = 600000;   // 10 minutes
const NOTIFY_COOLDOWN = 300000;  // 5 min between notifications
const SIGKILL_DELAY = 10000;     // 10s after SIGTERM

let _interval = null;
let _lastNotifyAt = 0;
let _stats = { scans: 0, kills: 0 };
let _notifyToken = '';

function log(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}\n`;
  try {
    fs.appendFileSync(LOG_PATH, entry);
  } catch (e) {
    console.error('[reaper] log write error:', e.message);
  }
}

function killProcess(pid, reason, meta = {}) {
  const { source = 'unknown', purpose = '', type = 'unknown', mem = '?' } = meta;
  try {
    process.kill(pid, 'SIGTERM');
    // Schedule SIGKILL if still alive
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }, SIGKILL_DELAY);
    _stats.kills++;
    const age = meta.ageStr || '?';
    log(`REAPED pid=${pid} age=${age} mem=${mem} reason="${reason}" purpose="${purpose}" type=${type} source=${source}`);
    return true;
  } catch (e) {
    if (e.code !== 'ESRCH') { // ESRCH = already dead
      log(`KILL_FAILED pid=${pid} error="${e.message}"`);
    }
    return false;
  }
}

function getProcessList() {
  try {
    const raw = execSync('ps -eo pid,ppid,rss,etimes,args --no-headers', {
      encoding: 'utf8', timeout: 5000,
    });
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      const rss = parseInt(parts[2]); // KB
      const etimes = parseInt(parts[3]); // seconds
      const args = parts.slice(4).join(' ');
      return { pid, ppid, rss, etimes, args };
    });
  } catch {
    return [];
  }
}

function formatAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function formatMem(rssKB) {
  if (rssKB > 1024) return `${Math.round(rssKB / 1024)}MB`;
  return `${rssKB}KB`;
}

function notify(message) {
  const now = Date.now();
  if (now - _lastNotifyAt < NOTIFY_COOLDOWN) return;
  _lastNotifyAt = now;
  try {
    const http = require('http');
    const data = JSON.stringify({ message, type: 'reaper' });
    const req = http.request({
      hostname: 'localhost', port: 3099, path: '/notify', method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._notifyToken ? { 'Authorization': `Bearer ${_notifyToken}` } : {} },
    });
    req.on('error', () => {}); // swallow
    req.write(data);
    req.end();
  } catch {}
}

function scan() {
  _stats.scans++;
  const killed = [];
  const now = Date.now();

  // Step 1: Check registered processes that exceeded their timeout + grace
  for (const entry of registry.getAll()) {
    const elapsed = now - entry.startedAt;
    const limit = entry.timeoutMs + GRACE_MS;
    if (elapsed > limit) {
      const success = killProcess(entry.pid, 'exceeded timeout+grace', {
        source: entry.source,
        purpose: entry.purpose,
        type: 'registered',
        ageStr: formatAge(elapsed),
        mem: '?',
      });
      if (success) killed.push(entry.pid);
    }
  }

  // Step 2: Find orphan claude processes not in registry
  const procs = getProcessList();
  const claudeProcs = procs.filter(p =>
    p.args.includes('claude') &&
    (p.args.includes('--print') || p.args.includes('-p ')) &&
    !p.args.includes('--remote-control') &&
    p.pid !== process.pid
  );

  for (const p of claudeProcs) {
    if (registry.has(p.pid)) continue; // tracked, handled in step 1
    const ageMs = p.etimes * 1000;
    if (ageMs > ORPHAN_MAX_AGE) {
      const success = killProcess(p.pid, 'orphan >' + formatAge(ORPHAN_MAX_AGE), {
        source: 'unknown',
        purpose: p.args.substring(0, 120),
        type: 'orphan',
        ageStr: formatAge(ageMs),
        mem: formatMem(p.rss),
      });
      if (success) killed.push(p.pid);
    }
  }

  if (killed.length > 0) {
    const msg = `🔪 Reaper killed ${killed.length} stale CLI process(es): PIDs ${killed.join(', ')}`;
    log(msg);
    notify(msg);
    console.log('[reaper]', msg);
  }

  return killed;
}

function start() {
  if (_interval) return;
  log('Reaper started');
  console.log('[reaper] Process reaper started (scan every 3m)');
  // First scan after 60s (let boot settle)
  setTimeout(() => {
    scan();
    _interval = setInterval(scan, SCAN_INTERVAL);
  }, 60000);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  log('Reaper stopped');
}

function killAll() {
  log('killAll invoked (shutdown)');
  const entries = registry.getAll();
  let killed = 0;
  for (const entry of entries) {
    try {
      process.kill(entry.pid, 'SIGTERM');
      killed++;
    } catch {}
  }
  if (killed > 0) log(`Shutdown: sent SIGTERM to ${killed} tracked process(es)`);
  return killed;
}

function stats() {
  return { ..._stats, tracked: registry.count() };
}

function setNotifyToken(token) { _notifyToken = token; }

module.exports = { start, stop, scan, killAll, stats, setNotifyToken };
