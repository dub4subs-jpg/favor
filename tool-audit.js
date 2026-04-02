// tool-audit.js — Checkpoint system for tool execution
// Logs intent BEFORE execution and result AFTER, so Dell can report
// partial progress on multi-step workflows that fail mid-way

class ToolAudit {
  constructor(db) {
    this.db = db;
    this._insertCount = 0;
    this._ensureTable();
    this._cleanupStale();
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        params TEXT,
        contact TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        error TEXT,
        elapsed_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this._prune();
  }

  // Prune entries older than 7 days — runs at startup + every 100 inserts
  _prune() {
    try {
      this.db.exec(`DELETE FROM tool_audit WHERE created_at < datetime('now', '-7 days')`);
    } catch (_) {}
  }

  // Mark any tools left in 'executing' from a previous crash as interrupted
  _cleanupStale() {
    try {
      const updated = this.db.prepare(
        `UPDATE tool_audit SET status = 'interrupted', error = 'process restarted' WHERE status = 'executing'`
      ).run();
      if (updated.changes > 0) {
        console.log(`[AUDIT] Marked ${updated.changes} stale executing tools as interrupted`);
      }
    } catch (_) {}
  }

  // Log intent before executing a tool. Returns auditId.
  logIntent(toolName, params, contact) {
    try {
      const stmt = this.db.prepare(
        `INSERT INTO tool_audit (tool_name, params, contact, status) VALUES (?, ?, ?, 'executing')`
      );
      const result = stmt.run(toolName, JSON.stringify(params), contact);

      // Periodic retention — every 100 inserts
      if (++this._insertCount % 100 === 0) this._prune();

      return result.lastInsertRowid;
    } catch (e) {
      console.warn('[AUDIT] logIntent failed:', e.message);
      return null;
    }
  }

  // Log result after tool execution completes
  logResult(auditId, status, result, elapsedMs) {
    if (!auditId) return;
    try {
      const isError = status === 'error';
      this.db.prepare(
        `UPDATE tool_audit SET status = ?, ${isError ? 'error' : 'result'} = ?, elapsed_ms = ? WHERE id = ?`
      ).run(status, typeof result === 'string' ? result.substring(0, 2000) : String(result), elapsedMs, auditId);
    } catch (e) {
      console.warn('[AUDIT] logResult failed:', e.message);
    }
  }

  // Get recent audit entries for a contact (useful for "what happened?" queries)
  getRecent(contact, limit = 5) {
    try {
      return this.db.prepare(
        `SELECT id, tool_name, status, result, error, elapsed_ms, created_at
         FROM tool_audit WHERE contact = ? ORDER BY id DESC LIMIT ?`
      ).all(contact, limit);
    } catch (e) {
      return [];
    }
  }

  // Get the last tool still marked as 'executing' for a contact (crash recovery)
  getLastExecuting(contact) {
    try {
      return this.db.prepare(
        `SELECT * FROM tool_audit WHERE contact = ? AND status = 'executing' ORDER BY id DESC LIMIT 1`
      ).get(contact);
    } catch (e) {
      return null;
    }
  }
}

module.exports = ToolAudit;
