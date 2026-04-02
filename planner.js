// planner.js — Multi-turn planning engine
// Breaks complex requests into phases, tracks progress per-contact,
// resurfaces incomplete plans when the contact returns

const { stripInjectionPatterns } = require('./utils/sanitize');

class Planner {
  constructor(db) {
    this.db = db;
    this._ensureTable();
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        title TEXT NOT NULL,
        phases TEXT NOT NULL,
        current_phase INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  // Create a new plan from a list of phases
  // phases: [{ title: string, description: string, status: 'pending' }]
  create(contact, title, phases) {
    const stmt = this.db.prepare(
      `INSERT INTO plans (contact, title, phases) VALUES (?, ?, ?)`
    );
    const result = stmt.run(contact, title, JSON.stringify(phases));
    console.log(`[PLANNER] Created plan #${result.lastInsertRowid}: "${title}" (${phases.length} phases)`);
    return result.lastInsertRowid;
  }

  // Get the active plan for a contact (most recent active plan)
  getActive(contact) {
    const row = this.db.prepare(
      `SELECT * FROM plans WHERE contact = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
    ).get(contact);
    if (!row) return null;
    return { ...row, phases: JSON.parse(row.phases) };
  }

  // Update a phase's status and optionally add a result note
  updatePhase(planId, phaseIndex, status, note) {
    const plan = this.db.prepare(`SELECT * FROM plans WHERE id = ?`).get(planId);
    if (!plan) return false;
    const phases = JSON.parse(plan.phases);
    if (phaseIndex < 0 || phaseIndex >= phases.length) return false;

    phases[phaseIndex].status = status;
    if (note) phases[phaseIndex].result = note;

    // Auto-advance current_phase to next pending phase
    let nextPhase = plan.current_phase;
    if (status === 'done') {
      for (let i = phaseIndex + 1; i < phases.length; i++) {
        if (phases[i].status === 'pending') { nextPhase = i; break; }
      }
    }

    // Check if all phases are done
    const allDone = phases.every(p => p.status === 'done' || p.status === 'skipped');
    const newStatus = allDone ? 'completed' : 'active';

    this.db.prepare(
      `UPDATE plans SET phases = ?, current_phase = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(phases), nextPhase, newStatus, planId);

    if (allDone) console.log(`[PLANNER] Plan #${planId} completed!`);
    return true;
  }

  // Sanitize a string for safe prompt injection — uses the full sanitizer
  static _sanitize(text) {
    if (!text || typeof text !== 'string') return text || '';
    return stripInjectionPatterns(text);
  }

  // Get plan context string for injection into system prompt
  getPlanContext(contact) {
    const plan = this.getActive(contact);
    if (!plan) return '';

    const safeTitle = Planner._sanitize(plan.title);
    const phaseList = plan.phases.map((p, i) => {
      const marker = p.status === 'done' ? '✓' : p.status === 'in_progress' ? '→' : '○';
      const result = p.result ? ` (${Planner._sanitize(p.result)})` : '';
      return `  ${marker} ${i + 1}. ${Planner._sanitize(p.title)}${result}`;
    }).join('\n');

    return `\n=== ACTIVE PLAN: ${safeTitle} ===\n` +
      `Status: Phase ${plan.current_phase + 1} of ${plan.phases.length}\n` +
      `${phaseList}\n` +
      `Current focus: ${Planner._sanitize(plan.phases[plan.current_phase]?.title) || 'all done'}\n` +
      `=== END PLAN ===\n`;
  }

  // Mark a plan as abandoned
  abandon(planId) {
    this.db.prepare(
      `UPDATE plans SET status = 'abandoned', updated_at = datetime('now') WHERE id = ?`
    ).run(planId);
  }

  // Get recent plans for a contact (for /plans command)
  getRecent(contact, limit = 5) {
    const rows = this.db.prepare(
      `SELECT * FROM plans WHERE contact = ? ORDER BY id DESC LIMIT ?`
    ).all(contact, limit);
    return rows.map(r => ({ ...r, phases: JSON.parse(r.phases) }));
  }

  // Prune old completed/abandoned plans (keep 30 days)
  prune() {
    try {
      this.db.exec(`DELETE FROM plans WHERE status IN ('completed','abandoned') AND updated_at < datetime('now', '-30 days')`);
    } catch (_) {}
  }
}

// Keywords that suggest a planning request (multi-step, sequential)
Planner.PLAN_KEYWORDS = /\b(plan|organize|schedule|coordinate|prepare|arrange|set up a (trip|event|project|meeting|workflow)|step.by.step|multi.step|break.{0,5}down|phases?|roadmap|itinerary)\b/i;

module.exports = Planner;
