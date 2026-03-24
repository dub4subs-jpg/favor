// agent-tasks.js — Background Agent Delegation for Favor
// Spawns Claude CLI subprocesses for long-running research tasks
// Reports back via WhatsApp when complete

const { spawn } = require('child_process');

class AgentTasks {
  constructor(opts = {}) {
    this.maxConcurrent = opts.maxConcurrent || 3;
    this.tasks = new Map(); // taskId -> { id, prompt, startTime, contact, status, result, proc }
    this.nextId = 1;
    this.onComplete = opts.onComplete || null; // async (task) => {}
    this.claudeBin = opts.claudeBin || '/root/.local/bin/claude';
    this.claudeEnv = opts.claudeEnv || (() => process.env);
  }

  spawn(prompt, contact, timeoutMs = 300000) {
    if (this._activeCount() >= this.maxConcurrent) {
      return { error: `Max ${this.maxConcurrent} concurrent tasks. Use check_tasks to see running tasks.` };
    }

    const taskId = this.nextId++;
    const task = {
      id: taskId,
      prompt: prompt.substring(0, 200),
      fullPrompt: prompt,
      startTime: Date.now(),
      contact,
      status: 'running',
      result: null,
    };
    this.tasks.set(taskId, task);

    const proc = spawn(this.claudeBin, ['--print', '--model', 'sonnet', '-'], {
      timeout: timeoutMs,
      env: this.claudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', (code) => {
      task.status = 'done';
      task.result = (stdout.trim() || stderr.trim() || '(no output)').substring(0, 4000);
      task.elapsed = Date.now() - task.startTime;
      console.log(`[AGENT] Task #${taskId} completed in ${Math.round(task.elapsed / 1000)}s (${task.result.length} chars)`);

      if (this.onComplete) {
        this.onComplete(task).catch(e => console.error('[AGENT] onComplete error:', e.message));
      }

      // Auto-cleanup after 30 minutes
      setTimeout(() => this.tasks.delete(taskId), 30 * 60 * 1000);
    });

    proc.on('error', (err) => {
      task.status = 'failed';
      task.result = `Error: ${err.message}`;
      console.error(`[AGENT] Task #${taskId} failed:`, err.message);
    });

    // Write prompt to stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    console.log(`[AGENT] Spawned task #${taskId}: ${task.prompt}`);
    return { taskId, message: `Background task #${taskId} started. I'll message you when it's done.` };
  }

  list() {
    return [...this.tasks.values()].map(t => ({
      id: t.id,
      prompt: t.prompt,
      status: t.status,
      elapsed: Math.round((Date.now() - t.startTime) / 1000),
      resultPreview: t.result ? t.result.substring(0, 100) : null,
    }));
  }

  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  _activeCount() {
    return [...this.tasks.values()].filter(t => t.status === 'running').length;
  }
}

module.exports = AgentTasks;
