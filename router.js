// router.js — Decision Router + Multi-Brain Orchestration Layer for Favor
// Classifies each request and routes to the most efficient execution path

const { execFile, spawn } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// ─── CLAUDE CLI AUTO-DETECTION ───
// Finds Claude Code CLI wherever it's installed (not just /root/.local/bin)
const { execSync } = require('child_process');
let CLAUDE_BIN = null;
let CLAUDE_AVAILABLE = false;
let _claudeTipSent = false;

function detectClaudeCLI() {
  // Check common install locations + PATH
  const candidates = [
    process.env.CLAUDE_BIN,                    // explicit override via env
    '/root/.local/bin/claude',                 // default Linux install
    '/usr/local/bin/claude',                   // system-wide install
    '/home/' + (process.env.USER || 'root') + '/.local/bin/claude',
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      const fs = require('fs');
      if (fs.existsSync(bin)) {
        CLAUDE_BIN = bin;
        CLAUDE_AVAILABLE = true;
        console.log(`[ROUTER] Claude Code CLI found: ${bin}`);
        return;
      }
    } catch {}
  }

  // Last resort: check PATH
  try {
    const which = execSync('which claude 2>/dev/null', { encoding: 'utf8' }).trim();
    if (which) {
      CLAUDE_BIN = which;
      CLAUDE_AVAILABLE = true;
      console.log(`[ROUTER] Claude Code CLI found in PATH: ${which}`);
      return;
    }
  } catch {}

  console.warn('[ROUTER] Claude Code CLI not found — claude/chat/mini routes will fall back to GPT-4o.');
  console.warn('[ROUTER] Install it for better responses: curl -fsSL https://claude.ai/install.sh | sh');
}
detectClaudeCLI();

// Strip ANTHROPIC_API_KEY so Claude CLI uses Max subscription, not API key
function claudeEnv() {
  const binDir = CLAUDE_BIN ? require('path').dirname(CLAUDE_BIN) : '/root/.local/bin';
  return Object.fromEntries(
    Object.entries({ ...process.env, PATH: `${binDir}:${process.env.PATH}` })
      .filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ANTHROPIC_REUSE') && k !== 'ANTHROPIC_API_KEY')
  );
}

// ─── ROUTE DEFINITIONS ───
// tool    → direct tool execution, minimal/no model reasoning needed
// memory  → fetch memory first, then respond
// chat    → casual conversation → Claude CLI (free via Max subscription)
// mini    → lightweight tasks (summarize, extract, format, simple Q&A) → Claude CLI with haiku
// claude  → engineering/code task → Claude CLI subprocess
// gemini  → large document analysis, research aggregation, long-context tasks
// kimi    → structured artifact production (slides, reports, spreadsheets, formatted docs, batch work)
// agent   → queue to favor-runner background agents
// full    → gpt-4o for high-stakes reasoning (default)
// hybrid  → tool + model together

const ROUTE_DESCRIPTIONS = `
tool: Direct action via laptop/system tools (open app, run command, check status, send email, create invoice, list files, fetch URL, vault list, browser status, build software projects via Claude Code)
memory: User asking about something previously discussed, stored facts, preferences, or past decisions
chat: Casual conversation, greetings, banter, personal talk, jokes, chitchat, venting, emotional support, life updates, opinions, small talk, "how are you", "what's up", "good morning", daily check-ins. PREFER chat for all non-task conversational messages.
mini: Simple mechanical request (summarize, reformat, extract info, simple factual Q&A, short reply, weather, time, date, convert units, math, define a word, translate, spell check, what day is it)
claude: Any technical or engineering task — code, debugging, scripts, APIs, infrastructure, system design, architecture, technical analysis, error messages, logs, builds, deployments, database queries, performance, security review, code explanation, refactoring. PREFER claude for all code tasks.
gemini: Large-scale document analysis, reading long PDFs, processing datasets, summarizing transcripts, research aggregation, competitor analysis, SEO audits, knowledge extraction — anything needing high-context analysis of large information volumes
kimi: Generating structured business artifacts — slide decks, reports, spreadsheets, formatted documents, data summaries, batch research, multi-step content production, parallel task execution
agent: Long-running background task (research, batch work, multi-step automation, things that take minutes)
full: Non-technical high-stakes reasoning (business strategy, financial decisions, marketing copy, creative writing, complex interpersonal situations, purchasing/booking flows, browsing websites to buy things)
hybrid: Needs both tool execution AND model reasoning (e.g., read a file then analyze it, save/retrieve vault data, browse a website and fill forms)
`.trim();

