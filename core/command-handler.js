// ─── COMMAND HANDLER ───
// Handles all /slash commands and screen awareness toggles.
// Returns { handled: boolean, response?: string } for each message.

const fs = require('fs');
const path = require('path');
const Analytics = require('../analytics');

class CommandHandler {
  constructor({
    db, config, sock, syncBot, alive, accessControl,
    getHistory, isLaptopOnline, reloadConfig, loadKnowledge,
    screenAwareness, // { start, stop, resume, isActive, isAwaitingContinue }
    CONFIG_PATH, botDir,
  }) {
    this.db = db;
    this.config = config;
    this.sock = sock;
    this.syncBot = syncBot;
    this.alive = alive;
    this.accessControl = accessControl;
    this.getHistory = getHistory;
    this.isLaptopOnline = isLaptopOnline;
    this.reloadConfig = reloadConfig;
    this.loadKnowledge = loadKnowledge;
    this.screenAwareness = screenAwareness;
    this.CONFIG_PATH = CONFIG_PATH;
    this.botDir = botDir;

    // KNOWLEDGE is reloaded on /reload — store reference
    this._KNOWLEDGE = null;
  }

  setSock(sock) { this.sock = sock; }
  updateConfig(config) { this.config = config; }
  setKnowledge(k) { this._KNOWLEDGE = k; }

