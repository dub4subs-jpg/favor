const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class FavorMemory {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT,
        embedding TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        contact TEXT NOT NULL,
        messages TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        name TEXT NOT NULL,
        messages TEXT DEFAULT '[]',
        active INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS compaction_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        summary TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS crons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT,
        label TEXT NOT NULL,
        schedule TEXT NOT NULL,
        task TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        next_run TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS config_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        detail TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS open_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        summary TEXT NOT NULL,
        context TEXT,
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS taught_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        command_name TEXT NOT NULL,
        description TEXT,
        trigger_phrase TEXT NOT NULL,
        pipeline TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        execution_count INTEGER DEFAULT 0,
        last_executed TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_sessions_contact ON sessions(contact);
      CREATE INDEX IF NOT EXISTS idx_topics_contact ON topics(contact);
      CREATE INDEX IF NOT EXISTS idx_crons_enabled ON crons(enabled);
      CREATE INDEX IF NOT EXISTS idx_threads_contact ON open_threads(contact, status);
      CREATE INDEX IF NOT EXISTS idx_taught_contact ON taught_commands(contact, enabled);
      CREATE INDEX IF NOT EXISTS idx_taught_trigger ON taught_commands(trigger_phrase);
    `);
    // ─── SCHEMA VERSIONING ───
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
    const currentVersion = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get()?.v || 0;

    const migrations = [
      // v1: Add embedding + contact columns to memories
      () => {
        try { this.db.exec(`ALTER TABLE memories ADD COLUMN embedding TEXT`); } catch (_) {}
        try { this.db.exec(`ALTER TABLE memories ADD COLUMN contact TEXT`); } catch (_) {}
        try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_contact ON memories(contact)`); } catch (_) {}
      },
      // v2: Add cost_logs table
      () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS cost_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model TEXT, route TEXT, caller TEXT,
            input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
            cost REAL DEFAULT 0, timestamp TEXT DEFAULT (datetime('now'))
          );
        `);
      },
      // v3: Add guard_logs table
      () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS guard_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact TEXT, action TEXT NOT NULL, reason TEXT,
            timestamp TEXT DEFAULT (datetime('now'))
          );
        `);
      },
      // v4: Add router_telemetry table (schema matches router.js inserts)
      () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS router_telemetry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact TEXT,
            route TEXT,
            escalation_score INTEGER,
            model_used TEXT,
            tools_used TEXT,
            needs_review INTEGER,
            success INTEGER DEFAULT 1,
            classifier_ms INTEGER,
            total_ms INTEGER,
            reason TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);
      },
      // v5: Clear OpenAI embeddings (1536-dim) — local model uses 384-dim
      () => {
        const sample = this.db.prepare("SELECT embedding FROM memories WHERE embedding IS NOT NULL LIMIT 1").get();
        if (sample) {
          try {
            const emb = JSON.parse(sample.embedding);
            if (emb.length !== 384) {
              const count = this.db.prepare("UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL").run().changes;
              console.log(`[DB] Cleared ${count} old embeddings (wrong dimensions) — will regenerate with local model`);
            }
          } catch (_) {
            this.db.exec("UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL");
          }
        }
      },
      // v6: Fix router_telemetry schema — add missing columns for existing installs
      () => {
        const cols = this.db.prepare("PRAGMA table_info(router_telemetry)").all().map(c => c.name);
        const needed = [
          { name: 'contact', def: 'TEXT' },
          { name: 'escalation_score', def: 'INTEGER' },
          { name: 'model_used', def: 'TEXT' },
          { name: 'needs_review', def: 'INTEGER' },
          { name: 'classifier_ms', def: 'INTEGER' },
          { name: 'total_ms', def: 'INTEGER' },
          { name: 'reason', def: 'TEXT' },
          { name: 'created_at', def: "TEXT DEFAULT (datetime('now'))" },
        ];
        for (const col of needed) {
          if (!cols.includes(col.name)) {
            this.db.exec(`ALTER TABLE router_telemetry ADD COLUMN ${col.name} ${col.def}`);
          }
        }
      },
      // v7: Contact profiles for relationship memory
      () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS contact_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact TEXT NOT NULL UNIQUE,
            display_name TEXT,
            communication_style TEXT DEFAULT 'neutral',
            topics TEXT DEFAULT '[]',
            interaction_summary TEXT DEFAULT '[]',
            greeting_style TEXT,
            trust_trend TEXT DEFAULT 'stable',
            message_count INTEGER DEFAULT 0,
            last_interaction TEXT DEFAULT (datetime('now')),
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          )
        `);
      },
    ];

    // Apply only new migrations
    for (let i = currentVersion; i < migrations.length; i++) {
      try {
        migrations[i]();
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
      } catch (e) {
        console.error(`[DB] Migration v${i + 1} failed:`, e.message);
        break; // Stop on failure — don't skip migrations
      }
    }
  }

  // ─── MEMORY ───
  save(category, content, status, embedding = null, contact = null) {
    // Supersede conflicting decisions about the same entity
    if (category === 'decision' || category === 'fact' || category === 'project_update') {
      this._supersedeConflicts(content);
    }
    const stmt = this.db.prepare('INSERT INTO memories (category, content, status, embedding, contact) VALUES (?, ?, ?, ?, ?)');
    stmt.run(category, content, status || null, embedding ? JSON.stringify(embedding) : null, contact || null);
    return this.db.prepare('SELECT last_insert_rowid() as id').get().id;
  }

  // ─── MEMORY SUPERSESSION ───
  // When saving a new memory about a specific entity (invoice, task, etc.),
  // mark older conflicting memories as 'superseded' so they don't surface
  _supersedeConflicts(content) {
    const entityPatterns = [
      /\b(invoice\s*#?\d+)/i,
      /\b(task\s*#?\d+)/i,
      /\b(pr\s*#?\d+)/i,
      /\b(ticket\s*#?\d+)/i,
      /\b(order\s*#?\d+)/i,
      /\b(issue\s*#?\d+)/i,
    ];

    for (const pattern of entityPatterns) {
      const match = content.match(pattern);
      if (!match) continue;

      const entity = match[1];
      const older = this.db.prepare(
        "SELECT id FROM memories WHERE LOWER(content) LIKE ? AND status IS NOT 'resolved' AND status IS NOT 'superseded' ORDER BY created_at DESC LIMIT 20"
      ).all(`%${entity.toLowerCase()}%`);

      if (older.length > 0) {
        const ids = older.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(
          `UPDATE memories SET status = 'superseded' WHERE id IN (${placeholders})`
        ).run(...ids);
        console.log(`[MEMORY] Superseded ${older.length} older memories about "${entity}"`);
      }
      break;
    }
  }

  // ─── PER-CONTACT MEMORY ───
  saveContactMemory(contact, content) {
    // Dedup: don't save if similar content exists for this contact
    const existing = this.db.prepare("SELECT id FROM memories WHERE contact = ? AND content LIKE ? LIMIT 1")
      .get(contact, `%${content.substring(0, 50)}%`);
    if (existing) return existing.id;
    return this.save('contact_fact', content, null, null, contact);
  }

  getContactMemories(contact, limit = 10) {
    return this.db.prepare("SELECT * FROM memories WHERE contact = ? ORDER BY created_at DESC LIMIT ?")
      .all(contact, limit);
  }

  searchContactMemories(contact, query, limit = 5) {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (!terms.length) return this.getContactMemories(contact, limit);
    const conditions = terms.map(() => "LOWER(content) LIKE ?").join(' OR ');
    const params = terms.map(t => `%${t}%`);
    return this.db.prepare(`SELECT * FROM memories WHERE contact = ? AND (${conditions}) ORDER BY created_at DESC LIMIT ?`)
      .all(contact, ...params, limit);
  }

  // ─── CONTACT PROFILES (relationship memory) ───
  getContactProfile(contact) {
    const row = this.db.prepare('SELECT * FROM contact_profiles WHERE contact = ?').get(contact);
    if (!row) return null;
    return { ...row, topics: JSON.parse(row.topics || '[]'), interaction_summary: JSON.parse(row.interaction_summary || '[]') };
  }

  upsertContactProfile(contact, updates) {
    const existing = this.db.prepare('SELECT id FROM contact_profiles WHERE contact = ?').get(contact);
    if (existing) {
      const sets = [];
      const vals = [];
      for (const [k, v] of Object.entries(updates)) {
        if (['communication_style', 'display_name', 'greeting_style', 'trust_trend'].includes(k)) {
          sets.push(`${k} = ?`); vals.push(v);
        } else if (k === 'topics' || k === 'interaction_summary') {
          sets.push(`${k} = ?`); vals.push(JSON.stringify(v));
        }
      }
      if (sets.length) {
        sets.push('message_count = message_count + 1');
        sets.push("last_interaction = datetime('now')");
        sets.push("updated_at = datetime('now')");
        this.db.prepare(`UPDATE contact_profiles SET ${sets.join(', ')} WHERE contact = ?`).run(...vals, contact);
      }
    } else {
      this.db.prepare(
        `INSERT INTO contact_profiles (contact, display_name, communication_style, topics, interaction_summary)
         VALUES (?, ?, ?, ?, ?)`
      ).run(contact, updates.display_name || null, updates.communication_style || 'neutral',
            JSON.stringify(updates.topics || []), JSON.stringify(updates.interaction_summary || []));
    }
  }

  updateEmbedding(id, embedding) {
    this.db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(embedding), id);
  }

  getWithoutEmbeddings() {
    return this.db.prepare('SELECT id, content FROM memories WHERE embedding IS NULL').all();
  }

  search(query) {
    // BM25-style keyword ranking: score by term frequency + recency
    // Excludes superseded/resolved memories so stale info doesn't surface
    const statusFilter = "AND (status IS NULL OR status NOT IN ('superseded', 'resolved'))";
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (!terms.length) {
      const stmt = this.db.prepare(`SELECT * FROM memories WHERE content LIKE ? ${statusFilter} ORDER BY created_at DESC LIMIT 20`);
      return stmt.all(`%${query}%`);
    }
    // Get all potential matches (any term)
    const conditions = terms.map(() => "LOWER(content) LIKE ?").join(' OR ');
    const params = terms.map(t => `%${t}%`);
    const rows = this.db.prepare(`SELECT * FROM memories WHERE (${conditions}) ${statusFilter} LIMIT 200`).all(...params);
    // Score: term hits + recency boost
    const now = Date.now();
    const scored = rows.map(row => {
      const lower = row.content.toLowerCase();
      let termScore = 0;
      for (const t of terms) {
        const matches = (lower.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        termScore += matches;
      }
      // Recency: memories from last 24h get 2x boost, last week 1.5x, older 1x
      const ageMs = now - new Date(row.created_at).getTime();
      const recencyBoost = ageMs < 86400000 ? 2.0 : ageMs < 604800000 ? 1.5 : 1.0;
      return { ...row, score: termScore * recencyBoost };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, 20);
  }

  searchSemantic(queryEmbedding, topK = 8) {
    const rows = this.db.prepare("SELECT id, category, content, status, created_at, embedding FROM memories WHERE embedding IS NOT NULL AND (status IS NULL OR status NOT IN ('superseded', 'resolved'))").all();
    if (!rows.length) return [];
    const now = Date.now();
    const scored = rows.map(row => {
      const emb = JSON.parse(row.embedding);
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < emb.length; i++) {
        dot += queryEmbedding[i] * emb[i];
        normA += queryEmbedding[i] * queryEmbedding[i];
        normB += emb[i] * emb[i];
      }
      const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
      // Recency decay: blend cosine similarity (80%) with recency (20%)
      const ageMs = now - new Date(row.created_at).getTime();
      const ageDays = ageMs / 86400000;
      const recency = Math.exp(-ageDays / 90); // half-life ~62 days
      return { ...row, score: cosine * 0.8 + recency * 0.2 };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // Find near-duplicates by content similarity (for dedup)
  findSimilar(category, content) {
    const rows = this.db.prepare('SELECT id, content, embedding FROM memories WHERE category = ? AND embedding IS NOT NULL').all(category);
    return rows.filter(row => {
      // Quick text overlap check before expensive embedding comparison
      const a = content.toLowerCase();
      const b = row.content.toLowerCase();
      // If >60% of words overlap, likely duplicate
      const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
      const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
      if (!wordsA.size || !wordsB.size) return false;
      const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
      return overlap / Math.max(wordsA.size, wordsB.size) > 0.6;
    });
  }

  forget(category, query) {
    const stmt = this.db.prepare("DELETE FROM memories WHERE category = ? AND content LIKE ?");
    const result = stmt.run(category, `%${query}%`);
    return result.changes;
  }

  getByCategory(category, limit = 50) {
    const stmt = this.db.prepare("SELECT * FROM memories WHERE category = ? ORDER BY created_at DESC LIMIT ?");
    return stmt.all(category, limit);
  }

  getAllMemories() {
    const categories = ['fact', 'decision', 'preference', 'task', 'workflow', 'idea', 'project_update', 'personality'];
    const plurals = { personality: 'personalities', project_update: 'project_updates' };
    const result = {};
    for (const cat of categories) {
      result[plurals[cat] || cat + 's'] = this.getByCategory(cat);
    }
    return result;
  }

  getMemoryCount() {
    const stmt = this.db.prepare("SELECT category, COUNT(*) as count FROM memories GROUP BY category");
    const rows = stmt.all();
    const counts = { facts: 0, decisions: 0, preferences: 0, tasks: 0 };
    for (const row of rows) counts[row.category + 's'] = row.count;
    return counts;
  }

  getAllActiveLessons() {
    try {
      return this.db.prepare('SELECT * FROM lessons WHERE confidence > 0 ORDER BY hit_count DESC LIMIT 50').all();
    } catch { return []; }
  }

  getAllContacts() {
    try {
      return this.db.prepare('SELECT * FROM contact_profiles ORDER BY last_interaction DESC').all();
    } catch { return []; }
  }

  // ─── SESSIONS ───
  getSession(contact) {
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE contact = ?");
    const row = stmt.get(contact);
    if (!row) return null;
    row.messages = JSON.parse(row.messages);
    return row;
  }

  saveSession(contact, messages) {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, contact, messages, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET messages = ?, updated_at = datetime('now')
    `);
    const id = 'wa:' + contact;
    const json = JSON.stringify(messages);
    stmt.run(id, contact, json, json);
  }

  clearSession(contact) {
    const stmt = this.db.prepare("DELETE FROM sessions WHERE contact = ?");
    stmt.run(contact);
  }

  // ─── TOPICS (Conversation Branching) ───
  getActiveTopic(contact) {
    const stmt = this.db.prepare("SELECT * FROM topics WHERE contact = ? AND active = 1 LIMIT 1");
    const row = stmt.get(contact);
    if (row) row.messages = JSON.parse(row.messages);
    return row || null;
  }

  getTopics(contact) {
    const stmt = this.db.prepare("SELECT id, name, active, created_at, updated_at FROM topics WHERE contact = ? ORDER BY updated_at DESC");
    return stmt.all(contact);
  }

  createTopic(contact, name) {
    // Deactivate all other topics for this contact
    this.db.prepare("UPDATE topics SET active = 0 WHERE contact = ?").run(contact);
    const stmt = this.db.prepare("INSERT INTO topics (contact, name, active) VALUES (?, ?, 1)");
    const result = stmt.run(contact, name);
    return result.lastInsertRowid;
  }

  switchTopic(contact, topicId) {
    this.db.prepare("UPDATE topics SET active = 0 WHERE contact = ?").run(contact);
    this.db.prepare("UPDATE topics SET active = 1, updated_at = datetime('now') WHERE id = ? AND contact = ?").run(topicId, contact);
  }

  saveTopicMessages(topicId, messages) {
    const stmt = this.db.prepare("UPDATE topics SET messages = ?, updated_at = datetime('now') WHERE id = ?");
    stmt.run(JSON.stringify(messages), topicId);
  }

  deleteTopic(topicId) {
    this.db.prepare("DELETE FROM topics WHERE id = ?").run(topicId);
  }

  // ─── COMPACTION ───
  saveCompactionSummary(contact, summary, messageCount) {
    const stmt = this.db.prepare("INSERT INTO compaction_summaries (contact, summary, message_count) VALUES (?, ?, ?)");
    stmt.run(contact, summary, messageCount);
  }

  getCompactionSummaries(contact, limit = 5) {
    const stmt = this.db.prepare("SELECT * FROM compaction_summaries WHERE contact = ? ORDER BY created_at DESC LIMIT ?");
    return stmt.all(contact, limit);
  }

  getTodayCompactionSummaries(contact) {
    const today = new Date().toISOString().substring(0, 10);
    return this.db.prepare(
      "SELECT * FROM compaction_summaries WHERE contact = ? AND created_at >= ? ORDER BY created_at ASC"
    ).all(contact, today);
  }

  // ─── CRONS ───
  createCron(contact, label, schedule, task) {
    const nextRun = this._calcNextRun(schedule);
    const stmt = this.db.prepare("INSERT INTO crons (contact, label, schedule, task, next_run) VALUES (?, ?, ?, ?, ?)");
    const result = stmt.run(contact, label, schedule, task, nextRun);
    return result.lastInsertRowid;
  }

  getCrons(contact) {
    if (contact) {
      return this.db.prepare("SELECT * FROM crons WHERE contact = ? ORDER BY created_at DESC").all(contact);
    }
    return this.db.prepare("SELECT * FROM crons ORDER BY created_at DESC").all();
  }

  getActiveCrons() {
    return this.db.prepare("SELECT * FROM crons WHERE enabled = 1").all();
  }

  getDueCrons() {
    const now = new Date().toISOString();
    return this.db.prepare("SELECT * FROM crons WHERE enabled = 1 AND next_run <= ?").all(now);
  }

  updateCronRun(cronId, schedule) {
    const nextRun = this._calcNextRun(schedule);
    this.db.prepare("UPDATE crons SET last_run = datetime('now'), next_run = ? WHERE id = ?").run(nextRun, cronId);
  }

  deleteCron(cronId) {
    const result = this.db.prepare("DELETE FROM crons WHERE id = ?").run(cronId);
    return result.changes;
  }

  toggleCron(cronId, enabled) {
    this.db.prepare("UPDATE crons SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, cronId);
  }

  _calcNextRun(schedule) {
    const now = new Date();
    // Parse schedule formats: "every 5m", "every 1h", "daily 09:00", "weekly mon 09:00"
    const everyMatch = schedule.match(/^every\s+(\d+)\s*(m|min|h|hr|hour|d|day)s?$/i);
    if (everyMatch) {
      const val = parseInt(everyMatch[1]);
      const unit = everyMatch[2].toLowerCase();
      if (unit === 'm' || unit === 'min') now.setMinutes(now.getMinutes() + val);
      else if (unit === 'h' || unit === 'hr' || unit === 'hour') now.setHours(now.getHours() + val);
      else if (unit === 'd' || unit === 'day') now.setDate(now.getDate() + val);
      return now.toISOString();
    }

    const dailyMatch = schedule.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
    if (dailyMatch) {
      const targetHour = parseInt(dailyMatch[1]);
      const targetMin = parseInt(dailyMatch[2]);
      now.setHours(targetHour, targetMin, 0, 0);
      if (now <= new Date()) now.setDate(now.getDate() + 1);
      return now.toISOString();
    }

    const weeklyMatch = schedule.match(/^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i);
    if (weeklyMatch) {
      const days = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const targetDay = days[weeklyMatch[1].toLowerCase()];
      const targetHour = parseInt(weeklyMatch[2]);
      const targetMin = parseInt(weeklyMatch[3]);
      const diff = (targetDay - now.getDay() + 7) % 7 || 7;
      now.setDate(now.getDate() + diff);
      now.setHours(targetHour, targetMin, 0, 0);
      return now.toISOString();
    }

    // Fallback: 1 hour from now
    now.setHours(now.getHours() + 1);
    return now.toISOString();
  }

  // ─── OPEN THREADS (conversation follow-up tracking) ───
  saveThread(contact, summary, context = null) {
    // Check for near-duplicate open threads before saving
    const existing = this.getOpenThreads(contact);
    const lower = summary.toLowerCase();
    for (const t of existing) {
      const words = new Set(lower.split(/\s+/).filter(w => w.length > 2));
      const tWords = new Set(t.summary.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      const overlap = [...words].filter(w => tWords.has(w)).length;
      if (overlap / Math.max(words.size, tWords.size) > 0.5) {
        // Update existing thread instead of creating duplicate
        this.db.prepare("UPDATE open_threads SET context = ?, created_at = datetime('now') WHERE id = ?")
          .run(context || t.context, t.id);
        return t.id;
      }
    }
    const stmt = this.db.prepare("INSERT INTO open_threads (contact, summary, context) VALUES (?, ?, ?)");
    return stmt.run(contact, summary, context).lastInsertRowid;
  }

  getOpenThreads(contact, limit = 5) {
    return this.db.prepare(
      "SELECT * FROM open_threads WHERE contact = ? AND status = 'open' ORDER BY created_at DESC LIMIT ?"
    ).all(contact, limit);
  }

  resolveThread(threadId) {
    this.db.prepare("UPDATE open_threads SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(threadId);
  }

  resolveThreadsByKeywords(contact, keywords) {
    const threads = this.getOpenThreads(contact);
    const lower = keywords.toLowerCase();
    let resolved = 0;
    for (const t of threads) {
      const tLower = t.summary.toLowerCase();
      const terms = lower.split(/\s+/).filter(w => w.length > 2);
      const hits = terms.filter(w => tLower.includes(w)).length;
      if (hits >= Math.ceil(terms.length * 0.4)) {
        this.resolveThread(t.id);
        resolved++;
      }
    }
    return resolved;
  }

  // ─── TEACH MODE ───
  saveTeachCommand(contact, commandName, description, triggerPhrase, pipeline) {
    const stmt = this.db.prepare(`
      INSERT INTO taught_commands (contact, command_name, description, trigger_phrase, pipeline)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(contact, commandName, description || null, triggerPhrase.toLowerCase(), JSON.stringify(pipeline));
    return result.lastInsertRowid;
  }

  getTeachCommands(contact) {
    return this.db.prepare(
      'SELECT * FROM taught_commands WHERE contact = ? AND enabled = 1 ORDER BY created_at DESC'
    ).all(contact);
  }

  matchTeachCommand(contact, message) {
    const commands = this.db.prepare(
      'SELECT * FROM taught_commands WHERE contact = ? AND enabled = 1'
    ).all(contact);
    const lower = message.toLowerCase().trim();
    for (const cmd of commands) {
      if (lower === cmd.trigger_phrase) return cmd;
    }
    for (const cmd of commands) {
      if (lower.startsWith(cmd.trigger_phrase + ' ') || lower.startsWith(cmd.trigger_phrase + ',')) return cmd;
    }
    return null;
  }

  getTeachCommand(id) {
    return this.db.prepare('SELECT * FROM taught_commands WHERE id = ?').get(id) || null;
  }

  updateTeachCommand(id, updates) {
    const fields = [];
    const values = [];
    if (updates.commandName !== undefined) { fields.push('command_name = ?'); values.push(updates.commandName); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.triggerPhrase !== undefined) { fields.push('trigger_phrase = ?'); values.push(updates.triggerPhrase.toLowerCase()); }
    if (updates.pipeline !== undefined) { fields.push('pipeline = ?'); values.push(JSON.stringify(updates.pipeline)); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
    if (!fields.length) return 0;
    fields.push("updated_at = datetime('now')");
    values.push(id);
    return this.db.prepare(`UPDATE taught_commands SET ${fields.join(', ')} WHERE id = ?`).run(...values).changes;
  }

  deleteTeachCommand(id) {
    return this.db.prepare('DELETE FROM taught_commands WHERE id = ?').run(id).changes;
  }

  recordTeachExecution(id) {
    this.db.prepare(
      "UPDATE taught_commands SET execution_count = execution_count + 1, last_executed = datetime('now') WHERE id = ?"
    ).run(id);
  }

  listTeachCommands(contact) {
    return this.db.prepare(
      'SELECT id, command_name, description, trigger_phrase, enabled, execution_count, last_executed, created_at FROM taught_commands WHERE contact = ? ORDER BY execution_count DESC'
    ).all(contact);
  }

  // ─── AUDIT ───
  audit(action, detail) {
    const stmt = this.db.prepare("INSERT INTO config_audit (action, detail) VALUES (?, ?)");
    stmt.run(action, detail || null);
  }

  // ─── IMPORT LEGACY ───
  importFromJson(memoryJson) {
    const insert = this.db.prepare('INSERT INTO memories (category, content, status, created_at) VALUES (?, ?, ?, ?)');
    const tx = this.db.transaction((data) => {
      for (const cat of ['facts', 'decisions', 'preferences', 'tasks']) {
        const singular = cat.slice(0, -1);
        for (const item of (data[cat] || [])) {
          insert.run(singular, item.content, item.status || null, item.date || new Date().toISOString());
        }
      }
    });
    tx(memoryJson);
  }

  close() {
    this.db.close();
  }
}

module.exports = FavorMemory;