// ─── KEYWORD OVERRIDES — bypass classifier for obvious cases ───
const TOOL_KEYWORDS = [
  'screenshot', 'screen capture', 'capture my', 'capture the screen',
  'open illustrator', 'open photoshop', 'open app', 'launch app',
  'laptop', 'my computer', 'my pc', 'run command', 'run on my',
  'take a screenshot', 'send me a screenshot', 'show me my screen',
  'close app', 'close illustrator', 'close photoshop',
  'what\'s on my screen', 'what is on my screen',
  'run on droplet', 'run this on droplet', 'run on server', 'run this on server',
  'execute on droplet', 'execute on server', 'run this code on droplet',
  'run this code on server', 'on the droplet', 'on the server',
  'on my desktop', 'on my screen', 'logged in on', 'i\'m on the page',
  'on the page', 'go to the website', 'fill out the form', 'fill the form',
  'click on', 'navigate to', 'open the website', 'browse to',
  // Messaging & email — need send_message / send_email tools
  'message her', 'message him', 'text her', 'text him',
  'send her a', 'send him a', 'send a message', 'send message',
  'ask her', 'ask him', 'tell her', 'tell him',
  // Add your frequent contacts here for instant routing:
  // 'ask john', 'tell john', 'message john', 'text john',
  'reach out to', 'hit up', 'let her know', 'let him know',
  'ping her', 'ping him', 'ping cortana', 'follow up with',
  'email jerry', 'email her', 'email him', 'send email', 'send an email',
  'send the invoice', 'send invoice',
  // Email search/read
  'check my email', 'check email', 'check my inbox', 'search my email', 'search email',
  'any emails', 'new emails', 'unread emails', 'read my email', 'look at my email',
];

const PURCHASE_KEYWORDS = [
  'buy', 'purchase', 'book a flight', 'book flight', 'book me', 'plane ticket',
  'checkout', 'add to cart', 'order', 'shop for', 'buy me',
  'use my card', 'pay for', 'fill in my info', 'autofill',
];

const VAULT_KEYWORDS = [
  'save my card', 'store my card', 'save my address', 'vault', 'my card info',
  'save my info', 'store my info', 'save my details',
];

const VIDEO_KEYWORDS = [
  'watch this', 'learn from this', 'analyze this video', 'what\'s in this video',
  'youtube.com', 'youtu.be', 'tiktok.com', 'twitter.com/i/status',
  'x.com/i/status', 'vimeo.com', 'instagram.com/reel',
];

const UIUX_KEYWORDS = [
  'design system', 'color palette', 'ui style', 'ux style',
  'design a website', 'design a page', 'design a landing page',
  'what style for', 'what colors for', 'what fonts for',
  'glassmorphism', 'neumorphism', 'brutalism', 'minimalism',
  'ui/ux', 'ui ux', 'font pairing', 'typography for',
];

const KIMI_KEYWORDS = [
  'make me a report', 'create a report', 'build a report', 'generate a report',
  'slide deck', 'presentation', 'make slides', 'create slides',
  'spreadsheet', 'make a spreadsheet', 'data summary', 'format this data',
  'create a document', 'write a report', 'batch research',
  'make me a template', 'create a template',
];

