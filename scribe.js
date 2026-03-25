// ─── CONVERSATION SCRIBE ───
// Persistent conversation memory — captures every exchange in real-time
// so the bot always knows what was discussed, even across sessions and days.
// Core Favor feature: zero config, auto-creates table, works out of the box.

class ConversationScribe {
  constructor(db) {
    this.db = db;
    this._ensureTable();
  }

  _ensureTable() {
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_journal (
        id INTEGER PRIMARY KEY,
        contact TEXT NOT NULL,
        summary TEXT NOT NULL,
        category TEXT DEFAULT 'exchange',
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_journal_contact_date
        ON conversation_journal(contact, created_at);
      CREATE INDEX IF NOT EXISTS idx_journal_status
        ON conversation_journal(status);
    `);
  }

  // ─── CAPTURE ───
  // Called after every exchange to record what happened
  capture(contact, summary, category = 'exchange') {
    if (!contact || !summary || summary.length < 5) return null;

    // Normalize category
    const validCategories = ['exchange', 'decision', 'task', 'pending', 'proactive', 'teach'];
    const cat = validCategories.includes(category) ? category : 'exchange';

    // Simple dedup: skip if identical summary exists in last 5 entries for this contact
    const recent = this.db.db.prepare(
      `SELECT summary FROM conversation_journal
       WHERE contact = ? AND status = 'active'
       ORDER BY id DESC LIMIT 5`
    ).all(contact);
    if (recent.some(r => r.summary === summary)) return null;

    const stmt = this.db.db.prepare(
      `INSERT INTO conversation_journal (contact, summary, category) VALUES (?, ?, ?)`
    );
    const result = stmt.run(contact, summary.substring(0, 500), cat);
    console.log(`[SCRIBE] Captured: [${cat}] ${summary.substring(0, 80)}`);
    return result.lastInsertRowid;
  }

  // ─── TODAY'S JOURNAL ───
  // Returns all active entries from today (using JS date, not SQLite date('now'))
  getTodayJournal(contact) {
    const today = new Date().toISOString().substring(0, 10);
    return this.db.db.prepare(
      `SELECT * FROM conversation_journal
       WHERE contact = ? AND status = 'active' AND created_at >= ?
       ORDER BY created_at ASC`
    ).all(contact, today);
  }

  // ─── RECENT JOURNAL (previous days) ───
  // Returns active entries from previous days (not today), max 5 per day, last N days
  getRecentJournal(contact, days = 7) {
    const today = new Date().toISOString().substring(0, 10);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);
    return this.db.db.prepare(
      `SELECT * FROM conversation_journal
       WHERE contact = ? AND status = 'active'
       AND created_at >= ? AND created_at < ?
       ORDER BY created_at DESC`
    ).all(contact, cutoff, today);
  }

  // ─── RESOLVE ───
  // Mark a specific entry as resolved (task done, question answered)
  resolve(entryId) {
    this.db.db.prepare(
      `UPDATE conversation_journal SET status = 'resolved' WHERE id = ?`
    ).run(entryId);
  }

  // Resolve entries matching a summary pattern
  resolveByPattern(contact, pattern) {
    const entries = this.db.db.prepare(
      `SELECT id, summary FROM conversation_journal
       WHERE contact = ? AND status = 'active' AND summary LIKE ?`
    ).all(contact, `%${pattern}%`);
    for (const e of entries) {
      this.resolve(e.id);
      console.log(`[SCRIBE] Resolved: ${e.summary.substring(0, 60)}`);
    }
    return entries.length;
  }

  // ─── PROMOTE ───
  // Move old active entries to long-term memory, mark as promoted
  async promoteOldEntries(contact, olderThanDays = 7) {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const old = this.db.db.prepare(
      `SELECT * FROM conversation_journal
       WHERE contact = ? AND status = 'active' AND created_at < ?`
    ).all(contact, cutoff);

    let promoted = 0;
    for (const entry of old) {
      // Save to long-term memory
      this.db.save('fact', `[journal] ${entry.summary}`, 'scribe-promoted');
      this.db.db.prepare(
        `UPDATE conversation_journal SET status = 'promoted' WHERE id = ?`
      ).run(entry.id);
      promoted++;
    }
    if (promoted > 0) {
      console.log(`[SCRIBE] Promoted ${promoted} old entries to long-term memory`);
    }
    return promoted;
  }

  // ─── CLEANUP ───
  // Remove promoted/resolved entries older than retention period
  cleanup(retentionDays = 14) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const result = this.db.db.prepare(
      `DELETE FROM conversation_journal
       WHERE status IN ('promoted', 'resolved') AND created_at < ?`
    ).run(cutoff);
    if (result.changes > 0) {
      console.log(`[SCRIBE] Cleaned up ${result.changes} old promoted/resolved entries`);
    }
    return result.changes;
  }

  // ─── STATS ───
  getStats(contact) {
    const row = this.db.db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'promoted' THEN 1 ELSE 0 END) as promoted
       FROM conversation_journal WHERE contact = ?`
    ).get(contact);
    return row || { total: 0, active: 0, resolved: 0, promoted: 0 };
  }
}

module.exports = ConversationScribe;
