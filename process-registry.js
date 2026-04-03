'use strict';

/**
 * Singleton registry tracking every spawned Claude CLI process.
 * Used by reaper.js to identify stale/orphan processes.
 */

const registry = new Map(); // pid -> entry

function register(proc, { source = 'unknown', purpose = '', timeoutMs = 120000, model = '' } = {}) {
  if (!proc || !proc.pid) return;
  const entry = {
    pid: proc.pid,
    source,
    purpose: String(purpose).substring(0, 120),
    startedAt: Date.now(),
    timeoutMs,
    model,
  };
  registry.set(proc.pid, entry);

  // Auto-unregister on exit
  const cleanup = () => registry.delete(proc.pid);
  proc.on('close', cleanup);
  proc.on('error', cleanup);

  return entry;
}

function unregister(pid) {
  return registry.delete(pid);
}

function getAll() {
  return [...registry.entries()].map(([pid, e]) => ({ pid, ...e }));
}

function count() {
  return registry.size;
}

function has(pid) {
  return registry.has(pid);
}

function get(pid) {
  return registry.get(pid);
}

module.exports = { register, unregister, getAll, count, has, get };
