#!/usr/bin/env node
// sync-memory.js — Push memories into Favor's SQLite from Claude Code
// Usage:
//   node sync-memory.js complete "Weekly report" "Sent to client on Monday"
//   node sync-memory.js save '{"category":"fact","content":"...","status":null}'
//   node sync-memory.js resolve "spam email cleanup"

const path = require('path');
const FavorMemory = require('./db.js');

const dbPath = path.resolve(__dirname, 'data/favor.db');
const db = new FavorMemory(dbPath);

const [,, command, ...args] = process.argv;

switch (command) {
  case 'complete': {
    // Mark a task as resolved
    const [taskName, details] = args;
    if (!taskName) { console.error('Usage: sync-memory.js complete <task> [details]'); process.exit(1); }
    const content = details
      ? `${taskName} — COMPLETED. ${details}`
      : `${taskName} — COMPLETED`;
    const id = db.save('decision', `[Claude Code] ${content}`);
    console.log(`✓ Memory #${id}: ${content}`);
    break;
  }

  case 'resolve': {
    // Mark existing pending memories about a topic as superseded
    const [topic] = args;
    if (!topic) { console.error('Usage: sync-memory.js resolve <topic>'); process.exit(1); }
    const rows = db.db.prepare(
      `SELECT id, content FROM memories WHERE content LIKE ? AND (status IS NULL OR status = '') AND category IN ('task', 'decision', 'fact', 'project_update')`
    ).all(`%${topic}%`);
    for (const row of rows) {
      db.db.prepare(`UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id = ?`).run(row.id);
      console.log(`  ↳ Superseded #${row.id}: ${row.content.substring(0, 80)}...`);
    }
    console.log(`✓ Resolved ${rows.length} memories matching "${topic}"`);
    break;
  }

  case 'save': {
    // Freeform save with JSON
    const json = args.join(' ');
    if (!json) { console.error('Usage: sync-memory.js save \'{"category":"...","content":"..."}\''); process.exit(1); }
    let parsed;
    try { parsed = JSON.parse(json); } catch (e) { console.error('Invalid JSON:', e.message); process.exit(1); }
    const { category, content, status, contact } = parsed;
    if (!category || !content) { console.error('Required: category, content'); process.exit(1); }
    const id = db.save(category, String(content), status, null, contact);
    console.log(`✓ Memory #${id} (${category}): ${String(content).substring(0, 80)}`);
    break;
  }

  default:
    console.error('Commands: complete, resolve, save');
    console.error('  complete <task> [details]  — mark task done');
    console.error('  resolve <topic>            — supersede pending memories');
    console.error('  save \'{"category":".."}\'   — freeform insert');
    process.exit(1);
}

db.db.close();
