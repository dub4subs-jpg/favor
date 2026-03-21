/**
 * Bot Monitor — Watches favor.log for failure patterns and writes improvement notes
 * Run: node monitor.js (or via pm2)
 * Outputs to /tmp/monitor-notes.log
 */
const fs = require('fs');
const path = require('path');

const LOG_PATH = '/tmp/favor.log';
const NOTES_PATH = '/tmp/monitor-notes.log';
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

// Failure patterns to detect
const PATTERNS = [
  {
    name: 'selector_loop',
    desc: 'Bot trying multiple selectors for the same element',
    regex: /\[TOOL\] browser_(click|evaluate|get_clickables).*?(Select|Assign|Yes|In Use|View Barcode)/,
    threshold: 3, // 3+ attempts = stuck
    window: 60000, // within 60 seconds
    hits: [],
    advice: 'Selector failed repeatedly. Check barcode_skill.md for correct selectors. Use browser_get_clickables first to see what\'s available.'
  },
  {
    name: 'wrong_tool',
    desc: 'Bot using laptop tools when browser tools needed',
    regex: /\[TOOL\] laptop_screenshot.*|laptop_status/,
    context_regex: /browser_|barcode|gs1|gtin|product/,
    threshold: 1,
    window: 30000,
    hits: [],
    recent_context: [],
    advice: 'Used laptop_screenshot during browser task. Should use browser_screenshot instead.'
  },
  {
    name: 'compaction_mid_flow',
    desc: 'Compaction during active browser workflow',
    regex: /\[COMPACT\] Done/,
    context_regex: /browser_(click|type|navigate|evaluate)/,
    threshold: 1,
    window: 120000,
    hits: [],
    recent_context: [],
    advice: 'Compaction fired during active browser workflow. Context may be lost. Consider increasing threshold.'
  },
  {
    name: 'router_failure',
    desc: 'Gemini router JSON parse error',
    regex: /\[ROUTER\] Classification failed.*Unterminated string/,
    threshold: 3,
    window: 300000, // 5 min
    hits: [],
    advice: 'Gemini router keeps returning malformed JSON. Check router.js prompt or switch classifier model.'
  },
  {
    name: 'navigate_loop',
    desc: 'Bot navigating to products page repeatedly without progress',
    regex: /\[BROWSER\] Navigated to:.*product\/my-products/,
    threshold: 3,
    window: 120000,
    hits: [],
    advice: 'Bot navigated to products page 3+ times without making progress. Likely lost context of current step.'
  }
];

function note(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(NOTES_PATH, line);
  console.log(line.trim());
}

function checkPatterns(line, now) {
  for (const p of PATTERNS) {
    // Clean old hits outside window
    p.hits = p.hits.filter(t => now - t < p.window);

    if (p.regex.test(line)) {
      p.hits.push(now);

      // Track context for context-aware patterns
      if (p.recent_context) {
        p.recent_context.push(line);
        if (p.recent_context.length > 20) p.recent_context.shift();
      }

      if (p.hits.length >= p.threshold) {
        note(`⚠️  PATTERN: ${p.name} — ${p.desc}`);
        note(`   ADVICE: ${p.advice}`);
        note(`   TRIGGER: ${line.trim()}`);
        p.hits = []; // Reset after alert
      }
    }

    // Context tracking for patterns that need it
    if (p.context_regex && p.context_regex.test(line)) {
      if (p.recent_context) p.recent_context.push(line);
    }
  }
}

// Stats tracking
let stats = {
  toolCalls: 0,
  toolLoops: 0,
  compactions: 0,
  routerFailures: 0,
  replies: 0,
  startTime: Date.now()
};

function trackStats(line) {
  if (line.includes('[TOOL] ')) stats.toolCalls++;
  if (line.includes('[TOOL-LOOP] Done')) stats.toolLoops++;
  if (line.includes('[COMPACT] Done')) stats.compactions++;
  if (line.includes('Classification failed')) stats.routerFailures++;
  if (line.includes('replied')) stats.replies++;
}

// Write stats every 10 minutes
setInterval(() => {
  const uptime = Math.round((Date.now() - stats.startTime) / 60000);
  note(`📊 STATS (${uptime}min): ${stats.replies} replies, ${stats.toolCalls} tool calls, ${stats.toolLoops} tool loops, ${stats.compactions} compactions, ${stats.routerFailures} router failures`);
}, 600000);

// Watch the log file
note('🔍 Bot Monitor started — watching ' + LOG_PATH);

let fileSize = 0;
try { fileSize = fs.statSync(LOG_PATH).size; } catch(e) {}

// Tail the log
setInterval(() => {
  try {
    const currentSize = fs.statSync(LOG_PATH).size;
    if (currentSize > fileSize) {
      const fd = fs.openSync(LOG_PATH, 'r');
      const buf = Buffer.alloc(currentSize - fileSize);
      fs.readSync(fd, buf, 0, buf.length, fileSize);
      fs.closeSync(fd);
      fileSize = currentSize;

      const lines = buf.toString().split('\n').filter(l => l.trim());
      const now = Date.now();
      for (const line of lines) {
        trackStats(line);
        checkPatterns(line, now);
      }
    } else if (currentSize < fileSize) {
      // Log was rotated
      fileSize = 0;
    }
  } catch(e) {}
}, 2000);
