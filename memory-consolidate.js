'use strict';

// Memory Consolidation — defragments and cleans the bot's memory
// Run periodically via cron or manually: node memory-consolidate.js
//
// What it does:
// 1. Removes exact and near-duplicate memories
// 2. Removes junk (raw JSON, short fragments, empty content)
// 3. Merges related facts into consolidated summaries (via Claude CLI)
// 4. Removes stale/outdated memories flagged by AI review
// 5. Reports what was cleaned

const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'favor.db');

function run() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const stats = { duplicates: 0, junk: 0, merged: 0, stale: 0, total_before: 0, total_after: 0 };

  const allMemories = db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all();
  stats.total_before = allMemories.length;
  console.log(`[CONSOLIDATE] Starting with ${allMemories.length} memories`);

  // ── PHASE 1: Remove junk ──────────────────────────────────────────
  console.log('[CONSOLIDATE] Phase 1: Removing junk...');
  const junkIds = [];

  for (const mem of allMemories) {
    const c = (mem.content || '').trim();

    // Raw JSON fragments
    if (/^[\[{]/.test(c) && /[\]}]$/.test(c)) {
      try { JSON.parse(c); junkIds.push(mem.id); continue; } catch (_) {}
    }

    // JSON-like key-value lines
    if (/^"[^"]+"\s*:\s*"/.test(c) || /^"[^"]+"\s*:\s*\d/.test(c)) {
      junkIds.push(mem.id);
      continue;
    }

    // Too short to be useful
    if (c.length < 15) {
      junkIds.push(mem.id);
      continue;
    }

    // Repeated structural patterns (sender/label/name JSON fields)
    if (/^"(sender|name|label|type|role|from|to)"\s*:/.test(c)) {
      junkIds.push(mem.id);
      continue;
    }

    // Empty or whitespace-only
    if (!c || c === 'null' || c === 'undefined') {
      junkIds.push(mem.id);
      continue;
    }
  }

  if (junkIds.length > 0) {
    const del = db.prepare('DELETE FROM memories WHERE id = ?');
    const tx = db.transaction((ids) => { for (const id of ids) del.run(id); });
    tx(junkIds);
    stats.junk = junkIds.length;
    console.log(`  Removed ${junkIds.length} junk entries`);
  }

  // ── PHASE 2: Remove duplicates ────────────────────────────────────
  console.log('[CONSOLIDATE] Phase 2: Removing duplicates...');

  const remaining = db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all();
  const seen = new Map(); // normalized content -> id (keep the newest)
  const dupeIds = [];

  for (const mem of remaining) {
    const normalized = (mem.content || '').toLowerCase().trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '')
      .substring(0, 120);

    if (seen.has(normalized)) {
      dupeIds.push(mem.id);
    } else {
      seen.set(normalized, mem.id);
    }
  }

  // Also catch near-duplicates (>70% word overlap)
  const byCategory = {};
  for (const mem of remaining) {
    if (dupeIds.includes(mem.id)) continue;
    if (!byCategory[mem.category]) byCategory[mem.category] = [];
    byCategory[mem.category].push(mem);
  }

  for (const [cat, mems] of Object.entries(byCategory)) {
    for (let i = 0; i < mems.length; i++) {
      if (dupeIds.includes(mems[i].id)) continue;
      const wordsA = new Set(mems[i].content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      if (wordsA.size < 3) continue;

      for (let j = i + 1; j < mems.length; j++) {
        if (dupeIds.includes(mems[j].id)) continue;
        const wordsB = new Set(mems[j].content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        if (wordsB.size < 3) continue;

        const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
        const similarity = overlap / Math.max(wordsA.size, wordsB.size);

        if (similarity > 0.7) {
          // Keep the longer one (more detail), delete the shorter
          if (mems[i].content.length >= mems[j].content.length) {
            dupeIds.push(mems[j].id);
          } else {
            dupeIds.push(mems[i].id);
            break; // i is deleted, move on
          }
        }
      }
    }
  }

  if (dupeIds.length > 0) {
    const del = db.prepare('DELETE FROM memories WHERE id = ?');
    const tx = db.transaction((ids) => { for (const id of ids) del.run(id); });
    tx(dupeIds);
    stats.duplicates = dupeIds.length;
    console.log(`  Removed ${dupeIds.length} duplicates`);
  }

  // ── PHASE 3: AI review — flag stale/outdated memories ─────────────
  console.log('[CONSOLIDATE] Phase 3: AI review for stale memories...');

  const factsForReview = db.prepare(
    "SELECT id, content, created_at FROM memories WHERE category = 'fact' ORDER BY created_at ASC LIMIT 80"
  ).all();

  if (factsForReview.length > 20) {
    const factList = factsForReview.map((f, i) =>
      `${i + 1}. [${f.created_at}] ${f.content.substring(0, 200)}`
    ).join('\n');

    const reviewPrompt = `Review these bot memory entries. Return ONLY a JSON array of entry numbers that should be DELETED because they are:
- Clearly outdated or superseded by newer info
- Too vague to be useful ("something happened", "user mentioned X")
- Temporary/ephemeral (one-time events that don't matter anymore)
- Broken fragments or incomplete sentences

Keep anything that contains: names, preferences, project details, device info, workflows, or decisions.
If unsure, KEEP the memory. Be conservative — only flag obvious deletions.

Return format: [1, 5, 12] or [] if nothing to delete.

Memories:
${factList}`;

    try {
      const { execFileSync } = require('child_process');
      const env = require('./claude-env')();
      const raw = execFileSync('claude', ['-p', reviewPrompt, '--model', 'haiku'], {
        timeout: 60000, encoding: 'utf8', env, maxBuffer: 1024 * 1024
      }).trim();

      const cleaned = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
      // Extract the JSON array from the response (may have surrounding text)
      const arrayMatch = cleaned.match(/\[[\d\s,]*\]/);
      if (!arrayMatch) {
        console.log('  AI response (no array found):', cleaned.substring(0, 200));
        throw new Error('No JSON array in response');
      }
      const toDelete = JSON.parse(arrayMatch[0]);

      if (Array.isArray(toDelete) && toDelete.length > 0 && toDelete.length < factsForReview.length * 0.5) {
        const del = db.prepare('DELETE FROM memories WHERE id = ?');
        const tx = db.transaction((nums) => {
          for (const num of nums) {
            const idx = num - 1;
            if (idx >= 0 && idx < factsForReview.length) {
              del.run(factsForReview[idx].id);
              stats.stale++;
            }
          }
        });
        tx(toDelete);
        console.log(`  AI flagged ${toDelete.length} stale memories for removal`);
      } else {
        console.log('  AI found no stale memories (or response too aggressive — skipped)');
      }
    } catch (e) {
      console.warn('  AI review failed (non-fatal):', e.message?.substring(0, 100));
    }
  }

  // ── PHASE 4: Merge related facts into consolidated entries ────────
  console.log('[CONSOLIDATE] Phase 4: Merging related facts...');

  // Find clusters of bridge-imported facts from the same source
  const bridgeFacts = db.prepare(
    "SELECT id, content, status FROM memories WHERE status LIKE 'bridge:%' ORDER BY status, created_at"
  ).all();

  const clusters = {};
  for (const f of bridgeFacts) {
    const source = f.status || 'unknown';
    if (!clusters[source]) clusters[source] = [];
    clusters[source].push(f);
  }

  for (const [source, facts] of Object.entries(clusters)) {
    // Only merge if there are many small fragments from the same source
    if (facts.length < 5) continue;
    const shortFacts = facts.filter(f => f.content.length < 100);
    if (shortFacts.length < 4) continue;

    // Merge short facts into one consolidated entry
    const combined = shortFacts.map(f => '- ' + f.content).join('\n');
    if (combined.length > 1500) continue; // too big to merge

    const sourceName = source.replace('bridge:', '');
    const merged = `[${sourceName} — consolidated] ${shortFacts.map(f => f.content).join('. ')}`;

    if (merged.length <= 800) {
      // Save merged entry
      db.prepare('INSERT INTO memories (category, content, status) VALUES (?, ?, ?)').run(
        'fact', merged, `consolidated:${sourceName}`
      );

      // Delete the fragments
      const del = db.prepare('DELETE FROM memories WHERE id = ?');
      for (const f of shortFacts) del.run(f.id);
      stats.merged += shortFacts.length;

      console.log(`  Merged ${shortFacts.length} fragments from ${sourceName}`);
    }
  }

  // ── DONE ──────────────────────────────────────────────────────────
  stats.total_after = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;

  console.log('\n[CONSOLIDATE] === Results ===');
  console.log(`  Before: ${stats.total_before} memories`);
  console.log(`  Junk removed: ${stats.junk}`);
  console.log(`  Duplicates removed: ${stats.duplicates}`);
  console.log(`  Stale removed (AI): ${stats.stale}`);
  console.log(`  Fragments merged: ${stats.merged}`);
  console.log(`  After: ${stats.total_after} memories`);
  console.log(`  Net reduction: ${stats.total_before - stats.total_after} (${((1 - stats.total_after / stats.total_before) * 100).toFixed(1)}%)`);

  db.close();
  return stats;
}

// Run directly or require as module
if (require.main === module) {
  run();
} else {
  module.exports = { run };
}
