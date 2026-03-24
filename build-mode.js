// build-mode.js — Build Mode skill for Favor
// Shells out to Claude Code CLI to build software projects
// Manages multi-step builds with progress updates via WhatsApp

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLAUDE_BIN = '/root/.local/bin/claude';

// Strip ANTHROPIC_API_KEY so Claude CLI uses Max subscription
function claudeEnv() {
  return Object.fromEntries(
    Object.entries({ ...process.env, PATH: `/root/.local/bin:${process.env.PATH}` })
      .filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ANTHROPIC_REUSE') && k !== 'ANTHROPIC_API_KEY')
  );
}

class BuildMode {
  constructor(db) {
    this.db = db;
    this.activeBuilds = new Map(); // jid -> build state
  }

  // ─── START A BUILD PROJECT ───
  // Asks Claude Code to plan out a project, returns the plan
  async plan(description, workDir, { onProgress, timeoutMs = 120000 } = {}) {
    const prompt = `You are a software architect. The user wants to build the following:

${description}

Working directory: ${workDir}

Create a clear, numbered build plan with phases. For each phase:
- What files to create/modify
- What the phase accomplishes
- Dependencies on other phases

Keep it practical — no enterprise ceremony. Just what needs to be built and in what order.
If the directory already has code, read it first and build on top of it.

Return ONLY the plan as a numbered list. No preamble.`;

    return this._runClaude(prompt, timeoutMs, { allowTools: true, workDir });
  }

  // ─── EXECUTE A BUILD STEP ───
  // Runs a single build task via Claude Code with full tool access
  async execute(task, workDir, { context = '', onProgress, timeoutMs = 180000 } = {}) {
    const prompt = `You are building software in ${workDir}.

${context ? `Project context:\n${context}\n\n` : ''}Current task:
${task}

Rules:
- Write clean, working code. No placeholders or TODOs.
- Create files, install dependencies, whatever is needed.
- If something fails, fix it before moving on.
- Commit after completing the task with a clear message.
- Be concise in your output — just say what you did.`;

    return this._runClaude(prompt, timeoutMs, { allowTools: true, workDir });
  }

  // ─── VERIFY A BUILD ───
  // Has Claude Code review what was built
  async verify(workDir, requirements, { timeoutMs = 120000 } = {}) {
    const prompt = `Review the project in ${workDir}.

Requirements that should be met:
${requirements}

Check:
1. Does the code actually work? Try running it if possible.
2. Are all requirements addressed?
3. Any obvious bugs or missing pieces?

Be direct — list what works and what doesn't.`;

    return this._runClaude(prompt, timeoutMs, { allowTools: true, workDir });
  }

  // ─── RUN RAW CLAUDE CODE ───
  // For freeform build commands
  async raw(prompt, workDir, { timeoutMs = 120000 } = {}) {
    return this._runClaude(prompt, timeoutMs, { allowTools: true, workDir });
  }

  // ─── INTERNAL: Shell out to Claude CLI ───
  _runClaude(prompt, timeoutMs = 120000, { allowTools = false, workDir } = {}) {
    const args = allowTools
      ? ['--print', '--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', '-']
      : ['--print', '-'];

    const opts = {
      timeout: timeoutMs,
      env: claudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (workDir) opts.cwd = workDir;

    return new Promise((resolve, reject) => {
      const proc = spawn(CLAUDE_BIN, args, opts);
      let stdout = '', stderr = '';

      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });

      proc.on('close', (code) => {
        const out = stdout.trim() || stderr.trim() || '(no output)';
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(stderr.trim() || `Claude Code exited with code ${code}`));
        } else {
          // Cap at 4MB to avoid memory issues
          resolve(out.substring(0, 4 * 1024 * 1024));
        }
      });

      proc.on('error', reject);
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  // ─── BUILD STATE MANAGEMENT ───
  getState(jid) {
    return this.activeBuilds.get(jid) || null;
  }

  setState(jid, state) {
    this.activeBuilds.set(jid, { ...state, updatedAt: new Date().toISOString() });
  }

  clearState(jid) {
    this.activeBuilds.delete(jid);
  }
}

module.exports = BuildMode;
