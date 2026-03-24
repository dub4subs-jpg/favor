'use strict';

// Memory Bridge — syncs Claude Code CLI memories into the bot's brain
// When the user interacts with Claude Code interactively, Claude saves
// memories to ~/.claude/projects/*/memory/. This module reads those
// files, splits them into individual facts, imports them into the bot's
// SQLite memory, and generates embeddings for semantic search.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SCAN_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
let scanInterval = null;
let _db = null;
let _getEmbedding = null; // injected from favor.js

// ── Category mapping: Claude Code memory type -> bot memory category ──
const TYPE_MAP = {
  user: 'preference',
  feedback: 'preference',
  project: 'fact',
  reference: 'fact'
};

// ── Self-migrating table for tracking imports ──────────────────────────
function migrate(rawDb) {
  // Check if table exists and has correct schema
  const info = rawDb.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_bridge_imports'"
  ).get();

  if (info) {
    // Table exists — check if it has the old schema (memory_id vs memory_ids)
    const cols = rawDb.prepare("PRAGMA table_info(memory_bridge_imports)").all();
    const hasOldCol = cols.find(c => c.name === 'memory_id');
    const hasNewCol = cols.find(c => c.name === 'memory_ids');
    if (hasOldCol && !hasNewCol) {
      // Old schema — rename column
      try { rawDb.exec('ALTER TABLE memory_bridge_imports RENAME COLUMN memory_id TO memory_ids'); } catch (_) {
        // SQLite < 3.25 doesn't support RENAME COLUMN — recreate
        rawDb.exec('DROP TABLE memory_bridge_imports');
      }
    }
  }

  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS memory_bridge_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      file_mtime TEXT NOT NULL,
      memory_name TEXT,
      memory_ids TEXT,
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

// ── Split a memory file body into individual facts ────────────────────
function splitIntoFacts(body, name) {
  const facts = [];

  // Split on markdown headers, bullet points, or double newlines
  const sections = body.split(/\n(?=##?\s|\n(?=[-*]\s))/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.length < 15) continue;

    // If section has bullet points, each bullet is a fact
    const bullets = trimmed.split('\n').filter(l => /^\s*[-*]\s+.{10,}/.test(l));
    if (bullets.length > 1) {
      // Include the header (if any) as context for each bullet
      const headerMatch = trimmed.match(/^##?\s+(.+)/);
      const header = headerMatch ? headerMatch[1].trim() : name;
      for (const bullet of bullets) {
        const content = bullet.replace(/^\s*[-*]\s+/, '').trim();
        if (content.length >= 15 && content.length <= 500) {
          facts.push(`[${header}] ${content}`);
        }
      }
    } else if (trimmed.length <= 500) {
      // Short section — keep as one fact
      facts.push(trimmed.replace(/^##?\s+/, '').trim());
    } else {
      // Long section — split on sentences, group into ~300 char chunks
      const sentences = trimmed.replace(/^##?\s+.+\n/, '').split(/(?<=[.!?])\s+/);
      let chunk = '';
      for (const s of sentences) {
        if ((chunk + ' ' + s).length > 300 && chunk.length >= 50) {
          facts.push(chunk.trim());
          chunk = s;
        } else {
          chunk = chunk ? chunk + ' ' + s : s;
        }
      }
      if (chunk.trim().length >= 15) facts.push(chunk.trim());
    }
  }

  // Deduplicate within this file
  const seen = new Set();
  return facts.filter(f => {
    const key = f.toLowerCase().substring(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  // Check exact prefix match (fast path)
  const prefix = content.substring(0, 60);
  const exact = rawDb.prepare(
    'SELECT id FROM memories WHERE category = ? AND content LIKE ? LIMIT 1'
  ).get(category, `%${prefix}%`);
  if (exact) return true;

  // Word overlap for near-duplicates
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

// ── Generate embeddings for newly imported memories (async, non-blocking)
async function embedNewMemories(db) {
  if (!_getEmbedding) return;

  const rawDb = db.db;
  const unembedded = rawDb.prepare(
    "SELECT id, content FROM memories WHERE embedding IS NULL AND content LIKE '[%' ORDER BY created_at DESC LIMIT 50"
  ).all();

  if (!unembedded.length) return;

  console.log(`[MEMORY-BRIDGE] Generating embeddings for ${unembedded.length} memories...`);
  let count = 0;

  for (const row of unembedded) {
    try {
      const emb = await _getEmbedding(row.content);
      db.updateEmbedding(row.id, emb);
      count++;
      await new Promise(r => setTimeout(r, 500)); // rate limit — avoid 429 bursts
    } catch (e) {
      // Non-fatal — will retry next scan
      break;
    }
  }

  if (count > 0) console.log(`[MEMORY-BRIDGE] Embedded ${count} memories`);
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
    INSERT INTO memory_bridge_imports (file_path, file_mtime, memory_name, memory_ids)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime = excluded.file_mtime,
      memory_name = excluded.memory_name,
      memory_ids = excluded.memory_ids,
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

        // Split into individual facts instead of one blob
        const facts = splitIntoFacts(body, name);

        if (facts.length === 0) {
          // Fallback: store as single memory if splitting yielded nothing
          const content = `[${name}] ${body.substring(0, 400)}`;
          if (!isDuplicate(rawDb, category, content)) {
            const memoryId = db.save(category, content, description || null);
            upsertImport.run(filePath, mtime, name, String(memoryId));
            imported++;
            console.log(`[MEMORY-BRIDGE] Imported: ${name} (1 fact)`);
          } else {
            upsertImport.run(filePath, mtime, name, null);
            skipped++;
          }
          continue;
        }

        // Import each fact individually
        const memoryIds = [];
        for (const fact of facts) {
          if (isDuplicate(rawDb, category, fact)) continue;
          const memoryId = db.save(category, fact, `bridge:${name}`);
          memoryIds.push(memoryId);
          imported++;
        }

        upsertImport.run(filePath, mtime, name, memoryIds.join(',') || null);

        if (memoryIds.length > 0) {
          console.log(`[MEMORY-BRIDGE] Imported: ${name} (${memoryIds.length} facts, ${type} -> ${category})`);
        } else {
          skipped++;
        }
      } catch (e) {
        errors++;
        console.error(`[MEMORY-BRIDGE] Error processing ${file}: ${e.message}`);
      }
    }
  }

  if (imported > 0) {
    console.log(`[MEMORY-BRIDGE] Scan complete: ${imported} imported, ${skipped} skipped, ${errors} errors`);
    // Generate embeddings async (don't block the scan)
    embedNewMemories(db).catch(e =>
      console.warn('[MEMORY-BRIDGE] Embedding pass failed (non-fatal):', e.message)
    );
  }

  return { imported, skipped, errors };
}

// ── Initialize ────────────────────────────────────────────────────────
function init(db, getEmbeddingFn) {
  _db = db;
  _getEmbedding = getEmbeddingFn || null;
  migrate(db.db);

  // First scan immediately
  const result = scan(db);
  const dirs = getClaudeMemoryDirs();
  if (dirs.length > 0) {
    console.log(`[MEMORY-BRIDGE] Watching ${dirs.length} Claude Code memory dir(s) — syncing every 2m`);
  } else {
    console.log('[MEMORY-BRIDGE] No Claude Code memory dirs found — will check again in 2m');
  }

  // Generate embeddings after a delay — let the existing backfill finish first
  setTimeout(() => embedNewMemories(db).catch(() => {}), 2 * 60 * 1000); // 2 min delay

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
