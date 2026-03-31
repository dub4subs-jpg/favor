// ─── FAVOR CRON ENGINE ───
// Checks for due crons every 30s, executes tasks, supports proactive outreach

class CronEngine {
  constructor(db, opts = {}) {
    this.db = db;
    this.checkInterval = opts.checkIntervalMs || 30000;
    this.onTrigger = opts.onTrigger || null; // async (cron) => {}
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[CRON] Engine started (checking every ${this.checkInterval / 1000}s)`);
    this.db.audit('cron.start', `interval: ${this.checkInterval}ms`);

    // Initial check after 10s (let WhatsApp connect first)
    setTimeout(() => this._tick(), 10000);
    this.timer = setInterval(() => this._tick(), this.checkInterval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.running = false;
    console.log('[CRON] Engine stopped');
  }

  async _tick() {
    try {
      const due = this.db.getDueCrons();
      if (!due.length) return;

      for (const cron of due) {
        console.log(`[CRON] Firing: "${cron.label}" -> ${cron.task.substring(0, 60)}`);
        this.db.audit('cron.fire', `id=${cron.id} label="${cron.label}"`);

        try {
          if (this.onTrigger) {
            await this.onTrigger(cron);
          }
          // Update last_run and calculate next_run
          this.db.updateCronRun(cron.id, cron.schedule);
        } catch (err) {
          console.error(`[CRON] Error executing "${cron.label}":`, err.message);
          this.db.audit('cron.error', `id=${cron.id} error="${err.message}"`);
          // Still advance next_run to avoid infinite retry
          this.db.updateCronRun(cron.id, cron.schedule);
        }
      }
    } catch (err) {
      console.error('[CRON] Tick error:', err.message);
    }
  }

  // Create common proactive outreach crons
  static createMorningBriefing(db, contact, time = '09:00') {
    return db.createCron(
      contact,
      'Morning Briefing',
      `daily ${time}`,
      JSON.stringify({
        type: 'proactive',
        prompt: 'Give your operator a morning briefing. Check pending tasks, upcoming deadlines, and anything important from memory. Keep it brief. Start with a greeting that fits the time of day.'
      })
    );
  }

  static createTaskReminder(db, contact) {
    return db.createCron(
      contact,
      'Task Check-in',
      'every 4h',
      JSON.stringify({
        type: 'proactive',
        prompt: 'Check if there are any pending tasks in memory. If there are overdue or important ones, send a gentle nudge to your operator about them. If nothing is pending, skip this message entirely — return SKIP.'
      })
    );
  }

  static createWeeklyReview(db, contact, day = 'fri', time = '17:00') {
    return db.createCron(
      contact,
      'Weekly Review',
      `weekly ${day} ${time}`,
      JSON.stringify({
        type: 'proactive',
        prompt: 'Give your operator a weekly review. Summarize what was accomplished this week based on memory — tasks completed, decisions made, new facts learned. Celebrate wins. Suggest focus areas for next week.'
      })
    );
  }
}

module.exports = CronEngine;