const MINI_KEYWORDS = [
  'what time is it', 'what\'s the time', 'what day is it', 'what\'s the date',
  'what\'s today', 'convert', 'how many', 'how much is', 'calculate',
  'define ', 'what does', 'translate', 'spell ', 'celsius', 'fahrenheit',
  'inches to', 'miles to', 'km to', 'pounds to', 'kg to', 'feet to',
  'what\'s the weather', 'weather in', 'temperature in',
];

const GEMINI_KEYWORDS = [
  'analyze this document', 'analyze this pdf', 'read this pdf',
  'summarize this document', 'research report', 'seo audit',
  'competitor analysis', 'analyze this data', 'long document',
];

const REMOTE_KEYWORDS = [
  'start remote', 'remote session', 'remote code', 'start coding',
  'open remote', 'code from phone', 'code on phone', 'remote control',
  'start claude code', 'launch claude code',
];

const SELFCHECK_KEYWORDS = [
  'self check', 'selfcheck', 'self-check', 'system check', 'system status',
  'health report', 'run diagnostics', 'clean up', 'cleanup', 'sanitize',
  'check yourself', 'how are you doing', 'are you healthy',
];

const GUARDIAN_KEYWORDS = [
  'run guardian', 'guardian scan', 'guardian status', 'guardian report',
  'scan the project', 'scan this project',
  'health check', 'health scan', 'audit the code', 'audit this',
  'check for bugs', 'check for issues', 'run a scan', 'security scan',
  'regression check', 'quality check', 'qa scan', 'qa check',
  'is the project healthy', 'any regressions', 'run tests on',
  'api spend', 'rate limit', 'spend limit',
];

const TEACH_KEYWORDS = [
  'teach:', 'teach me', 'teach command', 'teach this',
  'when i say', 'create a command', 'create command',
  'add a shortcut', 'new shortcut', 'save this workflow',
  'my commands', 'list commands', 'delete command', 'remove command',
  'edit command', 'update command', 'disable command', 'enable command',
];

const BUILD_KEYWORDS = [
  'build this', 'build me', 'build mode', 'build a ', 'build an ',
  'create an app', 'create a website', 'create a tool', 'create a script',
  'make me an app', 'make me a website', 'make me a tool',
  'code this', 'code me a', 'develop this', 'develop a ',
  'use claude code to', 'have claude code', 'shell out to claude',
  'start a build', 'start building',
];

function keywordOverride(message) {
  const lower = message.toLowerCase();
  // Catch "ask/tell/message/text/ping [name]" patterns — always needs send_message tool
  if (/\b(ask|tell|message|text|ping|remind|update|notify|email)\s+[a-z]{2,}/.test(lower) && !/\b(me|you|yourself)\b/.test(lower.match(/\b(?:ask|tell|message|text|ping|remind|update|notify|email)\s+([a-z]+)/)?.[1] || '')) {
    return { route: 'tool', escalation_score: 4, needs_review: false, reason: 'keyword override: messaging action detected', classifier_ms: 0 };
  }
  if (TOOL_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'tool', escalation_score: 4, needs_review: false, reason: 'keyword override: laptop/tool action', classifier_ms: 0 };
  }
  if (PURCHASE_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'full', escalation_score: 8, needs_review: true, reason: 'keyword override: purchase/booking flow', classifier_ms: 0 };
  }
  if (VAULT_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'hybrid', escalation_score: 7, needs_review: false, reason: 'keyword override: vault operation', classifier_ms: 0 };
  }
  if (VIDEO_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'full', escalation_score: 5, needs_review: false, reason: 'keyword override: video analysis', classifier_ms: 0 };
  }
  if (UIUX_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'full', escalation_score: 5, needs_review: false, reason: 'keyword override: UI/UX design system', classifier_ms: 0 };
  }
  if (KIMI_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'kimi', escalation_score: 5, needs_review: false, reason: 'keyword override: structured artifact production', classifier_ms: 0 };
  }
  if (MINI_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'mini', escalation_score: 1, needs_review: false, reason: 'keyword override: simple/mechanical task', classifier_ms: 0 };
  }
  if (GEMINI_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'gemini', escalation_score: 5, needs_review: false, reason: 'keyword override: large document analysis', classifier_ms: 0 };
  }
  if (TEACH_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'tool', escalation_score: 5, needs_review: false, reason: 'keyword override: teach mode', classifier_ms: 0 };
  }
  if (BUILD_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'tool', escalation_score: 6, needs_review: false, reason: 'keyword override: build mode activation', classifier_ms: 0 };
  }
  if (GUARDIAN_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'tool', escalation_score: 5, needs_review: false, reason: 'keyword override: guardian scan', classifier_ms: 0 };
  }
  if (REMOTE_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'tool', escalation_score: 3, needs_review: false, reason: 'keyword override: remote code session', classifier_ms: 0 };
  }
  if (SELFCHECK_KEYWORDS.some(kw => lower.includes(kw))) {
    return { route: 'tool', escalation_score: 4, needs_review: false, reason: 'keyword override: self-check', classifier_ms: 0 };
  }
  return null;
}

