// ─── ALIVE ENGINE ───
// Makes Favor feel alive: proactive personality system
// Add new alive features as modules in this folder
//
// Current modules:
//   checkins.js  — morning/evening check-ins + morning intelligence brief
//   callbacks.js — memory callbacks (resurface forgotten tasks/decisions)
//   insights.js  — proactive situational intelligence (contacts, patterns, business rhythms)
//
// Future modules:
//   voice.js     — voice note replies
//   reactions.js — emoji/sticker reactions
//   streaks.js   — interaction streaks and rituals
//   moods.js     — mood-aware tone shifting

const Checkins = require('./checkins');
const Callbacks = require('./callbacks');
const Insights = require('./insights');

class AliveEngine {
  constructor(db, openai, opts = {}) {
    this.db = db;
    // openai param kept for backward compat but no longer used (Claude CLI instead)
    this.maxTokens = opts.maxTokens || 300;
    this.operatorContact = opts.operatorContact || '';
    this.botName = opts.botName || 'Favor';
    this.buildSystemPrompt = opts.buildSystemPrompt || null;
    this.sock = null;

    // Schedule config (UTC hours)
    this.morningHourUTC = opts.morningHourUTC ?? 14;  // 9 AM EST default
    this.eveningHourUTC = opts.eveningHourUTC ?? 2;   // 9 PM EST default
    this.callbackIntervalHours = opts.callbackIntervalHours ?? 8;
    this.morningBriefEnabled = opts.morningBrief !== false; // default true
    this.notifQueue = opts.notifQueue || null;

    // Initialize modules
    this.checkins = new Checkins(this);
    this.callbacks = new Callbacks(this);
    this.insights = new Insights(this);

    console.log('[ALIVE] Engine initialized');
  }

  setSock(sock) {
    this.sock = sock;
  }

  // ─── REGISTER ALL CRONS (idempotent) ───
  ensureCrons() {
    if (!this.operatorContact) {
      console.warn('[ALIVE] No operator contact — skipping cron registration');
      return { registered: false };
    }

    const existing = this.db.getCrons(this.operatorContact);
    const labels = existing.map(c => c.label);

    const created = [
      ...this.checkins.ensureCrons(labels),
      ...this.callbacks.ensureCrons(labels),
      ...this.insights.ensureCrons(labels),
    ];

    if (created.length) {
      console.log(`[ALIVE] Created crons: ${created.join(', ')}`);
    }

    return { registered: true, created };
  }

  // ─── REMOVE ALL ALIVE CRONS ───
  removeCrons() {
    const existing = this.db.getCrons(this.operatorContact);
    let removed = 0;
    for (const cron of existing) {
      if (cron.label.startsWith('alive:')) {
        this.db.deleteCron(cron.id);
        removed++;
      }
    }
    if (removed) console.log(`[ALIVE] Removed ${removed} alive crons`);
    return { removed };
  }

  // ─── ROUTE TRIGGERS TO MODULES ───
  async handleTrigger(cron, taskData) {
    if (!this.sock) {
      console.warn('[ALIVE] No socket — skipping');
      return;
    }

    switch (taskData.type) {
      case 'alive:checkin':
        return this.checkins.handle(cron, taskData);
      case 'alive:memory_callback':
        return this.callbacks.handle(cron, taskData);
      case 'alive:insights':
        return this.insights.handle(cron, taskData);
      default:
        console.warn(`[ALIVE] Unknown type: ${taskData.type}`);
    }
  }

  // ─── SHARED HELPERS (used by modules) ───
  getSystemPrompt() {
    if (this.buildSystemPrompt) {
      return this.buildSystemPrompt(this.operatorContact);
    }
    return `You are ${this.botName}, a WhatsApp AI companion. Be concise.`;
  }

  toJid(contact) {
    return contact.replace('+', '').replace('@c.us', '').replace('@s.whatsapp.net', '') + '@s.whatsapp.net';
  }
}

module.exports = AliveEngine;