  async handle(jid, body, role) {
    if (!body) return { handled: false };
    const cmd = body.toLowerCase();

    // Command access control
    if (cmd.startsWith('/') && !this.accessControl.canUseCommand(role, cmd.split(' ')[0])) {
      await this.sock.sendMessage(jid, { text: 'That command is not available. Type /help to see what you can do.' });
      return { handled: true };
    }

    // Screen awareness toggles
    const sa = this.screenAwareness;
    if (cmd.includes('screen awareness on') || cmd.includes('turn on screen awareness') || cmd.includes('start watching my screen')) {
      sa.start();
      await this.sock.sendMessage(jid, { text: `*Screen Awareness is ON (Filmstrip Mode)*\nCapturing every 2 seconds, analyzing 3 frames at a time — I see what you're *doing*, not just what's on screen.\n\nAfter 1 minute I'll ask if you want me to keep going. Say *"screen awareness off"* or *"stop"* anytime to disable.` });
      return { handled: true };
    }
    if (cmd.includes('screen awareness off') || cmd.includes('turn off screen awareness') || cmd.includes('stop watching my screen') || (cmd === 'stop' && sa.isActive())) {
      sa.stop();
      await this.sock.sendMessage(jid, { text: '*Screen Awareness is OFF*' });
      return { handled: true };
    }
    if ((cmd.includes('keep going') || cmd.includes('yes') || cmd.includes('continue')) && sa.isAwaitingContinue()) {
      await this.sock.sendMessage(jid, { text: '*Continuing screen monitoring.* Next check-in in 1 minute.' });
      sa.resume();
      return { handled: true };
    }

    // /clear
    if (cmd === '/clear') {
      this.db.clearSession(jid);
      await this.sock.sendMessage(jid, { text: 'Conversation cleared. Memories intact.' });
      return { handled: true };
    }

    // /status
    if (cmd === '/status') {
      const counts = this.db.getMemoryCount();
      const { messages } = this.getHistory(jid);
      const kDir = path.resolve(this.botDir, this.config.knowledge.dir);
      const kFiles = fs.existsSync(kDir) ? fs.readdirSync(kDir).filter(f => f.endsWith('.txt') || f.endsWith('.md')) : [];
      const on = await this.isLaptopOnline();
      const threads = this.db.getOpenThreads(jid);
      const total = counts.facts + counts.decisions + counts.preferences + counts.tasks;
      const uptime = process.uptime();
      const hrs = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const cronCount = this.db.getActiveCrons().length;
      const topicCount = this.db.getTopics(jid).length;
      const summaryCount = this.db.getCompactionSummaries(jid).length;
      await this.sock.sendMessage(jid, { text:
        `*${this.config.identity?.name || 'Favor'} — Status*\n` +
        `Model: ${this.config.model.id}\n` +
        `Uptime: ${hrs}h ${mins}m\n` +
        `Messages: ${messages.length}\n` +
        `Knowledge: ${kFiles.length} files\n` +
        `Memories: ${total} (${counts.facts}F ${counts.decisions}D ${counts.preferences}P ${counts.tasks}T)\n` +
        `Topics: ${topicCount} | Crons: ${cronCount} | Compactions: ${summaryCount} | Threads: ${threads.length}\n` +
        `Laptop: ${on ? 'Connected' : 'Offline'}\n` +
        `Screen Awareness: ${this.config.screenAwareness?.enabled ? 'ON' : 'OFF'}\n` +
        `Features: vision, voice, topics, crons, compaction, alive\n` +
        `Alive: ${this.alive ? 'ON' : 'OFF'}\n` +
        `Engine: Favor (Baileys)`
      });
      return { handled: true };
    }

    // /brain
    if (cmd === '/brain') {
      const kDir = path.resolve(this.botDir, this.config.knowledge.dir);
      const kFiles = fs.existsSync(kDir) ? fs.readdirSync(kDir).filter(f => f.endsWith('.txt') || f.endsWith('.md')) : [];
      await this.sock.sendMessage(jid, { text: kFiles.length ? '*Brain:*\n' + kFiles.map(f => '- ' + f).join('\n') : 'No knowledge files.' });
      return { handled: true };
    }

    // /laptop
    if (cmd === '/laptop') {
      const on = await this.isLaptopOnline();
      await this.sock.sendMessage(jid, { text: on ? 'Laptop *online*.' : 'Laptop *offline*. Run tunnel script.' });
      return { handled: true };
    }

    // /memory
    if (cmd === '/memory') {
      const mem = this.db.getAllMemories();
      const lines = [];
      if (mem.facts.length) lines.push(`*Facts (${mem.facts.length}):*\n` + mem.facts.slice(-10).map(f => '- ' + f.content).join('\n'));
      if (mem.decisions.length) lines.push(`*Decisions (${mem.decisions.length}):*\n` + mem.decisions.slice(-10).map(d => '- ' + d.content).join('\n'));
      if (mem.preferences.length) lines.push(`*Preferences (${mem.preferences.length}):*\n` + mem.preferences.slice(-10).map(p => '- ' + p.content).join('\n'));
      if (mem.tasks.length) lines.push(`*Tasks (${mem.tasks.length}):*\n` + mem.tasks.slice(-10).map(t => `- [${t.status || '?'}] ${t.content}`).join('\n'));
      await this.sock.sendMessage(jid, { text: lines.length ? lines.join('\n\n') : 'No memories yet.' });
      return { handled: true };
    }

    // /model <id>
    if (cmd.startsWith('/model')) {
      const parts = body.split(/\s+/);
      if (parts.length < 2) {
        await this.sock.sendMessage(jid, { text: `*Current model:* ${this.config.model.id}\n\nUsage: /model <model-id>` });
        return { handled: true };
      }
      const newModel = parts[1];
      this.config.model.id = newModel;
      fs.writeFileSync(this.CONFIG_PATH, JSON.stringify(this.config, null, 2));
      this.db.audit('model.switch', `Switched to ${newModel}`);
      await this.sock.sendMessage(jid, { text: `Model switched to *${newModel}*` });
      return { handled: true };
    }

    // /reload
    if (cmd === '/reload') {
      const result = this.reloadConfig();
      this._KNOWLEDGE = this.loadKnowledge();
      await this.sock.sendMessage(jid, { text: result.error ? `Reload failed: ${result.error}` : `Config reloaded. Model: ${this.config.model.id}` });
      return { handled: true, knowledgeReloaded: this._KNOWLEDGE };
    }

    // /crons
    if (cmd === '/crons') {
      const crons = this.db.getCrons(jid);
      if (!crons.length) { await this.sock.sendMessage(jid, { text: 'No scheduled tasks.' }); return { handled: true }; }
      const list = crons.map(c => `#${c.id} [${c.enabled ? 'ON' : 'OFF'}] *${c.label}*\n  ${c.schedule} | Next: ${c.next_run || 'N/A'}`).join('\n\n');
      await this.sock.sendMessage(jid, { text: `*Scheduled Tasks:*\n\n${list}` });
      return { handled: true };
    }

    // /topics
    if (cmd === '/topics') {
      const topics = this.db.getTopics(jid);
      if (!topics.length) { await this.sock.sendMessage(jid, { text: 'No topics. All conversation is in the main thread.' }); return { handled: true }; }
      const list = topics.map(t => `${t.active ? '→ ' : '  '}#${t.id} *${t.name}* (${t.updated_at})`).join('\n');
      await this.sock.sendMessage(jid, { text: `*Topics:*\n\n${list}\n\nActive topic has → arrow.` });
      return { handled: true };
    }

    // /sync
    if (cmd === '/sync') {
      const state = this.syncBot.loadState();
      const drift = this.syncBot.detectDrift(state);
      const events = this.syncBot.readRecentEvents(5);
      const recentLines = events.map(e => `[${e.timestamp.slice(11,19)}] ${e.source_agent}: ${e.summary}`).join('\n');
      const driftText = drift.length > 0 ? drift.map(d => `\u26a0 ${d.message}`).join('\n') : 'No drift detected';
      await this.sock.sendMessage(jid, { text:
        `*Memory Sync Status*\n\n` +
        `*Objective:* ${state.current_objective || 'idle'}\n` +
        `*Bot:* ${state.current_agents.bot.status} (${state.current_agents.bot.current_action || 'idle'})\n` +
        `*Claude:* ${state.current_agents.claude.status} (${state.current_agents.claude.current_action || 'idle'})\n` +
        `*Tasks:* ${(state.active_tasks || []).filter(t => t.status !== 'done').length} active\n` +
        `*Blockers:* ${(state.open_blockers || []).length}\n` +
        `*Last updated:* ${state.last_updated_at || 'never'} by ${state.last_updated_by || 'nobody'}\n\n` +
        `*Recent Events:*\n${recentLines || 'None'}\n\n` +
        `*Drift:* ${driftText}`
      });
      return { handled: true };
    }

    // /recover
    if (cmd === '/recover') {
      const recovery = this.syncBot.recover();
      await this.sock.sendMessage(jid, { text:
        `*State Recovery*\n\n` +
        `*Mission:* ${recovery.mission || 'none'}\n` +
        `*Unfinished tasks:* ${recovery.unfinished_tasks.length}\n` +
        `*Last success:* ${recovery.last_successful_action || 'none'}\n` +
        `*Last failure:* ${recovery.last_failed_action || 'none'}\n` +
        `*Blockers:* ${(recovery.open_blockers || []).join(', ') || 'none'}\n` +
        `*Next step:* ${recovery.recommended_next}\n\n` +
        `*Recent events:*\n${recovery.recent_events_summary.slice(-5).join('\n') || 'none'}`
      });
      return { handled: true };
    }

    // /update
    if (cmd === '/update') {
      await this.sock.sendMessage(jid, { text: 'Updating to latest version...' });
      try {
        const { execSync } = require('child_process');
        const dir = this.botDir;
        const localChanges = execSync(`cd ${dir} && git status --porcelain 2>/dev/null | grep -v '??' || true`, { timeout: 10000 }).toString().trim();
        let stashed = false;
        if (localChanges) {
          execSync(`cd ${dir} && git stash push -m "favor-update-$(date +%Y%m%d-%H%M%S)"`, { timeout: 10000 });
          stashed = true;
        }
        const pull = execSync(`cd ${dir} && git pull origin master 2>&1`, { timeout: 30000 }).toString().trim();
        let customStatus = '';
        if (stashed) {
          try {
            execSync(`cd ${dir} && git stash pop`, { timeout: 10000 });
            customStatus = '\n\nYour custom code was preserved.';
          } catch (e) {
            customStatus = '\n\n\u26a0 Merge conflict with your custom code. Run ./update.sh on the server to fix.';
            execSync(`cd ${dir} && git checkout . 2>/dev/null; git stash pop 2>/dev/null || true`, { timeout: 10000 });
          }
        }
        execSync(`cd ${dir} && npm install --silent 2>&1`, { timeout: 60000 });
        await this.sock.sendMessage(jid, { text: `*Update complete.*\n\n${pull}${customStatus}\n\nRestarting...` });
        setTimeout(() => process.exit(0), 2000);
      } catch (err) {
        await this.sock.sendMessage(jid, { text: `Update failed: ${err.message}` });
      }
      return { handled: true };
    }

    // /analytics
    if (cmd.startsWith('/analytics')) {
      try {
        const analytics = new Analytics(this.db);
        const period = cmd.includes('week') ? 'week' : 'day';
        const report = analytics.report(period);
        await this.sock.sendMessage(jid, { text: report });
      } catch (e) {
        await this.sock.sendMessage(jid, { text: `Analytics error: ${e.message}` });
      }
      return { handled: true };
    }

    // /help
    if (cmd === '/help') {
      await this.sock.sendMessage(jid, { text:
        `*${this.config.identity?.name || 'Favor'} — Commands*\n\n` +
        `/status \u2014 System status\n` +
        `/memory \u2014 View memories\n` +
        `/brain \u2014 Knowledge files\n` +
        `/laptop \u2014 Laptop status\n` +
        `/model <id> \u2014 Switch model\n` +
        `/crons \u2014 View scheduled tasks\n` +
        `/topics \u2014 View conversation topics\n` +
        `/sync \u2014 Memory sync status\n` +
        `/recover \u2014 Recover shared state\n` +
        `/reload \u2014 Reload config\n` +
        `/analytics \u2014 Route + cost analytics\n` +
        `/update \u2014 Update to latest version\n` +
        `/clear \u2014 Clear conversation\n` +
        `/help \u2014 This message\n\n` +
        `*Features:* vision, voice notes, topics, scheduled tasks, proactive outreach, smart compaction, memory sync, alive (check-ins + memory callbacks)`
      });
      return { handled: true };
    }

    return { handled: false };
  }
}

module.exports = CommandHandler;
