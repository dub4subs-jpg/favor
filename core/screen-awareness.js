// ─── SCREEN AWARENESS ENGINE (Filmstrip Mode) ───
// Captures screenshots periodically, batches into filmstrips for analysis.
// Flags important insights to operator, silently learns workflow patterns.

const fs = require('fs');
const path = require('path');

class ScreenAwareness {
  constructor({ config, db, sock, captureScreenshotBuffer, runClaudeCLI, getEmbedding, isLaptopOnline, PLATFORM, botDir }) {
    this.config = config;
    this.db = db;
    this.sock = sock;
    this.captureScreenshotBuffer = captureScreenshotBuffer;
    this.runClaudeCLI = runClaudeCLI;
    this.getEmbedding = getEmbedding;
    this.isLaptopOnline = isLaptopOnline;
    this.PLATFORM = PLATFORM;
    this.botDir = botDir;

    // State
    this.timer = null;
    this.active = false;
    this.tickCount = 0;
    this.awaitingContinue = false;
    this.tickInProgress = false;
    this.lastContext = '';
    this.frameBuffer = [];
    this.workflowLog = [];
    this.startTime = 0;

    // Constants
    this.CAPTURE_MS = 2000;
    this.FRAMES_PER_BATCH = 3;
    this.CHECKIN_AFTER = 60000;
  }

  setSock(sock) { this.sock = sock; }
  updateConfig(config) { this.config = config; }
  isActive() { return this.active; }
  isAwaitingContinue() { return this.awaitingContinue; }

  start() {
    if (this.active) return;
    this.active = true;
    this.tickCount = 0;
    this.awaitingContinue = false;
    this.tickInProgress = false;
    this.lastContext = '';
    this.frameBuffer = [];
    this.workflowLog = [];
    this.startTime = Date.now();
    console.log('[SCREEN] Screen awareness ON (filmstrip mode)');
    this._loop();
  }

