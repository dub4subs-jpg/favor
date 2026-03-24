'use strict';

// Memory Bridge — syncs Claude Code CLI memories into the bot's brain
// When the user interacts with Claude Code interactively, Claude saves
// memories to ~/.claude/projects/*/memory/. This module reads those
// files and imports them into the bot's SQLite memory so the bot
// knows what Claude Code learned about the user.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let scanInterval = null;
let _db = null;

// ── Category mapping: Claude Code memory type -> bot memory category ──
const TYPE_MAP = {
  user: 'preference',
  feedback: 'preference',
  project: 'fact',
  reference: 'fact'
};

// ── Self-migrating table for tracking imports ──────────────────────────
function migrate(rawDb) {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS memory_bridge_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      file_mtime TEXT NOT NULL,
      memory_name TEXT,
      memory_id INTEGER,
      imported_at TEXT DEFAULT (datetime('now'))
    )
  `);
  try {
    rawDb.exec('CREATE INDEX IF NOT EXISTS idx_bridge_path ON memory_bridge_imports(file_path)');
  } catch (_) {}
}

// ── Parse frontmatter from a memory file ──────────────────────────────
function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') {
    return { meta: {}, body: text.trim() };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return { meta: {}, body: text.trim() };
  }

  const meta = {};
  for (let i = 1; i < endIdx; i++) {
    const match = lines[i].match(/^(\w+):\s*(.+)$/);
    if (match) {
      meta[match[1]] = match[2].trim();
    }
  }

  const body = lines.slice(endIdx + 1).join('\n').trim();
  return { meta, body };
}

// ── Find all Claude Code memory directories ───────────────────────────
function getClaudeMemoryDirs() {
  const dirs = [];
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeProjectsDir)) return dirs;

  try {
    for (const entry of fs.readdirSync(claudeProjectsDir)) {
      const memoryDir = path.join(claudeProjectsDir, entry, 'memory');
      try {
        if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
          dirs.push(memoryDir);
        }
      } catch (_) {}
    }
  } catch (_) {}

  return dirs;
}

// ── Check if content already exists in bot memory (text overlap) ──────
function isDuplicate(rawDb, category, content) {
  // Check exact prefix match first (fast path)
  const prefix = content.substring(0, 80);
  const exact = rawDb.prepare(
    'SELECT id FROM memories WHERE category = ? AND content LIKE ? LIMIT 1'
  ).get(category, `%${prefix}%`);
  if (exact) return true;

  // Check word overlap for near-duplicates
  const contentWords = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (contentWords.size < 3) return false;

  const rows = rawDb.prepare(
    'SELECT content FROM memories WHERE category = ? ORDER BY created_at DESC LIMIT 200'
  ).all(category);

  for (const row of rows) {
    const rowWords = new Set(row.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const overlap = [...contentWords].filter(w => rowWords.has(w)).length;
    if (overlap / Math.max(contentWords.size, rowWords.size) > 0.6) return true;
  }

  return false;
}

// ── Core scan logic ───────────────────────────────────────────────────
function scan(db) {
  if (!db) return { imported: 0, skipped: 0, errors: 0 };

  const rawDb = db.db;
  migrate(rawDb);
  const memoryDirs = getClaudeMemoryDirs();

  if (memoryDirs.length === 0) return { imported: 0, skipped: 0, errors: 0 };

  const getImport = rawDb.prepare('SELECT * FROM memory_bridge_imports WHERE file_path = ?');
  const upsertImport = rawDb.prepare(`
    INSERT INTO memory_bridge_imports (file_path, file_mtime, memory_name, memory_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime = excluded.file_mtime,
      memory_name = excluded.memory_name,
      memory_id = excluded.memory_id,
      imported_at = datetime('now')
  `);

  let imported = 0, skipped = 0, errors = 0;

  for (const memDir of memoryDirs) {
    let files;
    try {
      files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch (_) { continue; }

    for (const file of files) {
      const filePath = path.join(memDir, file);
      try {
        const stat = fs.statSync(filePath);
        const mtime = stat.mtime.toISOString();

        // Check if already imported with same mtime
        const existing = getImport.get(filePath);
        if (existing && existing.file_mtime === mtime) {
          skipped++;
          continue;
        }

        // Read and parse
        const text = fs.readFileSync(filePath, 'utf8');
        const { meta, body } = parseFrontmatter(text);

        if (!body || body.length < 10) {
          skipped++;
          continue;
        }

        const name = meta.name || path.basename(file, '.md');
        const type = meta.type || 'fact';
        const category = TYPE_MAP[type] || 'fact';
        const description = meta.description || '';

        // Build content string
        const content = `[Claude Code: ${name}] ${body}`;

        // Dedup check
        if (isDuplicate(rawDb, category, content)) {
          // Still update the import record so we don't re-check next scan
          upsertImport.run(filePath, mtime, name, null);
          skipped++;
          continue;
        }

        // Import into bot memory
        const memoryId = db.save(category, content, description || null);
        upsertImport.run(filePath, mtime, name, memoryId);
        imported++;

        console.log(`[MEMORY-BRIDGE] Imported: ${name} (${type} -> ${category})`);
      } catch (e) {
        errors++;
        console.error(`[MEMORY-BRIDGE] Error processing ${file}: ${e.message}`);
      }
    }
  }

  if (imported > 0) {
    console.log(`[MEMORY-BRIDGE] Scan complete: ${imported} imported, ${skipped} skipped, ${errors} errors`);
  }

  return { imported, skipped, errors };
}

// ── Initialize ────────────────────────────────────────────────────────
function init(db) {
  _db = db;
  migrate(db.db);

  // First scan immediately
  const result = scan(db);
  const dirs = getClaudeMemoryDirs();
  if (dirs.length > 0) {
    console.log(`[MEMORY-BRIDGE] Watching ${dirs.length} Claude Code memory dir(s) — syncing every 5m`);
  } else {
    console.log('[MEMORY-BRIDGE] No Claude Code memory dirs found — will check again in 5m');
  }

  // Schedule periodic scans
  scanInterval = setInterval(() => {
    try { scan(_db); } catch (e) {
      console.error('[MEMORY-BRIDGE] Scan error:', e.message);
    }
  }, SCAN_INTERVAL_MS);
}

// ── Stop ──────────────────────────────────────────────────────────────
function stop() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
    console.log('[MEMORY-BRIDGE] Stopped');
  }
}

module.exports = { init, scan, stop };
