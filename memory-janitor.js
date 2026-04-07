'use strict';

// memory-janitor.js — Nightly memory consolidation for Favor
// Deduplicates near-duplicate memories and prunes stale ones.
// Run via cron or setInterval in favor.js

const COSINE_THRESHOLD = 0.85;
const BATCH_SIZE = 100;
const STALE_DAYS = 60;

/**
 * Compute cosine similarity between two float arrays.
 * Same formula used in db.js searchSemantic.
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Merge near-duplicate memories using embedding cosine similarity.
 * For each cluster of similar memories (> 0.85), keeps the longest
 * content and marks the rest as 'superseded'.
 *
 * Dedupe is partitioned by category AND contact — memories from
 * different contacts or categories are never merged, even if similar.
 *
 * Processes in batches of 100 to keep memory usage bounded.
 */
function mergeNearDuplicates(db) {
  // Fetch all active memories that have embeddings
  // Include category and contact so we only dedupe within the same scope
  const rows = db.db.prepare(
    `SELECT id, content, embedding, pinned, category, contact
     FROM memories
     WHERE embedding IS NOT NULL
       AND (status IS NULL OR status NOT IN ('superseded', 'resolved'))
     ORDER BY id`
  ).all();

  if (rows.length < 2) return 0;

  // Parse embeddings upfront (only once per memory, skip malformed)
  const items = [];
  for (const row of rows) {
    try {
      items.push({
        id: row.id,
        content: row.content,
        embedding: JSON.parse(row.embedding),
        pinned: row.pinned === 1,
        contentLength: row.content.length,
        category: row.category,
        contact: row.contact || '__global__'
      });
    } catch (_) {
      console.warn(`[JANITOR] Skipping memory #${row.id} — malformed embedding`);
    }
  }

  // Track which IDs have already been superseded in this run
  const superseded = new Set();
  let mergedCount = 0;

  const markSuperseded = db.db.prepare(
    `UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id = ?`
  );

  // Process in batches to avoid O(n^2) blowup on huge tables
  for (let batchStart = 0; batchStart < items.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, items.length);

    for (let i = batchStart; i < batchEnd; i++) {
      const a = items[i];
      if (superseded.has(a.id)) continue;

      // Collect cluster: all items similar to `a`
      const cluster = [a];

      // Compare against everything after `i` (avoid double-counting)
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        if (superseded.has(b.id)) continue;
        // Only dedupe within same category AND contact scope
        if (a.category !== b.category || a.contact !== b.contact) continue;

        const sim = cosineSimilarity(a.embedding, b.embedding);
        if (sim >= COSINE_THRESHOLD) {
          cluster.push(b);
        }
      }

      if (cluster.length < 2) continue;

      // Decide which to keep: prefer pinned, then longest content
      cluster.sort((x, y) => {
        // Pinned always wins
        if (x.pinned && !y.pinned) return -1;
        if (!x.pinned && y.pinned) return 1;
        // Then longest content
        return y.contentLength - x.contentLength;
      });

      const keeper = cluster[0];

      // Supersede the rest
      for (let k = 1; k < cluster.length; k++) {
        const victim = cluster[k];
        if (victim.pinned) continue; // Never touch pinned memories
        markSuperseded.run(victim.id);
        superseded.add(victim.id);
        mergedCount++;
      }
    }
  }

  return mergedCount;
}

/**
 * Prune stale memories that are:
 *  - Missing embeddings (embedding IS NULL)
 *  - Older than 60 days
 *  - Never referenced (last_referenced IS NULL)
 *  - Not pinned (pinned = 0 or pinned IS NULL)
 *  - Not already superseded/resolved/pending
 *  - Not in the 'task' category (tasks/pending are exempt from stale pruning)
 *
 * Marks them as 'superseded' (soft delete).
 */
function pruneStale(db) {
  const cutoffDate = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

  const result = db.db.prepare(
    `UPDATE memories
     SET status = 'superseded', updated_at = datetime('now')
     WHERE embedding IS NULL
       AND created_at < ?
       AND last_referenced IS NULL
       AND (pinned = 0 OR pinned IS NULL)
       AND (status IS NULL OR status NOT IN ('superseded', 'resolved', 'pending'))
       AND category != 'task'`
  ).run(cutoffDate);

  return result.changes;
}

/**
 * Gather stats about the current memory table.
 */
function getStats(db) {
  const total_active = db.db.prepare(
    `SELECT COUNT(*) AS c FROM memories
     WHERE (status IS NULL OR status NOT IN ('superseded', 'resolved'))`
  ).get().c;

  const total_embedded = db.db.prepare(
    `SELECT COUNT(*) AS c FROM memories
     WHERE embedding IS NOT NULL
       AND (status IS NULL OR status NOT IN ('superseded', 'resolved'))`
  ).get().c;

  return { total_active, total_embedded };
}

/**
 * Run the full memory janitor cycle.
 * @param {FavorMemory} db — instance from db.js (has db.db for raw SQLite)
 * @returns {{ merged: number, pruned: number, total_active: number, total_embedded: number }}
 */
async function run(db) {
  const merged = mergeNearDuplicates(db);
  const pruned = pruneStale(db);
  const stats = getStats(db);

  console.log(`[JANITOR] Merged: ${merged}, Pruned: ${pruned}, Active: ${stats.total_active}, Embedded: ${stats.total_embedded}`);
  db.audit('memory.janitor', `merged:${merged} pruned:${pruned} active:${stats.total_active}`);

  return { merged, pruned, ...stats };
}

module.exports = { run };
