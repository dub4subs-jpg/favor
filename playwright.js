// playwright.js — Playwright CLI wrapper for advanced browser automation
// Shells out to `playwright-cli` (@playwright/cli) for ref-based element targeting
// Uses accessibility snapshots instead of CSS selectors — more reliable for modern SPAs
//
// Install: npm install -g @playwright/cli
// Docs: https://github.com/anthropics/playwright-cli

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLI = 'playwright-cli';
const DEFAULT_SESSION = 'favor';
const TIMEOUT_MS = 30000;
const SCREENSHOT_DIR = path.join(__dirname, 'data', 'browser_screenshots');

function sanitizeLabel(label) {
  return String(label || 'page').replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 50);
}

function validateUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0') return false;
    if (host === '169.254.169.254' || host.endsWith('.internal')) return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) return false;
    return true;
  } catch { return false; }
}

// Ensure screenshot dir exists
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function run(session, args, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(CLI, ['-s', session, ...args], {
      timeout,
      maxBuffer: 1024 * 1024,
      cwd: __dirname,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        resolve({ ok: false, error: msg.substring(0, 500) });
        return;
      }
      resolve({ ok: true, output: stdout.trim() });
    });
  });
}

class PlaywrightCLI {
  constructor(sessionName) {
    this.session = sessionName || DEFAULT_SESSION;
  }

  // Open browser and navigate to URL
  async navigate(url) {
    if (!validateUrl(url)) return { ok: false, error: 'Invalid or blocked URL. Only http/https to public hosts allowed.' };
    const list = await run(this.session, ['list']);
    const hasSession = list.ok && list.output.includes(this.session);

    if (hasSession) {
      const result = await run(this.session, ['goto', url]);
      if (!result.ok) return result;
      return this._parsePageInfo(result.output, url);
    }

    const result = await run(this.session, ['open', url]);
    if (!result.ok) return result;
    return this._parsePageInfo(result.output, url);
  }

  // Get page snapshot (accessibility tree with element refs)
  async snapshot(element) {
    const args = ['snapshot'];
    if (element) args.push(element);
    const result = await run(this.session, args);
    if (!result.ok) return result;
    return { ok: true, snapshot: result.output };
  }

  // Click element by ref (e.g. "ref=42") or text target
  async click(target) {
    const result = await run(this.session, ['click', target]);
    if (!result.ok) return result;
    return { ok: true, output: result.output };
  }

  // Fill element by ref or selector
  async fill(target, text) {
    const result = await run(this.session, ['fill', target, text]);
    if (!result.ok) return result;
    return { ok: true, output: result.output };
  }

  // Type text (simulates keystrokes, unlike fill which replaces)
  async type(text) {
    const result = await run(this.session, ['type', text]);
    if (!result.ok) return result;
    return { ok: true, output: result.output };
  }

  // Press key (Enter, Tab, Escape, etc.)
  async press(key) {
    const result = await run(this.session, ['press', key]);
    if (!result.ok) return result;
    return { ok: true, output: result.output };
  }

  // Hover over element
  async hover(target) {
    const result = await run(this.session, ['hover', target]);
    if (!result.ok) return result;
    return { ok: true, output: result.output };
  }

  // Select dropdown option
  async select(target, value) {
    const result = await run(this.session, ['select', target, value]);
    if (!result.ok) return result;
    return { ok: true, output: result.output };
  }

  // Take screenshot — returns { path, buffer }
  async screenshot(label = 'page') {
    label = sanitizeLabel(label);
    const result = await run(this.session, ['screenshot']);
    if (!result.ok) return result;

    // playwright-cli outputs [Screenshot](path) format
    const match = result.output.match(/\[Screenshot\]\(([^)]+)\)/);
    if (match) {
      const filePath = path.resolve(__dirname, match[1]);
      if (fs.existsSync(filePath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(SCREENSHOT_DIR, `pw_${label}_${ts}.png`);
        fs.copyFileSync(filePath, dest);
        return { ok: true, path: dest, buffer: fs.readFileSync(dest), filename: path.basename(dest) };
      }
    }

    // Fallback: find most recent screenshot in .playwright-cli/
    const pwDir = path.join(__dirname, '.playwright-cli');
    if (fs.existsSync(pwDir)) {
      const pngs = fs.readdirSync(pwDir)
        .filter(f => f.endsWith('.png'))
        .map(f => ({ name: f, time: fs.statSync(path.join(pwDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      if (pngs.length) {
        const src = path.join(pwDir, pngs[0].name);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(SCREENSHOT_DIR, `pw_${label}_${ts}.png`);
        fs.copyFileSync(src, dest);
        return { ok: true, path: dest, buffer: fs.readFileSync(dest), filename: path.basename(dest) };
      }
    }

    return { ok: false, error: 'Screenshot taken but file not found' };
  }

  // Execute JavaScript on page
  async evaluate(code) {
    const result = await run(this.session, ['eval', code]);
    if (!result.ok) return result;
    return { ok: true, result: result.output };
  }

  // Tab management
  async tabList() {
    const result = await run(this.session, ['tab-list']);
    if (!result.ok) return result;
    return { ok: true, tabs: result.output };
  }

  async tabNew(url) {
    const args = ['tab-new'];
    if (url) args.push(url);
    const result = await run(this.session, args);
    if (!result.ok) return result;
    return { ok: true, output: result.output };
  }

  async tabSelect(index) {
    const result = await run(this.session, ['tab-select', String(index)]);
    if (!result.ok) return result;
    return { ok: true, output: result.output };
  }

  async tabClose(index) {
    const args = ['tab-close'];
    if (index !== undefined) args.push(String(index));
    const result = await run(this.session, args);
    if (!result.ok) return result;
    return { ok: true, output: result.output };
  }

  // Close browser session
  async close() {
    const result = await run(this.session, ['close']);
    return result.ok ? { ok: true } : result;
  }

  // Status / session list
  async status() {
    const result = await run(this.session, ['list']);
    if (!result.ok) return { ok: true, active: false };
    const hasSession = result.output.includes(this.session);
    return { ok: true, active: hasSession, output: result.output };
  }

  // Parse page info from CLI output
  _parsePageInfo(output, fallbackUrl) {
    const titleMatch = output.match(/Page Title:\s*(.+)/);
    const urlMatch = output.match(/Page URL:\s*(.+)/);
    return {
      ok: true,
      title: titleMatch ? titleMatch[1].trim() : '(untitled)',
      url: urlMatch ? urlMatch[1].trim() : fallbackUrl || '',
      output,
    };
  }
}

module.exports = PlaywrightCLI;