  async stop() {
    this.active = false;
    this.awaitingContinue = false;
    this.frameBuffer = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.workflowLog.length > 0) {
      try { await this._saveWorkflowSession(); }
      catch (e) { console.error('[SCREEN] Failed to save workflow:', e.message); }
    }
    console.log('[SCREEN] Screen awareness OFF');
  }

  resume() {
    if (!this.active || !this.awaitingContinue) return;
    this.awaitingContinue = false;
    this.tickCount = 0;
    this.startTime = Date.now();
    this.frameBuffer = [];
    console.log('[SCREEN] Resumed — next check-in in 60s');
    this._loop();
  }

  _getOperatorJid() {
    return this.PLATFORM === 'telegram'
      ? `tg_${this.config.telegram?.operatorChatId || ''}`
      : (this.config.whatsapp.operatorNumber || '').replace('+', '') + '@s.whatsapp.net';
  }

  async _loop() {
    if (!this.active) return;
    if (this.tickInProgress) return;
    const operatorJid = this._getOperatorJid();

    if ((Date.now() - this.startTime) >= this.CHECKIN_AFTER && !this.awaitingContinue) {
      this.awaitingContinue = true;
      const batchesDone = Math.floor(this.tickCount / this.FRAMES_PER_BATCH);
      await this.sock.sendMessage(operatorJid, { text: `*[Screen Awareness]*\nBeen watching for 1 minute (${this.tickCount} captures, ${batchesDone} analyses). Should I keep going?\n\nReply *"keep going"* or *"stop"*` });
      console.log(`[SCREEN] Check-in sent after ${this.tickCount} captures — waiting for response`);
      return;
    }

    this.tickInProgress = true;
    try { await this._captureTick(); }
    catch (err) { console.error('[SCREEN] Tick error:', err.message); }
    this.tickInProgress = false;

    this.tickCount++;
    if (this.active && !this.awaitingContinue) {
      this.timer = setTimeout(() => this._loop(), this.CAPTURE_MS);
    }
  }

  async _captureTick() {
    if (!this.sock || !this.config.laptop?.enabled) return;
    const online = await this.isLaptopOnline();
    if (!online) { console.log('[SCREEN] Laptop offline — skipping'); return; }

    const result = await this.captureScreenshotBuffer();
    if (!result) { console.log('[SCREEN] Screenshot failed — skipping'); return; }

    this.frameBuffer.push({ buffer: result.buffer, time: `${result.dateStr} ${result.timeStr.replace(/-/g, ':')}` });
    console.log(`[SCREEN] Frame ${this.frameBuffer.length}/${this.FRAMES_PER_BATCH} captured`);

    if (this.frameBuffer.length >= this.FRAMES_PER_BATCH) {
      await this._analyzeBatch();
    }
  }

  async _analyzeBatch() {
    const frames = [...this.frameBuffer];
    this.frameBuffer = [];
    const operatorJid = this._getOperatorJid();

    const tmpFramePaths = [];
    for (let i = 0; i < frames.length; i++) {
      const tmpPath = `/tmp/screen_frame_${Date.now()}_${i}.png`;
      fs.writeFileSync(tmpPath, frames[i].buffer);
      tmpFramePaths.push(tmpPath);
    }

    const prompt = `Read the screenshot image files listed below, then analyze them. These are ${tmpFramePaths.length} sequential screenshots taken 2 seconds apart.

Image files to read:
${tmpFramePaths.map((p, i) => `- Frame ${i + 1}: ${p}`).join('\n')}

You have TWO jobs:

**JOB 1 — FLAG:** Actionable insight ONLY if flag-worthy (errors, mistakes, security issues, optimization tips). Otherwise: FLAG: NOTHING

**JOB 2 — WORKFLOW:** What the operator is doing/using — apps, design choices, patterns. If idle/lock screen: WORKFLOW: NOTHING

FORMAT:
FLAG: [insight or NOTHING]
WORKFLOW: [observation or NOTHING]

Be concise. 1-2 sentences per section max. Previous context (avoid repeating): "${this.lastContext}"`;

    let reply = '';
    try {
      reply = await this.runClaudeCLI(prompt, 60000, { allowTools: true }) || '';
    } catch (e) {
      console.warn('[SCREEN] Claude CLI analysis failed:', e.message);
    }

    for (const p of tmpFramePaths) { try { fs.unlinkSync(p); } catch {} }

    const flagMatch = reply.match(/FLAG:\s*(.+?)(?:\n|$)/i);
    const workflowMatch = reply.match(/WORKFLOW:\s*(.+?)(?:\n|$)/i);
    const flagText = flagMatch?.[1]?.trim() || '';
    const workflowText = workflowMatch?.[1]?.trim() || '';

    if (flagText && !flagText.includes('NOTHING') && flagText.length > 5) {
      const latestFrame = frames[frames.length - 1];
      await this.sock.sendMessage(operatorJid, { image: latestFrame.buffer, caption: `*[Screen Awareness]*\n${flagText}` });
      this.lastContext = flagText.substring(0, 200);
      console.log(`[SCREEN] FLAGGED — sent insight + screenshot (${flagText.length} chars)`);
    } else {
      console.log('[SCREEN] Nothing flag-worthy — trashed batch');
    }

    if (workflowText && !workflowText.includes('NOTHING') && workflowText.length > 5) {
      this.workflowLog.push(workflowText);
      console.log(`[SCREEN] LEARNED — ${workflowText.substring(0, 80)}...`);
    }
  }

  async _saveWorkflowSession() {
    const observations = this.workflowLog.join('\n');
    const duration = Math.round((Date.now() - this.startTime) / 1000);
    const now = new Date().toISOString().split('T')[0];

    const prompt = `Analyze this screen monitoring session. Distill into 3-8 bullet points about workflow habits, tools used, design patterns, and skill indicators. Only lasting insights, not one-time observations. If nothing meaningful, respond with: NOTHING_LEARNED

Screen session: ${duration}s, ${this.tickCount} captures, ${this.workflowLog.length} observations.

Raw observations:
${observations}`;
    const summary = await this.runClaudeCLI(prompt, 60000) || '';
    if (summary && !summary.includes('NOTHING_LEARNED')) {
      const memContent = `[Workflow observation ${now}] ${summary}`;
      const memId = this.db.save('workflow', memContent.substring(0, 2000), null);
      this.getEmbedding(memContent.substring(0, 512)).then(emb => this.db.updateEmbedding(memId, emb)).catch(e => console.warn(`[EMBED] Failed:`, e.message));
      console.log(`[SCREEN] Saved workflow observations → memory #${memId}`);
      await ScreenAwareness.updateOperatorProfile(summary, this.botDir);
    } else {
      console.log('[SCREEN] Session too short/idle — nothing new learned');
    }
    this.workflowLog = [];
  }

  // Static: update operator profile knowledge file (also used by tool executor)
  static async updateOperatorProfile(newInsights, botDir) {
    const profilePath = path.join(botDir, 'knowledge', 'operator_profile.md');
    let existing = '';
    try { existing = fs.readFileSync(profilePath, 'utf8'); } catch (_) {}

    if (!existing) {
      existing = `# Operator Profile
## Learned from screen observation, video courses, and interactions.
## The bot uses this to understand your workflow, design style, and preferences.

### Workflow & Habits\n\n### Design Style\n\n### Tools & Software\n\n### Skills & Techniques\n\n### Business Context\n`;
    }

    const now = new Date().toISOString().split('T')[0];
    const updated = existing.trimEnd() + `\n\n---\n**Observed ${now}:**\n${newInsights}\n`;
    fs.writeFileSync(profilePath, updated);
    console.log('[SCREEN] Updated operator profile: knowledge/operator_profile.md');
  }
}

module.exports = ScreenAwareness;