// ─── CLASSIFIER ───
// Uses Claude CLI for classification (free via Max subscription)
async function classify(openai, message, recentContext = '') {
  // Check keyword overrides first — no API call needed
  const override = keywordOverride(message);
  if (override) return override;

  const start = Date.now();
  try {
    const classifyPrompt = `You are a request router for an AI assistant. Classify the user message into ONE route.

${ROUTE_DESCRIPTIONS}

Escalation scoring (0-10):
0-3: Low complexity, tool or mini
4-6: Medium, mini or full
7-10: High stakes, must use full

Respond ONLY with valid JSON:
{"route":"tool|memory|chat|mini|claude|gemini|kimi|agent|full|hybrid","escalation_score":0,"needs_review":false,"reason":"one line"}

Context (last 300 chars): ${recentContext.slice(-300)}

Message: ${message}`;
    const raw = await runClaudeCLI(classifyPrompt, 20000) || '';
    let decision;
    try {
      decision = JSON.parse(raw);
    } catch {
      const route = raw.match(/"route"\s*:\s*"(\w+)"/)?.[1];
      const score = raw.match(/"escalation_score"\s*:\s*(\d+)/)?.[1];
      const reason = raw.match(/"reason"\s*:\s*"([^"]*)"/)?.[1];
      if (route) {
        decision = { route, escalation_score: parseInt(score || '0'), needs_review: false, reason: reason || 'partial parse recovery' };
      } else {
        throw new Error(`Unparseable classifier response: ${raw.slice(0, 120)}`);
      }
    }
    decision.classifier_ms = Date.now() - start;
    return decision;
  } catch (e) {
    console.warn('[ROUTER] Classification failed, defaulting to chat:', e.message);
    return { route: 'chat', escalation_score: 0, needs_review: false, reason: 'classification error — fallback', classifier_ms: Date.now() - start };
  }
}

// Returns a one-time tip about installing Claude CLI (empty string after first call)
function getClaudeTip() {
  if (CLAUDE_AVAILABLE || _claudeTipSent) return '';
  _claudeTipSent = true;
  return '\n\n💡 *Tip:* Install Claude Code CLI for much better conversations. Run `curl -fsSL https://claude.ai/install.sh | sh` on your server, then `claude login`. Requires a Claude Pro ($20/mo) or Max ($100/mo) subscription.';
}

