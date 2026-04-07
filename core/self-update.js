// ─── SELF-UPDATE ───
// Allows the operator to update the bot from WhatsApp.
// Pulls latest from git, syntax checks, restarts, and reports back.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class SelfUpdater {
  constructor(opts = {}) {
    this.botDir = opts.botDir || path.resolve(__dirname, '..');
    this.mainFile = opts.mainFile || 'favor.js';
    this.processName = opts.processName || null; // pm2 process name, auto-detected if null
    this.remote = opts.remote || 'origin';
    this.branch = opts.branch || 'master';
  }

  // Run a shell command safely, return { ok, output }
  _run(cmd, timeoutMs = 30000) {
    try {
      const output = execSync(cmd, {
        cwd: this.botDir,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      }).trim();
      return { ok: true, output };
    } catch (e) {
      return { ok: false, output: (e.stderr || e.message || '').trim() };
    }
  }

  // Detect pm2 process name from ecosystem or running processes
  _detectProcessName() {
    if (this.processName) return this.processName;
    // Check ecosystem.config.js
    const ecoPath = path.join(this.botDir, 'ecosystem.config.js');
    if (fs.existsSync(ecoPath)) {
      try {
        const eco = require(ecoPath);
        if (eco.apps?.[0]?.name) return eco.apps[0].name;
      } catch (_) {}
    }
    // Fallback: look for pm2 process running favor.js
    const { ok, output } = this._run('pm2 jlist 2>/dev/null');
    if (ok) {
      try {
        const procs = JSON.parse(output);
        const match = procs.find(p => p.pm2_env?.pm_exec_path?.endsWith(this.mainFile));
        if (match) return match.name;
      } catch (_) {}
    }
    return null;
  }

  // Get current git commit hash (short)
  _currentCommit() {
    const { ok, output } = this._run('git rev-parse --short HEAD');
    return ok ? output : 'unknown';
  }

  // Check if there are local uncommitted changes
  _hasLocalChanges() {
    const { ok, output } = this._run('git status --porcelain');
    return ok && output.length > 0;
  }

  // Main update flow — returns a status object
  async update() {
    const result = {
      success: false,
      beforeCommit: this._currentCommit(),
      afterCommit: null,
      changelog: [],
      error: null,
      alreadyUpToDate: false,
      stashed: false,
    };

    // Step 1: Stash local changes (protect config.json, data/, etc.)
    if (this._hasLocalChanges()) {
      const stash = this._run('git stash push -m "self-update-backup"');
      if (!stash.ok) {
        result.error = 'Failed to stash local changes: ' + stash.output;
        return result;
      }
      result.stashed = true;
    }

    // Step 2: Fetch latest from remote
    const fetch = this._run(`git fetch ${this.remote} ${this.branch}`, 60000);
    if (!fetch.ok) {
      if (result.stashed) this._run('git stash pop');
      result.error = 'Failed to fetch updates: ' + fetch.output;
      return result;
    }

    // Step 3: Check if there are any new commits
    const behind = this._run(`git rev-list HEAD..${this.remote}/${this.branch} --count`);
    if (behind.ok && behind.output === '0') {
      if (result.stashed) this._run('git stash pop');
      result.alreadyUpToDate = true;
      result.success = true;
      result.afterCommit = result.beforeCommit;
      return result;
    }

    // Step 4: Get changelog before pulling
    const log = this._run(`git log --oneline HEAD..${this.remote}/${this.branch}`);
    if (log.ok && log.output) {
      result.changelog = log.output.split('\n').slice(0, 10);
    }

    // Step 5: Pull the latest code
    const pull = this._run(`git pull ${this.remote} ${this.branch}`, 60000);
    if (!pull.ok) {
      // Abort: reset to pre-pull state
      this._run('git reset --hard HEAD');
      if (result.stashed) this._run('git stash pop');
      result.error = 'Git pull failed: ' + pull.output;
      return result;
    }

    // Step 6: Syntax check BEFORE restoring local changes
    // This way, if syntax fails we can rollback cleanly and stash is still intact
    const check = this._run(`node --check ${this.mainFile}`);
    if (!check.ok) {
      // CRITICAL: syntax error in new code — rollback, stash is still safe
      this._run(`git reset --hard ${result.beforeCommit}`);
      if (result.stashed) this._run('git stash pop');
      result.error = 'Syntax error in new code — rolled back: ' + check.output;
      return result;
    }

    // Step 7: Re-apply stashed changes (config.json etc.)
    if (result.stashed) {
      const pop = this._run('git stash pop');
      if (!pop.ok) {
        // Stash conflict — drop the conflicted pop and re-stash
        this._run('git checkout -- .');
        result.changelog.push('(stash conflict — local changes preserved in git stash, may need manual recovery)');
      }
    }

    // Step 8: Install any new dependencies
    const pkgChanged = result.changelog.some(l => l.includes('package'));
    if (pkgChanged) {
      const install = this._run('npm install --production', 120000);
      if (!install.ok) {
        result.changelog.push('(npm install had warnings — may need manual review)');
      }
    }

    result.afterCommit = this._currentCommit();
    result.success = true;

    // Step 9: Restart via pm2 (if available)
    const processName = this._detectProcessName();
    if (processName) {
      result.processName = processName;
      result.willRestart = true;
      // Don't restart here — caller should send the "updating" message first,
      // then call restartProcess() separately
    } else {
      result.willRestart = false;
      result.changelog.push('(no pm2 process detected — restart manually)');
    }

    return result;
  }

  // Separate restart call — invoke AFTER sending the notification
  restartProcess() {
    const processName = this._detectProcessName();
    if (!processName) return { ok: false, output: 'No pm2 process found' };
    return this._run(`pm2 restart ${processName}`);
  }
}

module.exports = SelfUpdater;