// ─── CLAUDE CLI EXECUTOR ───
function runClaudeCLI(prompt, timeoutMs = 90000, { imagePath, allowTools, model } = {}) {
  if (!CLAUDE_AVAILABLE) {
    return Promise.reject(new Error('Claude Code CLI not installed'));
  }
  // Use spawn + stdin for long prompts (avoids arg length limits)
  // allowTools: grant Bash+Read so Claude can send messages via localhost:3099 and read images
  // model: optional model override (e.g. 'haiku' for fast/cheap tasks)
  const args = ['--print'];
  if (model) args.push('--model', model);
  if (imagePath || allowTools) args.push('--allowedTools', 'Bash', 'Read');
  args.push('-');
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      timeout: timeoutMs,
      env: claudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', (code) => {
      const out = stdout.trim() || stderr.trim() || '(no output)';
      if (code !== 0 && !stdout.trim()) reject(new Error(stderr.trim() || `exit code ${code}`));
      else resolve(out.substring(0, 1024 * 1024 * 4));
    });
    proc.on('error', reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ─── TELEMETRY LOGGER ───
function logTelemetry(db, data) {
  try {
    // Accept either raw better-sqlite3 instance or FavorMemory wrapper
    const rawDb = (db && typeof db.exec === 'function') ? db : (db && db.db);
    if (!rawDb || typeof rawDb.exec !== 'function') {
      console.warn('[ROUTER] Telemetry skipped: no valid db handle');
      return;
    }
    rawDb.exec(`CREATE TABLE IF NOT EXISTS router_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact TEXT,
      route TEXT,
      escalation_score INTEGER,
      model_used TEXT,
      tools_used TEXT,
      needs_review INTEGER,
      success INTEGER,
      classifier_ms INTEGER,
      total_ms INTEGER,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    rawDb.prepare(`INSERT INTO router_telemetry
      (contact, route, escalation_score, model_used, tools_used, needs_review, success, classifier_ms, total_ms, reason)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      data.contact || '',
      data.route || 'full',
      data.escalation_score || 0,
      data.model_used || 'gpt-4o',
      JSON.stringify(data.tools_used || []),
      data.needs_review ? 1 : 0,
      data.success ? 1 : 0,
      data.classifier_ms || 0,
      data.total_ms || 0,
      data.reason || ''
    );
  } catch (e) {
    console.warn('[ROUTER] Telemetry log failed:', e.message);
  }
}

// ─── KIMI API EXECUTOR (Moonshot / NVIDIA NIM) ───
async function runKimi(prompt, config, costTracker = null) {
  const apiKey = config?.api?.kimiApiKey || process.env.KIMI_API_KEY;
  if (!apiKey) throw new Error('Kimi API key not configured');

  const kimi = new OpenAI({
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKey,
  });

  const response = await kimi.chat.completions.create({
    model: 'moonshotai/kimi-k2-instruct',
    messages: [
      {
        role: 'system',
        content: `You are a structured artifact production specialist. You create well-formatted reports, data summaries, slide outlines, spreadsheet data, and business documents. Be thorough, organized, and professional. Use markdown formatting for structure.`
      },
      { role: 'user', content: prompt }
    ],
    max_tokens: 4096,
    temperature: 0.3,
  });

  if (costTracker) costTracker.logOpenAI(response, 'kimi');
  return response.choices[0]?.message?.content || '(no output)';
}

// ─── GEMINI ANALYST EXECUTOR ───
async function runGeminiAnalyst(prompt, costTracker = null) {
  // Use Claude CLI instead of Gemini — free via Max subscription, better analysis
  try {
    const result = await runClaudeCLI(prompt, 120000);
    return result || '(no output)';
  } catch (e) {
    // Fall back to Gemini if Claude CLI fails
    console.warn('[ROUTER] Claude CLI failed for analyst, falling back to Gemini:', e.message);
    const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = gemini.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
    });
    const result = await model.generateContent(prompt);
    if (costTracker) costTracker.logGemini(result, 'gemini-2.5-flash', 'analyst');
    return result.response.text() || '(no output)';
  }
}

module.exports = { classify, runClaudeCLI, runKimi, runGeminiAnalyst, logTelemetry, isClaudeAvailable: () => CLAUDE_AVAILABLE, getClaudeTip };
