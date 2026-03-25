// ─── PLATFORM: WhatsApp (Baileys) or Telegram ───
// Baileys is loaded conditionally — only when platform is 'whatsapp' (default)
let makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, downloadMediaMessage, getContentType, fetchLatestBaileysVersion;
const TelegramAdapter = require('./adapters/telegram');
let telegramAdapter = null; // set when platform === 'telegram'
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec, execFile } = require('child_process');
const FavorMemory = require('./db');
const CronEngine = require('./cron');
const Compactor = require('./compactor');
const { classify, runClaudeCLI, runKimi, runGeminiAnalyst, logTelemetry, isClaudeAvailable, getClaudeTip } = require('./router');
const Vault = require('./vault');
const Browser = require('./browser');
const VideoProcessor = require('./video');
const BuildMode = require('./build-mode');
const Guardian = require('./guardian');
const SelfCheck = require('./selfcheck');
const AliveEngine = require('./alive/');
const syncBot = require('./sync');
const memoryBridge = require('./memory-bridge');
const pino = require('pino');

const logger = pino({ level: 'silent' }); // suppress baileys noise

// ─── LOCAL TRANSCRIPTION (faster-whisper via Python, free) ───
function localTranscribe(audioPath, language = 'en') {
  try {
    const { execSync } = require('child_process');
    const result = execSync(
      `python3 ${path.join(__dirname, 'transcribe.py')} "${audioPath}" ${language}`,
      { timeout: 120000, encoding: 'utf8', maxBuffer: 1024 * 1024 }
    ).trim();
    return result || '';
  } catch (e) {
    console.warn('[TRANSCRIBE] Local whisper failed:', e.message);
    return '';
  }
}

// Suppress libsignal session noise (Closing session / Session already closed / Session already open)
const _origInfo = console.info;
const _origWarn = console.warn;
console.info = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('Closing session')) return; _origInfo.apply(console, args); };
console.warn = (...args) => { if (typeof args[0] === 'string' && (args[0].startsWith('Session already') || args[0] === 'Session already open')) return; _origWarn.apply(console, args); };

// ─── CONFIG ───
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = loadConfig();

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { console.error('Failed to load config.json:', e.message); process.exit(1); }
}

function reloadConfig() {
  try {
    const prev = config;
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    db.audit('config.reload', `model: ${config.model.id}`);
    console.log(`[CONFIG] Reloaded. Model: ${config.model.id}`);
    return { changed: prev.model.id !== config.model.id, prev: prev.model.id, current: config.model.id };
  } catch (e) { console.error('[CONFIG] Reload failed:', e.message); return { changed: false, error: e.message }; }
}

fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  const result = reloadConfig();
  if (result.changed) console.log(`[CONFIG] Model switched: ${result.prev} -> ${result.current}`);
});

// ─── PLATFORM DETECTION ───
const PLATFORM = config.platform || 'whatsapp'; // 'whatsapp' or 'telegram'
if (PLATFORM === 'whatsapp') {
  const baileys = require('@whiskeysockets/baileys');
  makeWASocket = baileys.default;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
  DisconnectReason = baileys.DisconnectReason;
  downloadMediaMessage = baileys.downloadMediaMessage;
  getContentType = baileys.getContentType;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  console.log('[PLATFORM] WhatsApp (Baileys)');
} else if (PLATFORM === 'telegram') {
  console.log('[PLATFORM] Telegram');
} else {
  console.error(`[PLATFORM] Unknown platform: ${PLATFORM}. Use 'whatsapp' or 'telegram'.`);
  process.exit(1);
}

// ─── API CLIENTS ───
const OPENAI_API_KEY = config.api?.openaiApiKey || process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.warn('[BOOT] OPENAI_API_KEY not set — running on Claude CLI only (free via Max subscription)'); }
const _openaiRaw = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ─── DATABASE (must init before cost tracker and vault) ───
const dbPath = path.resolve(__dirname, config.memory.dbPath);
const db = new FavorMemory(dbPath);
db.audit('boot', `Favor starting. Model: ${config.model.id}`);

// ─── COST TRACKER ───
const CostTracker = require('./costs');
const costTracker = new CostTracker(db.db);
console.log('[COSTS] API cost tracker initialized');

// Wrap OpenAI client to auto-track costs on every call (if available)
const openai = _openaiRaw ? new Proxy(_openaiRaw, {
  get(target, prop) {
    if (prop === 'chat') {
      return new Proxy(target.chat, {
        get(chatTarget, chatProp) {
          if (chatProp === 'completions') {
            return new Proxy(chatTarget.completions, {
              get(compTarget, compProp) {
                if (compProp === 'create') {
                  return async function(...args) {
                    const response = await compTarget.create.apply(compTarget, args);
                    costTracker.logOpenAI(response, 'chat');
                    return response;
                  };
                }
                return compTarget[compProp];
              }
            });
          }
          return chatTarget[chatProp];
        }
      });
    }
    if (prop === 'embeddings') {
      return new Proxy(target.embeddings, {
        get(embTarget, embProp) {
          if (embProp === 'create') {
            return async function(...args) {
              const response = await embTarget.create.apply(embTarget, args);
              costTracker.logEmbedding(response, 'embeddings');
              return response;
            };
          }
          return embTarget[embProp];
        }
      });
    }
    return target[prop];
  }
}) : null;
// Expose Gemini key for router + compactor (they use @google/generative-ai via process.env)
if (config.api?.geminiApiKey) process.env.GEMINI_API_KEY = config.api.geminiApiKey;

// ─── VAULT (encrypted personal data) ───
let vault = null;
try {
  const vaultSecret = config.vault?.secret || process.env.VAULT_SECRET;
  if (vaultSecret) {
    vault = new Vault(db.db, vaultSecret);
    console.log('[VAULT] Encrypted vault initialized');
  } else {
    console.warn('[VAULT] No vault.secret in config — vault tools disabled');
  }
} catch (e) {
  console.error('[VAULT] Init failed:', e.message);
}

// ─── BROWSER (Puppeteer automation) ───
const browser = new Browser();
console.log('[BROWSER] Puppeteer browser module loaded');

// ─── VIDEO PROCESSOR ───
let videoProcessor = new VideoProcessor(openai);
console.log('[VIDEO] Video processor initialized');

// ─── BUILD MODE (Claude Code for software building) ───
const buildMode = new BuildMode(db);
console.log('[BUILD] Build mode initialized');

// ─── PLUGIN SYSTEM ───
// ─── TOOLS (OpenAI format) — must init before plugins ───
const { TOOLS: _TOOL_DEFS, oaiTool } = require('./core/tool-definitions');
const TOOLS = _TOOL_DEFS;

const PluginLoader = require('./core/plugin-loader');
const pluginLoader = new PluginLoader();
const pluginResult = pluginLoader.load();
if (pluginResult.loaded > 0) {
  // Append plugin tool definitions to the TOOLS array
  TOOLS.push(...pluginLoader.getToolDefinitions());
}

// ─── GUARDIAN (QA / Watchdog + Runtime Guard) ───
let guardian;
try {
  guardian = new Guardian(db, config, {
    dataDir: path.join(__dirname, 'data'),
    onAlert: (alert) => {
      // Will be wired to sock.sendMessage after WhatsApp connects
      if (global._guardianSock && global._guardianOperatorJid) {
        global._guardianSock.sendMessage(global._guardianOperatorJid, {
          text: `🛡️ *Guardian Alert* [${alert.level}]\n${alert.message}`
        }).catch(() => {});
      }
    },
  });
  console.log('[GUARDIAN] QA watchdog + runtime guard initialized');
} catch (e) {
  console.error('[GUARDIAN] Init failed:', e.message);
  guardian = new Guardian(null, config);
}

// ─── SELF-CHECK (health + sanitization) ───
const selfCheck = new SelfCheck(db, config, {
  botDir: __dirname,
  dataDir: path.join(__dirname, 'data'),
});
console.log('[SELFCHECK] Health monitor initialized');

// ─── ALIVE ENGINE (proactive check-ins + memory callbacks) ───
let alive = null;
if (config.alive?.enabled !== false) {
  // Convert local time config to UTC hours (users set local times in config)
  // Default: 9 AM / 9 PM morning/evening, 8h memory callbacks
  const aliveConfig = config.alive || {};
  const morningLocal = aliveConfig.morningCheckin || '09:00';
  const eveningLocal = aliveConfig.eveningCheckin || '21:00';
  const tzOffset = aliveConfig.timezoneOffsetHours ?? -5; // EST default

  const toUTC = (localTime) => {
    const [h, m] = localTime.split(':').map(Number);
    return ((h - tzOffset) + 24) % 24;
  };

  alive = new AliveEngine(db, openai, {
    modelId: config.model.id,
    maxTokens: 300,
    operatorContact: PLATFORM === 'telegram'
      ? `tg_${config.telegram?.operatorChatId || ''}`
      : (config.whatsapp?.operatorNumber?.replace('+', '') || ''),
    botName: config.identity.name || 'Favor',
    morningHourUTC: toUTC(morningLocal),
    eveningHourUTC: toUTC(eveningLocal),
    callbackIntervalHours: aliveConfig.memoryCallbackHours ?? 8,
    buildSystemPrompt: (contact) => buildSystemPrompt(contact),
  });
  console.log('[ALIVE] Proactive personality engine loaded');
} else {
  console.log('[ALIVE] Disabled in config');
}

// Backfill embeddings for any memories saved before semantic search was added
setTimeout(() => backfillEmbeddings().catch(e => console.warn('[MEMORY] Backfill error:', e.message)), 5000);

// Migrate legacy memory.json
const legacyMemory = path.join(__dirname, 'memory.json');
if (fs.existsSync(legacyMemory) && db.getMemoryCount().facts === 0) {
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyMemory, 'utf8'));
    db.importFromJson(legacy);
    console.log('[MEMORY] Imported legacy memory.json into SQLite');
    db.audit('memory.import', 'Imported from memory.json');
  } catch (e) { console.error('[MEMORY] Legacy import failed:', e.message); }
}

// ─── MEMORY SYNC BOT ───
syncBot.init();
memoryBridge.init(db, getEmbedding);

// ─── COMPACTOR ───
const compactor = new Compactor(db, {
  apiKey: OPENAI_API_KEY,
  compactModel: config.compaction?.model || 'gpt-4o-mini',
  threshold: config.compaction?.threshold || 30,
  keepRecent: config.compaction?.keepRecent || 12,
  summaryTokens: config.compaction?.summaryTokens || 512
});

// ─── VERSION-AWARE STARTUP MESSAGE ───
// On first boot after an update, tell the operator what changed in plain language.
// On normal restarts, just confirm online status with the tagline.
function getStartupMessage() {
  const pkg = require('./package.json');
  const version = pkg.version;
  const name = config.identity?.name || 'Favor';
  const tagline = config.identity?.tagline || 'Always in your favor.';

  // Check last known version from DB
  let lastVersion = null;
  try {
    const row = db.db.prepare("SELECT detail FROM config_audit WHERE action = 'version' ORDER BY rowid DESC LIMIT 1").get();
    if (row) lastVersion = row.detail;
  } catch {}

  // Save current version
  try { db.audit('version', version); } catch {}

  // Same version — just confirm online with tagline
  if (lastVersion === version) {
    return `${name} is online. _${tagline}_`;
  }

  // New version — collect ALL "What you can now do" sections between old and new version
  // If user skipped several versions, they see everything they missed
  let whatsNew = '';
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');

    // Split changelog into version blocks: ## [date] vX.Y.Z — Title
    const blocks = raw.split(/(?=^## \[)/m).filter(b => b.startsWith('## ['));

    const collected = [];
    for (const block of blocks) {
      // Extract version from header: ## [2026-03-24] v4.0.0 — Title
      const verMatch = block.match(/^## \[.*?\]\s*v?([\d.]+)/);
      if (!verMatch) continue;
      const blockVersion = verMatch[1];

      // Skip versions the user already had
      if (lastVersion && blockVersion <= lastVersion) break;

      // Extract user-facing bullet points from "What you can now do" section
      const userSection = block.match(/### What you can now do\n([\s\S]*?)(?=\n### |\n## |$)/);
      if (userSection) {
        const bullets = userSection[1].trim()
          .split('\n')
          .filter(line => line.startsWith('- ') || line.startsWith('* '))
          .map(line => line.replace(/^[-*] /, '• ').replace(/\*\*([^*]+)\*\*/g, '*$1*'))
          .join('\n');
        if (bullets) collected.push(bullets);
      } else {
        // Fall back: grab any bullet points from the block
        const bullets = block.split('\n')
          .filter(line => line.startsWith('- ') || line.startsWith('* '))
          .map(line => line.replace(/^[-*] /, '• ').replace(/\*\*([^*]+)\*\*/g, '*$1*'))
          .join('\n');
        if (bullets) collected.push(bullets);
      }
    }

    whatsNew = collected.join('\n').substring(0, 1500);
    if (collected.join('\n').length > 1500) whatsNew += '\n...';
  } catch {}

  const skippedMultiple = lastVersion && version.split('.')[1] - lastVersion.split('.')[1] > 1;
  const header = lastVersion
    ? `${name} updated: v${lastVersion} → v${version}${skippedMultiple ? '\n\nHere\'s everything you missed:' : ''}`
    : `${name} is online! v${version}`;

  if (whatsNew) {
    return `${header}\n\n${whatsNew}\n\n_${tagline}_`;
  }

  return `${header}\n\n_${tagline}_`;
}

// ─── KNOWLEDGE BASE ───
function loadKnowledge() {
  const dir = path.resolve(__dirname, config.knowledge.dir);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return ''; }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt') || f.endsWith('.md'));
  if (!files.length) return '';
  let k = '\n\n=== YOUR KNOWLEDGE BASE (MANDATORY — these define who you are, how you behave, and what you can do. Follow ALL rules and instructions below.) ===\n';
  for (const file of files) {
    k += `\n--- ${file.replace(/\.(txt|md)$/, '').toUpperCase()} ---\n${fs.readFileSync(path.join(dir, file), 'utf8')}\n`;
  }
  console.log(`[KNOWLEDGE] Loaded ${files.length} file(s): ${files.join(', ')}`);
  return k;
}
let KNOWLEDGE = loadKnowledge();

// ─── DYNAMIC KNOWLEDGE: select relevant files instead of all ───
const CORE_KNOWLEDGE_FILES = ['identity.md', 'soul.md', 'agents.md', 'user.md'];
var knowledgeFileContents = {}; // { filename: content }
var knowledgeFileEmbeddings = {}; // { filename: embedding }

function loadKnowledgeFiles() {
  const dir = path.resolve(__dirname, config.knowledge.dir);
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt') || f.endsWith('.md'));
  const contents = {};
  for (const file of files) {
    contents[file] = fs.readFileSync(path.join(dir, file), 'utf8');
  }
  knowledgeFileContents = contents;
  console.log(`[KNOWLEDGE] Indexed ${files.length} file(s) for dynamic selection`);
  return contents;
}

async function embedKnowledgeFiles() {
  if (!openai) {
    console.log('[KNOWLEDGE] Skipping embeddings — no OpenAI client (using keyword matching instead)');
    return;
  }
  for (const [file, content] of Object.entries(knowledgeFileContents)) {
    if (knowledgeFileEmbeddings[file]) continue;
    try {
      knowledgeFileEmbeddings[file] = await getEmbedding(content.slice(0, 512));
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.warn(`[KNOWLEDGE] Failed to embed ${file}:`, e.message);
    }
  }
  console.log(`[KNOWLEDGE] Embedded ${Object.keys(knowledgeFileEmbeddings).length} knowledge files`);
}

function selectRelevantKnowledge(messageText, maxFiles = 5) {
  const selected = new Set(CORE_KNOWLEDGE_FILES.filter(f => knowledgeFileContents[f]));
  if (!messageText || Object.keys(knowledgeFileEmbeddings).length === 0) {
    return Object.keys(knowledgeFileContents);
  }
  const lower = messageText.toLowerCase();
  const fileScores = [];
  for (const [file, content] of Object.entries(knowledgeFileContents)) {
    if (selected.has(file)) continue;
    const fileName = file.replace(/\.(md|txt)$/, '').toLowerCase().replace(/_/g, ' ');
    let score = 0;
    const terms = lower.split(/\s+/).filter(t => t.length > 2);
    for (const term of terms) {
      if (fileName.includes(term)) score += 3;
      if (content.toLowerCase().includes(term)) score += 1;
    }
    fileScores.push({ file, score });
  }
  fileScores.sort((a, b) => b.score - a.score);
  for (const { file, score } of fileScores) {
    if (selected.size >= maxFiles) break;
    if (score > 0) selected.add(file);
  }
  if (selected.size < maxFiles) {
    for (const file of Object.keys(knowledgeFileContents)) {
      if (selected.size >= maxFiles) break;
      selected.add(file);
    }
  }
  return [...selected];
}

function buildDynamicKnowledge(messageText) {
  const files = selectRelevantKnowledge(messageText, 8);
  if (!files.length) return KNOWLEDGE;
  let k = '\n\n=== YOUR KNOWLEDGE BASE (MANDATORY — these define who you are, how you behave, and what you can do. Follow ALL rules and instructions below.) ===\n';
  for (const file of files) {
    if (knowledgeFileContents[file]) {
      k += `\n--- ${file.replace(/\.(txt|md)$/, '').toUpperCase()} ---\n${knowledgeFileContents[file]}\n`;
    }
  }
  const skipped = Object.keys(knowledgeFileContents).length - files.length;
  if (skipped > 0) k += `\n[${skipped} additional knowledge files available — use knowledge_search tool to query them]\n`;
  return k;
}

loadKnowledgeFiles(); // index for dynamic selection
setTimeout(() => embedKnowledgeFiles(), 8000); // embed after startup settles

fs.watch(path.resolve(__dirname, config.knowledge.dir), { persistent: false }, () => {
  KNOWLEDGE = loadKnowledge();
  loadKnowledgeFiles();
  knowledgeFileEmbeddings = {}; // re-embed on change
  setTimeout(() => embedKnowledgeFiles(), 2000);
});

// ─── SEMANTIC MEMORY ───
async function getEmbedding(text) {
  if (!openai) return null; // no OpenAI client — keyword search will be used as fallback
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text.slice(0, 512) });
  return res.data[0].embedding;
}

async function semanticSearch(query) {
  try {
    const qEmb = await getEmbedding(query);
    if (!qEmb) return db.search(query); // no embeddings available — keyword search
    const semantic = db.searchSemantic(qEmb, 8);
    if (semantic.length) return semantic;
    return db.search(query);
  } catch (e) {
    console.warn('[MEMORY] Semantic search failed, falling back to keyword:', e.message);
    return db.search(query);
  }
}

// ─── AUTO-SAVE: extract key findings from research and persist to memory ───
async function autoSaveFindings(question, responseText, source) {
  try {
    const snippet = responseText.substring(0, 3000);
    const prompt = `Extract 1-3 key facts from this research response. Return ONLY a JSON array of concise fact strings (max 200 chars each). Focus on names, conclusions, recommendations, and specific details worth remembering. If nothing worth saving, return [].

Question: ${question.substring(0, 200)}

Response:
${snippet}`;
    const raw = await runClaudeCLI(prompt, 30000) || '[]';
    const facts = JSON.parse(raw.replace(/```json?\n?/g, '').replace(/```/g, ''));
    if (!Array.isArray(facts) || !facts.length) return;
    for (const fact of facts.slice(0, 3)) {
      if (typeof fact !== 'string' || fact.length < 10) continue;
      const memContent = `[${source}] ${fact}`;
      const similar = db.findSimilar('fact', memContent);
      if (similar) continue;
      const memId = db.save('fact', memContent.substring(0, 2000), null);
      getEmbedding(memContent.substring(0, 512)).then(emb => db.updateEmbedding(memId, emb)).catch(() => {});
      console.log(`[AUTO-SAVE] ${source} finding → memory #${memId}: ${fact.substring(0, 80)}`);
    }
  } catch (e) {
    console.warn(`[AUTO-SAVE] ${source} extraction failed:`, e.message);
  }
}

// ─── AUTO-RECALL: fetch relevant memories for incoming message ───
async function autoRecallMemories(messageText) {
  if (!messageText || messageText.length < 5) return [];
  try {
    const qEmb = await getEmbedding(messageText.slice(0, 512));
    const results = db.searchSemantic(qEmb, 10);
    // Only include memories with high relevance (score > 0.3)
    return results.filter(r => r.score > 0.3);
  } catch (e) {
    // Fast keyword fallback
    return db.search(messageText.split(/\s+/).slice(0, 5).join(' ')).slice(0, 5);
  }
}

async function backfillEmbeddings() {
  if (!openai) return; // skip when running on Claude CLI only
  const missing = db.getWithoutEmbeddings();
  if (!missing.length) return;
  console.log(`[MEMORY] Backfilling embeddings for ${missing.length} memories...`);
  let count = 0;
  for (const row of missing) {
    try {
      const emb = await getEmbedding(row.content);
      db.updateEmbedding(row.id, emb);
      count++;
      await new Promise(r => setTimeout(r, 500)); // rate limit — avoid 429 bursts
    } catch (e) {
      console.warn('[MEMORY] Backfill failed for id', row.id, e.message);
      if (e.message?.includes('429')) {
        console.log('[MEMORY] Rate limited — pausing backfill, will retry next restart');
        break;
      }
    }
  }
  console.log(`[MEMORY] Backfill complete: ${count}/${missing.length} embedded.`);
}

// ─── THREAD TRACKING (follow-up awareness) ───
async function detectAndTrackThreads(contact, userMessage, assistantReply) {
  if (!userMessage || userMessage.length < 10) return;
  // Skip commands
  if (userMessage.startsWith('/')) return;

  try {
    // First: resolve any threads that this exchange addressed
    db.resolveThreadsByKeywords(contact, userMessage + ' ' + assistantReply);

    // Then: detect if there are new unresolved topics
    const combined = `User: ${userMessage}\nAssistant: ${assistantReply}`;
    if (combined.length < 30) return;

    const threadPrompt = `You detect unresolved conversation threads — things the user mentioned, asked about, or started discussing that didn't get fully resolved in this exchange.

Return JSON: {"threads": ["short description", ...]}
Each thread should be under 15 words. Return {"threads": []} if everything was resolved or it's just casual chat. MAX 2 items. Respond ONLY with valid JSON, no other text.

Detect open threads:

${combined.substring(0, 2000)}`;
    const raw = await runClaudeCLI(threadPrompt, 20000) || '{"threads":[]}';
    let threads;
    try { threads = JSON.parse(raw).threads || []; } catch { threads = []; }

    if (Array.isArray(threads)) {
      for (const thread of threads.slice(0, 2)) {
        if (typeof thread === 'string' && thread.length > 5) {
          db.saveThread(contact, thread, userMessage.substring(0, 200));
          console.log(`[THREADS] Saved: "${thread}"`);
        }
      }
    }
  } catch (e) {
    console.warn('[THREADS] Detection error:', e.message);
  }
}

// ─── LAPTOP CONTROL ───
function laptopExec(command, opts = {}) {
  if (!config.laptop.enabled) return Promise.resolve({ ok: false, output: 'Laptop access disabled.' });
  return new Promise((resolve) => {
    // Use execFile (not exec) so args are never interpolated by the local shell.
    // StrictHostKeyChecking=accept-new: trust on first connect, reject changed keys after.
    const args = [
      '-o', `ConnectTimeout=${Math.floor(config.laptop.connectTimeout / 1000)}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(config.laptop.port),
      `${config.laptop.user}@${config.laptop.host}`,
      command,
    ];
    const execOpts = { timeout: config.laptop.execTimeout };
    if (opts.stdin != null) execOpts.input = opts.stdin;
    execFile('ssh', args, execOpts, (err, stdout, stderr) => {
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (err) {
        if (err.message.includes('Connection refused') || err.message.includes('timed out'))
          resolve({ ok: false, output: 'Laptop is not connected.' });
        else resolve({ ok: false, output: combined || err.message });
      } else resolve({ ok: true, output: combined || '(no output)' });
    });
  });
}
async function isLaptopOnline() { const r = await laptopExec('echo online'); return r.ok && r.output === 'online'; }

// ─── VOICE TRANSCRIPTION ───
async function transcribeVoice(audioBuffer, mimetype) {
  const openaiKey = config.api?.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;

  try {
    const ext = mimetype?.includes('ogg') ? 'ogg' : mimetype?.includes('mp4') ? 'mp4' : 'webm';
    const tmpPath = path.join(__dirname, 'data', `voice_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, audioBuffer);

    const result = await new Promise((resolve) => {
      exec(
        `curl -s -X POST https://api.openai.com/v1/audio/transcriptions -H "Authorization: Bearer ${openaiKey}" -F "file=@${tmpPath}" -F "model=whisper-1" -F "response_format=text"`,
        { timeout: 30000 },
        (err, stdout) => {
          try { fs.unlinkSync(tmpPath); } catch (_) {}
          if (err) resolve(null);
          else resolve(stdout?.trim() || null);
        }
      );
    });
    return result;
  } catch (e) {
    console.error('[VOICE] Transcription error:', e.message);
    return null;
  }
}

// TOOLS and oaiTool already loaded above (before plugin loader)
// Instance-specific tools can be appended: TOOLS.push(oaiTool(...))
// All core definitions are in core/tool-definitions.js

// ─── PROMPT INJECTION DEFENSE ───
// Centralized sanitizer for ALL untrusted external content
const { sanitizeExternalInput, stripInjectionPatterns } = require('./utils/sanitize');

// Backward-compatible wrapper — existing code calls sanitizeBrowserOutput()
function sanitizeBrowserOutput(text) {
  return stripInjectionPatterns(text);
}

// Track last tool source to detect chained injection attacks
let lastToolWasBrowser = false;
let lastReceivedImage = null; // { buffer: Buffer, mimetype: string } — for forwarding via send_image
const SENSITIVE_TOOLS = new Set(['vault_get', 'vault_save', 'vault_delete', 'send_message', 'send_image', 'send_email', 'browser_fill_from_vault', 'server_exec', 'write_file', 'laptop_run_command', 'laptop_write_file']);

// ─── SCREENSHOT CAPTURE HELPER (reused by laptop_screenshot tool + screen awareness) ───
let screenshotInProgress = false;
async function captureScreenshotBuffer() {
  if (screenshotInProgress) return null;
  screenshotInProgress = true;
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');

    const envRes = await laptopExec(`powershell -Command "$env:USERPROFILE + '|' + $env:TEMP"`);
    if (!envRes.ok) return null;
    const [userProfile, tempDir] = envRes.output.trim().split('|');

    const dayDir = `${userProfile}\\Favor\\Screenshots\\${dateStr}`;
    const remotePath = `${dayDir}\\${timeStr}.png`;
    const scriptPath = `${tempDir}\\favor_shot.ps1`;
    const doneFlag = `${tempDir}\\favor_shot_done.txt`;

    await laptopExec(`powershell -Command "New-Item -ItemType Directory -Force -Path '${dayDir}' | Out-Null; Remove-Item '${doneFlag}' -Force -ErrorAction SilentlyContinue; Remove-Item '${doneFlag}.err' -Force -ErrorAction SilentlyContinue"`);

    const psContent = [
      `Add-Type -TypeDefinition @"`,
      `using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;`,
      `public class GdiCapture {`,
      `  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();`,
      `  [DllImport("user32.dll")] static extern IntPtr GetWindowDC(IntPtr h);`,
      `  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d,int x,int y,int w,int h,IntPtr s,int sx,int sy,uint op);`,
      `  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr h);`,
      `  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr h,int w,int ht);`,
      `  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr h,IntPtr o);`,
      `  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h,IntPtr dc);`,
      `  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr h);`,
      `  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);`,
      `  [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);`,
      `  public static void Capture(string path) {`,
      `    int w=GetSystemMetrics(0), ht=GetSystemMetrics(1);`,
      `    IntPtr desk=GetDesktopWindow(), src=GetWindowDC(desk), dst=CreateCompatibleDC(src), bmp=CreateCompatibleBitmap(src,w,ht);`,
      `    SelectObject(dst,bmp); BitBlt(dst,0,0,w,ht,src,0,0,0xCC0020);`,
      `    Bitmap img=Image.FromHbitmap(bmp); img.Save(path,ImageFormat.Png); img.Dispose();`,
      `    ReleaseDC(desk,src); DeleteDC(dst); DeleteObject(bmp);`,
      `  }`,
      `}`,
      `"@ -ReferencedAssemblies System.Drawing`,
      `try { [GdiCapture]::Capture('${remotePath}') } catch { $_ | Out-File '${doneFlag}.err'; exit 1 }`,
      `'done' | Set-Content '${doneFlag}'`,
    ].join('\r\n');
    const psBase64 = Buffer.from(psContent, 'utf8').toString('base64');
    const writeResult = await laptopExec(`powershell -Command "[IO.File]::WriteAllBytes('${scriptPath}', [Convert]::FromBase64String('${psBase64}')); Write-Output OK"`);
    if (!writeResult.output.includes('OK')) return null;

    const schedCmd = `schtasks /create /tn "FavorShot" /tr "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"${scriptPath}\\"" /sc once /st 00:00 /f /it && schtasks /run /tn "FavorShot" && schtasks /delete /tn "FavorShot" /f`;
    const capture = await laptopExec(schedCmd);
    if (!capture.ok) return null;

    let ready = false;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const check = await laptopExec(`powershell -Command "if (Test-Path '${doneFlag}') { 'YES' } else { 'NO' }"`);
      if (check.output.trim() === 'YES') { ready = true; break; }
    }
    if (!ready) return null;

    const b64Result = await laptopExec(`powershell -Command "[Convert]::ToBase64String([IO.File]::ReadAllBytes('${remotePath}'))"`);
    if (!b64Result.ok || !b64Result.output) return null;

    await laptopExec(`powershell -Command "Remove-Item '${doneFlag}' -Force -ErrorAction SilentlyContinue"`);
    return { buffer: Buffer.from(b64Result.output.trim(), 'base64'), dateStr, timeStr };
  } catch (e) {
    console.error('[SCREENSHOT] Capture failed:', e.message);
    return null;
  } finally {
    screenshotInProgress = false;
  }
}

async function executeTool(name, input, context = {}) {
  // GUARD: Role-based tool access control
  const role = context.role || 'customer';
  if (!canUseTool(role, name)) {
    console.log(`[SECURITY] Blocked tool "${name}" — ${role} does not have access`);
    db.audit('security.tool_blocked', `${role} tried to use ${name}`);
    return `This tool is not available. Please contact the operator for help with this request.`;
  }

  // PLUGIN: Check if this is a plugin tool before the built-in switch
  if (pluginLoader.has(name)) {
    return await pluginLoader.execute(name, input, { config, db, vault, contact: context.contact, role });
  }

  // GUARD: If the last tool was a browser read and now a sensitive tool is being called,
  // this could be a chained prompt injection (page content tricked the AI)
  if (lastToolWasBrowser && SENSITIVE_TOOLS.has(name)) {
    console.warn(`[SECURITY] Blocked ${name} — called immediately after browser content read. Possible injection.`);
    db.audit('security.blocked', `Blocked ${name} after browser read — possible injection`);
    lastToolWasBrowser = false;
    return `SECURITY BLOCK: "${name}" cannot be called immediately after reading browser content. This is a safety measure against prompt injection. If the operator actually wants this action, they should send a new message requesting it directly.`;
  }
  lastToolWasBrowser = false;
  switch (name) {
    case 'laptop_screenshot': {
      const result = await captureScreenshotBuffer();
      if (!result) return 'Screenshot failed — laptop may be offline or capture timed out.';
      try {
        await sock.sendMessage(context.contact, { image: result.buffer, caption: `Screenshot — ${result.dateStr} ${result.timeStr.replace(/-/g, ':')} — saved to Favor/Screenshots/${result.dateStr}/` });
        return '__IMAGE_SENT__';
      } catch (e) {
        return 'Screenshot captured but could not send: ' + e.message;
      }
    }
    case 'laptop_open_app': {
      // Use PowerShell Register-ScheduledTask via -EncodedCommand to avoid shell injection.
      // schtasks instead of PsExec — PsExec -i 1 doesn't give full GPU/display access,
      // causing heavy apps (Adobe, etc.) to freeze on splash screens
      const { safePowerShell, psSafeString } = require('./utils/shell');
      const psCode = `Register-ScheduledTask -TaskName TmpOpen -Action (New-ScheduledTaskAction -Execute ${psSafeString(input.app)}) -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2)) -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) -Force; Start-ScheduledTask -TaskName TmpOpen`;
      const create = await laptopExec(safePowerShell(psCode));
      if (!create.ok) return 'Error creating launch task: ' + create.output;
      return `Launched "${input.app}" on the laptop desktop.`;
    }
    case 'laptop_open_url': {
      // Use PowerShell Start-Process via -EncodedCommand to avoid shell injection.
      const { safePowerShell, psSafeString } = require('./utils/shell');
      const psCode = `Start-Process ${psSafeString(input.url)}`;
      const create = await laptopExec(safePowerShell(psCode));
      if (!create.ok) return 'Error opening URL: ' + create.output;
      return `Opened ${input.url} on the laptop browser.`;
    }
    case 'laptop_status': {
      const on = await isLaptopOnline();
      return on ? 'Laptop is online and connected.' : 'Laptop is offline.';
    }
    case 'laptop_read_file': {
      const { safePowerShell, psSafeString } = require('./utils/shell');
      const r = await laptopExec(safePowerShell(`Get-Content ${psSafeString(input.file_path)} -Raw`));
      if (!r.ok) return 'Error: ' + r.output;
      return r.output.length > 3000 ? r.output.substring(0, 3000) + '\n...(truncated)' : (r.output || '(empty)');
    }
    case 'laptop_list_files': {
      const { safePowerShell, psSafeString } = require('./utils/shell');
      const r = await laptopExec(safePowerShell(`Get-ChildItem ${psSafeString(input.directory)} | Format-Table Name, Length, LastWriteTime`));
      return r.ok ? r.output : 'Error: ' + r.output;
    }
    case 'laptop_run_command': {
      const r = await laptopExec(input.command);
      return r.ok ? (r.output || '(no output)') : 'Error: ' + r.output;
    }
    case 'laptop_write_file': {
      // Pipe content via stdin — no shell escaping needed, handles all characters safely
      const { psSafeString: psStr } = require('./utils/shell');
      const r = await laptopExec(`cat > ${psStr(input.file_path)}`, { stdin: input.content });
      return r.ok ? 'Written: ' + input.file_path : 'Error: ' + r.output;
    }
    case 'memory_save': {
      // Dedup: check for near-duplicate memories before saving
      const similar = db.findSimilar(input.category, input.content);
      if (similar.length > 0) {
        console.log(`[MEMORY] Dedup: found ${similar.length} similar memories, updating instead`);
        // Update the most recent similar memory instead of creating a new one
        const target = similar[0];
        db.db.prepare('UPDATE memories SET content = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(input.content, input.status || null, target.id);
        getEmbedding(input.content).then(emb => db.updateEmbedding(target.id, emb)).catch(() => {});
        return `Updated existing memory (was similar): ${input.content}`;
      }
      const memId = db.save(input.category, input.content, input.status);
      console.log(`[MEMORY] ${input.category}: ${input.content}`);
      // Embed in background — don't block the response
      getEmbedding(input.content).then(emb => db.updateEmbedding(memId, emb)).catch(() => {});
      return 'Remembered: ' + input.content;
    }
    case 'memory_search': {
      const results = await semanticSearch(input.query);
      if (!results.length) return 'Nothing found for: ' + input.query;
      return results.map(r => `[${r.category}] ${r.content}${r.score ? ` (relevance: ${(r.score * 100).toFixed(0)}%)` : ''}`).join('\n');
    }
    case 'memory_forget': {
      const removed = db.forget(input.category, input.query);
      return removed > 0 ? `Forgot ${removed} item(s)` : 'Nothing found to forget.';
    }
    case 'server_exec': {
      return new Promise((resolve) => {
        exec(input.command, { timeout: 15000, cwd: '/root' }, (err, stdout, stderr) => {
          if (err) resolve('Error: ' + err.message);
          else resolve((stdout || stderr || '(no output)').trim().substring(0, 3000));
        });
      });
    }
    case 'read_file': {
      try {
        const content = fs.readFileSync(input.file_path, 'utf8');
        return content.length > 3000 ? content.substring(0, 3000) + '\n...(truncated)' : (content || '(empty)');
      } catch (e) { return 'Error: ' + e.message; }
    }
    case 'write_file': {
      try {
        const dir = path.dirname(input.file_path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(input.file_path, input.content);
        return 'Written: ' + input.file_path;
      } catch (e) { return 'Error: ' + e.message; }
    }
    case 'web_search': {
      const braveKey = process.env.BRAVE_API_KEY || config.api?.braveApiKey;
      if (!braveKey) return 'Web search not configured (no BRAVE_API_KEY).';
      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=5`;
        const resp = await fetch(url, { headers: { 'X-Subscription-Token': braveKey, 'Accept': 'application/json' } });
        const data = await resp.json();
        if (!data.web?.results?.length) return 'No results found.';
        const raw = data.web.results.map(r => `${r.title}\n${r.url}\n${r.description || ''}`).join('\n\n');
        return sanitizeExternalInput(raw, 'web_search');
      } catch (e) { return 'Search error: ' + e.message; }
    }
    case 'cron_create': {
      const contact = context.contact || null;
      const id = db.createCron(contact, input.label, input.schedule, JSON.stringify({ type: 'proactive', prompt: input.task }));
      console.log(`[CRON] Created #${id}: "${input.label}" (${input.schedule})`);
      return `Scheduled: "${input.label}" (${input.schedule}) — ID #${id}`;
    }
    case 'cron_list': {
      const crons = db.getCrons(context.contact);
      if (!crons.length) return 'No scheduled tasks.';
      return crons.map(c => `#${c.id} [${c.enabled ? 'ON' : 'OFF'}] "${c.label}" — ${c.schedule}\n  Task: ${c.task.substring(0, 80)}\n  Next: ${c.next_run || 'N/A'}`).join('\n\n');
    }
    case 'cron_delete': {
      const removed = db.deleteCron(input.id);
      return removed ? `Deleted cron #${input.id}` : `Cron #${input.id} not found.`;
    }
    case 'cron_toggle': {
      db.toggleCron(input.id, input.enabled);
      return `Cron #${input.id} ${input.enabled ? 'enabled' : 'disabled'}.`;
    }
    case 'topic_create': {
      const id = db.createTopic(context.contact, input.name);
      console.log(`[TOPIC] Created: "${input.name}" for ${context.contact?.substring(0, 15)}`);
      return `Topic created: "${input.name}" (ID #${id}) — now active.`;
    }
    case 'topic_switch': {
      db.switchTopic(context.contact, input.id);
      return `Switched to topic #${input.id}.`;
    }
    case 'topic_list': {
      const topics = db.getTopics(context.contact);
      if (!topics.length) return 'No topics. All conversation is in the main thread.';
      return topics.map(t => `#${t.id} ${t.active ? '→' : ' '} "${t.name}" (${t.updated_at})`).join('\n');
    }
    case 'send_message': {
      try {
        let jid;
        const contact = input.contact || '';
        if (PLATFORM === 'telegram') {
          // Accept tg_CHATID or raw chat ID
          jid = contact.startsWith('tg_') ? contact : `tg_${contact}`;
        } else {
          const cleaned = contact.replace(/[^0-9+]/g, '');
          if (!cleaned || cleaned.replace('+', '').length < 10) {
            return 'Invalid phone number. Use full number with country code (e.g. +13055551234).';
          }
          jid = cleaned.replace('+', '') + '@s.whatsapp.net';
        }
        await sock.sendMessage(jid, { text: input.message });
        console.log(`[PROACTIVE] Sent to ${contact}: ${input.message.substring(0, 60)}`);
        return `Message sent to ${contact}`;
      } catch (e) { return 'Send failed: ' + e.message; }
    }
    case 'email_search': {
      try {
        const { query, max_results } = input;
        const max = Math.min(max_results || 5, 10);
        const result = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process');
          execFile('python3', ['/root/read-gmail.py', 'search', query, String(max)], { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
          });
        });
        console.log(`[EMAIL] Searched: "${query}"`);
        return sanitizeExternalInput(result, 'email');
      } catch (e) { return 'Email search failed: ' + e.message; }
    }
    case 'email_read': {
      try {
        const { message_id } = input;
        const result = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process');
          execFile('python3', ['/root/read-gmail.py', 'read', message_id], { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
          });
        });
        console.log(`[EMAIL] Read message: ${message_id}`);
        return sanitizeExternalInput(result, 'email');
      } catch (e) { return 'Email read failed: ' + e.message; }
    }
    case 'send_email': {
      try {
        const { to, subject, body: emailBody, attachment } = input;
        if (!to || !subject || !emailBody) return 'Missing required fields: to, subject, body';
        const args = ['python3', '/root/send-gmail.py', to, subject, emailBody];
        if (attachment) args.push(attachment);
        const result = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process');
          execFile(args[0], args.slice(1), { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
          });
        });
        console.log(`[EMAIL] Sent to ${to}: "${subject}" ${attachment ? '(+attachment)' : ''}`);
        return `Email sent to ${to} — ${result}`;
      } catch (e) { return 'Email send failed: ' + e.message; }
    }
    case 'send_image': {
      try {
        if (!lastReceivedImage) return 'No image available to forward. The operator needs to send an image first.';
        let jid;
        const contact = input.contact || '';
        if (PLATFORM === 'telegram') {
          jid = contact.startsWith('tg_') ? contact : `tg_${contact}`;
        } else {
          const cleaned = contact.replace(/[^0-9+]/g, '');
          if (!cleaned || cleaned.replace('+', '').length < 10) {
            return 'Invalid phone number. Use full number with country code (e.g. +13055551234).';
          }
          jid = cleaned.replace('+', '') + '@s.whatsapp.net';
        }
        const msgPayload = { image: lastReceivedImage.buffer };
        if (input.caption) msgPayload.caption = input.caption;
        await sock.sendMessage(jid, msgPayload);
        console.log(`[PROACTIVE] Sent image to ${cleaned}${input.caption ? ': ' + input.caption.substring(0, 60) : ''}`);
        return `Image sent to ${cleaned}${input.caption ? ' with caption' : ''}`;
      } catch (e) { return 'Send image failed: ' + e.message; }
    }
    // ─── VAULT TOOLS ───
    case 'vault_save': {
      if (!vault) return 'Vault not configured. Add vault.secret to config.json.';
      try {
        const result = vault.save(input.label, input.category, input.data);
        console.log(`[VAULT] ${result.action}: ${input.label} (${input.category})`);
        db.audit('vault.save', `${result.action} ${input.label}`);
        return `Vault ${result.action}: "${input.label}" (${input.category}) — encrypted and stored securely.`;
      } catch (e) { return 'Vault save error: ' + e.message; }
    }
    case 'vault_get': {
      if (!vault) return 'Vault not configured.';
      const entry = vault.get(input.label);
      if (!entry) return `No vault entry found for "${input.label}".`;
      if (entry.error) return entry.error;
      console.log(`[VAULT] Retrieved: ${input.label} (redacted for AI)`);
      // SECURITY: Redact sensitive fields — never send raw card data through the AI
      const data = typeof entry.data === 'object' ? { ...entry.data } : entry.data;
      if (typeof data === 'object') {
        if (data.number || data.card_number) {
          const num = data.number || data.card_number;
          data.number = '****' + num.slice(-4);
          delete data.card_number;
        }
        if (data.cvv || data.cvc || data.security_code) {
          data.cvv = '***';
          delete data.cvc;
          delete data.security_code;
        }
        if (data.ssn) data.ssn = '***-**-' + data.ssn.slice(-4);
        if (data.passport) data.passport = '***' + data.passport.slice(-3);
      }
      return JSON.stringify(data, null, 2);
    }
    case 'vault_list': {
      if (!vault) return 'Vault not configured.';
      const entries = vault.list(input.category);
      if (!entries.length) return 'Vault is empty.';
      return entries.map(e => `• ${e.label} (${e.category}) — saved ${e.created_at}`).join('\n');
    }
    case 'vault_delete': {
      if (!vault) return 'Vault not configured.';
      const deleted = vault.delete(input.label);
      if (deleted) {
        db.audit('vault.delete', input.label);
        return `Deleted vault entry: "${input.label}"`;
      }
      return `No vault entry found for "${input.label}".`;
    }
    // ─── BROWSER TOOLS ───
    case 'browser_navigate': {
      const result = await browser.navigate(input.url);
      if (result.ok) {
        console.log(`[BROWSER] Navigated to: ${result.url}`);
        return `Page loaded: "${result.title}"\nURL: ${result.url}`;
      }
      return 'Navigation failed: ' + result.error;
    }
    case 'browser_screenshot': {
      try {
        const shot = await browser.screenshot(input.label || 'page');
        // Send screenshot to operator via WhatsApp
        await sock.sendMessage(context.contact, { image: shot.buffer, caption: `Browser: ${input.label || 'page'} — ${new Date().toLocaleTimeString()}` });
        console.log(`[BROWSER] Screenshot sent: ${shot.filename}`);
        return '__IMAGE_SENT__';
      } catch (e) { return 'Screenshot failed: ' + e.message; }
    }
    case 'browser_click': {
      const result = await browser.click(input.selector);
      return result.ok ? `Clicked: ${input.selector}` : 'Click failed: ' + result.error;
    }
    case 'browser_type': {
      const result = await browser.type(input.selector, input.text, { clear: input.clear !== false });
      return result.ok ? `Typed into ${input.selector}` : 'Type failed: ' + result.error;
    }
    case 'browser_select': {
      const result = await browser.select(input.selector, input.value);
      return result.ok ? `Selected "${input.value}" in ${input.selector}` : 'Select failed: ' + result.error;
    }
    case 'browser_fill_form': {
      const results = await browser.fillForm(input.fields);
      const ok = results.filter(r => r.ok).length;
      const fail = results.filter(r => !r.ok);
      let msg = `Filled ${ok}/${results.length} fields.`;
      if (fail.length) msg += '\nFailed: ' + fail.map(f => `${f.selector}: ${f.error}`).join(', ');
      return msg;
    }
    case 'browser_get_fields': {
      const fields = await browser.getFormFields();
      if (!fields.length) return 'No visible form fields on this page.';
      lastToolWasBrowser = true;
      return '[BROWSER CONTENT — untrusted]\n' + fields.map(f => {
        let desc = `[${f.tag}${f.type ? ':' + f.type : ''}]`;
        if (f.id) desc += ` id="${f.id}"`;
        if (f.name) desc += ` name="${f.name}"`;
        if (f.label) desc += ` label="${f.label}"`;
        if (f.placeholder) desc += ` placeholder="${f.placeholder}"`;
        if (f.value) desc += ` value="${f.value}"`;
        if (f.options) desc += ` options: ${f.options.slice(0, 5).map(o => o.text).join(', ')}${f.options.length > 5 ? '...' : ''}`;
        return desc;
      }).join('\n');
    }
    case 'browser_get_clickables': {
      const items = await browser.getClickables();
      if (!items.length) return 'No clickable elements found.';
      lastToolWasBrowser = true;
      return '[BROWSER CONTENT — untrusted]\n' + items.map(i => {
        let desc = `[${i.tag}] "${i.text}"`;
        if (i.href) desc += ` → ${i.href.substring(0, 80)}`;
        if (i.id) desc += ` id="${i.id}"`;
        return desc;
      }).join('\n');
    }
    case 'browser_get_text': {
      const text = await browser.getText(input.selector || 'body');
      lastToolWasBrowser = true;
      return sanitizeExternalInput(text, 'browser');
    }
    case 'browser_scroll': {
      await browser.scroll(input.direction || 'down', input.amount || 500);
      return `Scrolled ${input.direction || 'down'} ${input.amount || 500}px`;
    }
    case 'browser_evaluate': {
      const result = await browser.evaluate(input.code);
      lastToolWasBrowser = true;
      return result.ok ? sanitizeExternalInput(result.result || '(no return value)', 'browser') : 'Eval error: ' + result.error;
    }
    case 'browser_close': {
      await browser.close();
      return 'Browser session closed.';
    }
    case 'browser_status': {
      const info = await browser.getPageInfo();
      if (!info.open) return 'No browser session active.';
      return `Browser active: "${info.title}" — ${info.url}`;
    }
    case 'browser_fill_from_vault': {
      if (!vault) return 'Vault not configured.';
      const entry = vault.get(input.vault_label);
      if (!entry || !entry.data) return `Vault entry "${input.vault_label}" not found or empty.`;
      const data = entry.data;
      // Flatten card helper fields
      const resolved = {
        number: data.number || data.card_number,
        exp: data.exp || data.expiration || data.exp_date,
        cvv: data.cvv || data.cvc || data.security_code,
        name: data.name || data.cardholder || data.card_name,
        zip: data.zip || data.billing_zip || data.postal_code,
        address: data.address || data.billing_address || data.street,
        city: data.city,
        state: data.state,
        country: data.country,
        email: data.email,
        phone: data.phone,
        first_name: data.first_name,
        last_name: data.last_name,
        dob: data.dob || data.date_of_birth,
        ...data // any extra fields accessible by their original key
      };
      // Build selector->value map using the field_mapping
      const fields = {};
      let filled = 0, skipped = [];
      for (const [selector, fieldName] of Object.entries(input.field_mapping)) {
        const value = resolved[fieldName];
        if (value) {
          fields[selector] = String(value);
          filled++;
        } else {
          skipped.push(fieldName);
        }
      }
      if (filled === 0) return 'No matching vault fields found for the given mapping.';
      // Fill directly in Puppeteer — sensitive data never touches the AI
      const results = await browser.fillForm(fields);
      const ok = results.filter(r => r.ok).length;
      const fail = results.filter(r => !r.ok);
      console.log(`[VAULT+BROWSER] Filled ${ok} fields from "${input.vault_label}" (${skipped.length} skipped)`);
      db.audit('vault.browser_fill', `${input.vault_label}: ${ok} fields filled`);
      let msg = `Securely filled ${ok}/${filled} fields from vault "${input.vault_label}".`;
      if (skipped.length) msg += `\nSkipped (not in vault): ${skipped.join(', ')}`;
      if (fail.length) msg += `\nFailed: ${fail.map(f => f.selector).join(', ')}`;
      msg += '\n(Card data was decrypted locally — never sent through this conversation.)';
      return msg;
    }
    // ─── VIDEO TOOLS ───
    case 'video_analyze': {
      if (!videoProcessor) return 'Video processor not initialized.';
      try {
        await sock.sendMessage(context.contact, { text: '🎬 Downloading and analyzing video... this may take a minute.' });
        const download = await videoProcessor.downloadFromUrl(input.url);
        if (!download.ok) return 'Download failed: ' + download.error;
        const result = await videoProcessor.processVideo(download.path, download.dir, input.context || '');
        videoProcessor.cleanup(download.dir);
        console.log(`[VIDEO] Analyzed: ${result.duration}s, ${result.frameCount} frames, transcript: ${result.transcript ? 'yes' : 'no'}`);
        return `**Video Analysis** (${result.duration}s, ${result.frameCount} frames)\n\n${result.summary}`;
      } catch (e) {
        return 'Video analysis failed: ' + e.message;
      }
    }
    case 'video_learn': {
      if (!videoProcessor) return 'Video processor not initialized.';
      try {
        await sock.sendMessage(context.contact, { text: '🎬 Downloading, analyzing, and learning from video...' });
        const download = await videoProcessor.downloadFromUrl(input.url);
        if (!download.ok) return 'Download failed: ' + download.error;
        const result = await videoProcessor.processVideo(download.path, download.dir, input.context || '');
        videoProcessor.cleanup(download.dir);

        // Save key learnings to fact memory
        const memContent = `Video learning (${input.url}):\n${result.summary}`;
        const memId = db.save('fact', memContent.substring(0, 2000), null);
        getEmbedding(memContent.substring(0, 512)).then(emb => db.updateEmbedding(memId, emb)).catch(() => {});

        // Extract actionable techniques and save as workflow knowledge
        const techPrompt = `Extract actionable techniques, shortcuts, and design/business principles from this video summary. Format as bullet points. Only include things that could be applied to the operator's work. If there are no actionable techniques, respond with: NO_TECHNIQUES

Video: ${input.url}
Context: ${input.context || 'general'}

Summary:
${result.summary}`;
        const techniques = await runClaudeCLI(techPrompt, 30000) || '';
        if (techniques && !techniques.includes('NO_TECHNIQUES')) {
          const wfContent = `[Learned from video] ${input.context || 'course'}: ${techniques}`;
          const wfId = db.save('workflow', wfContent.substring(0, 2000), null);
          getEmbedding(wfContent.substring(0, 512)).then(emb => db.updateEmbedding(wfId, emb)).catch(() => {});

          // Also update operator profile with learned techniques
          await updateOperatorProfile(`**From video (${input.context || input.url}):**\n${techniques}`);
          console.log(`[VIDEO] Learned from video: ${result.duration}s → fact #${memId} + workflow #${wfId}`);
          return `**Video Learned** (${result.duration}s, ${result.frameCount} frames)\n\n${result.summary}\n\n**Techniques extracted:**\n${techniques}\n\n✅ Saved to memory + operator profile.`;
        }

        console.log(`[VIDEO] Learned from video: ${result.duration}s → memory #${memId}`);
        return `**Video Learned** (${result.duration}s, ${result.frameCount} frames)\n\n${result.summary}\n\n✅ Saved to long-term memory (ID #${memId}).`;
      } catch (e) {
        return 'Video learning failed: ' + e.message;
      }
    }
    case 'learn_from_url': {
      try {
        await sock.sendMessage(context.contact, { text: '📖 Reading and learning from that page...' });
        // Use browser to fetch the page content
        const navResult = await browser.navigate(input.url);
        if (!navResult.ok) return 'Could not load page: ' + (navResult.error || 'unknown error');

        // Extract page text
        const pageText = await browser.evaluate('document.body.innerText.substring(0, 8000)');
        const pageContent = sanitizeBrowserOutput(pageText.ok ? pageText.result : navResult.title);
        await browser.close();

        // Analyze and extract learnings
        const learnPrompt = `You are extracting actionable knowledge from a webpage.

Extract:
1. **Key techniques** — specific methods, shortcuts, or approaches that can be replicated
2. **Design principles** — any visual/design insights (color theory, layout, typography, branding)
3. **Business insights** — strategies, pricing, marketing, client management tips
4. **Tools/resources** — any software, services, or resources mentioned worth knowing

Format as organized bullet points under relevant headers. Only include genuinely useful, actionable information.
If the page has no useful content (404, paywall, login wall, etc.), respond with: NO_CONTENT

URL: ${input.url}
Focus: ${input.context || 'general'}

Page content:
${pageContent}`;
        const learnings = await runClaudeCLI(learnPrompt, 60000) || '';
        if (!learnings || learnings.includes('NO_CONTENT')) return 'Could not extract useful content from that page.';

        // Save to workflow memory
        const memContent = `[Learned from ${input.url}] ${input.context || ''}: ${learnings}`;
        const memId = db.save('workflow', memContent.substring(0, 2000), null);
        getEmbedding(memContent.substring(0, 512)).then(emb => db.updateEmbedding(memId, emb)).catch(() => {});

        // Update operator profile
        await updateOperatorProfile(`**From article/course (${input.context || input.url}):**\n${learnings}`);
        console.log(`[LEARN] Learned from URL: ${input.url} → workflow #${memId}`);
        return `**Learned from page:**\n\n${learnings}\n\n✅ Saved to operator profile + memory.`;
      } catch (e) {
        return 'Learning from URL failed: ' + e.message;
      }
    }
    case 'knowledge_search': {
      try {
        const { execSync } = require('child_process');
        const n = input.num_results || 5;
        const query = input.query.replace(/'/g, "'\\''");
        const result = execSync(
          `export PATH="$HOME/.bun/bin:$PATH" && qmd search '${query}' -c favor-knowledge -n ${n} --json`,
          { encoding: 'utf8', timeout: 10000 }
        );
        const parsed = JSON.parse(result);
        const results = Array.isArray(parsed) ? parsed : (parsed.results || []);
        if (!results.length) return 'No results found for: ' + input.query;
        return results.map((r, i) =>
          `[${i+1}] ${r.title || r.file} (score: ${Math.round((r.score || 0) * 100)}%)\n${r.snippet || ''}`
        ).join('\n\n---\n\n');
      } catch(e) {
        return 'Knowledge search error: ' + e.message;
      }
    }
    case 'design_system': {
      try {
        const { generateDesignSystem, formatMarkdown, formatCompact } = require('./uiux');
        const ds = generateDesignSystem(input.query, input.project_name);
        const fmt = input.format === 'markdown' ? formatMarkdown(ds) : formatCompact(ds);
        return fmt;
      } catch (e) {
        return 'Design system error: ' + e.message;
      }
    }
    case 'design_search': {
      try {
        const { searchDomain } = require('./uiux');
        return searchDomain(input.query, input.domain, input.num_results || 3);
      } catch (e) {
        return 'Design search error: ' + e.message;
      }
    }
    case 'sync_update': {
      syncBot.sync('bot', {
        type: input.type || 'action',
        summary: input.summary,
        objective: input.objective,
        next: input.next,
        decision: input.decision,
        reason: input.reason,
        status: 'success'
      });
      return `Sync updated: ${input.summary}`;
    }
    case 'sync_recover': {
      const recovery = syncBot.recover();
      return JSON.stringify({
        mission: recovery.mission,
        unfinished_tasks: recovery.unfinished_tasks,
        last_success: recovery.last_successful_action,
        last_failure: recovery.last_failed_action,
        blockers: recovery.open_blockers,
        next_step: recovery.recommended_next,
        recent: recovery.recent_events_summary.slice(-5)
      }, null, 2);
    }
    // ─── BUILD MODE ───
    case 'build_plan': {
      const workDir = input.work_dir || `/root/builds/${input.description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
      if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
      await sock.sendMessage(context.contact, { text: `🔨 *Build Mode* — Planning project in \`${workDir}\`...\nThis may take a minute or two.` });
      try {
        const plan = await buildMode.plan(input.description, workDir);
        buildMode.setState(context.contact, { workDir, description: input.description, plan, phase: 'planned' });
        return `Build plan created for ${workDir}:\n\n${plan}`;
      } catch (e) {
        return `Build planning failed: ${e.message}`;
      }
    }
    case 'build_execute': {
      await sock.sendMessage(context.contact, { text: `⚡ *Build Mode* — Executing task in \`${input.work_dir}\`...\nClaude Code is writing code. This may take a few minutes.` });
      try {
        const result = await buildMode.execute(input.task, input.work_dir, { context: input.context || '' });
        const state = buildMode.getState(context.contact);
        if (state) buildMode.setState(context.contact, { ...state, phase: 'building', lastTask: input.task });
        return `Build step completed:\n\n${result}`;
      } catch (e) {
        return `Build execution failed: ${e.message}`;
      }
    }
    case 'build_verify': {
      await sock.sendMessage(context.contact, { text: `🔍 *Build Mode* — Verifying build in \`${input.work_dir}\`...` });
      try {
        const result = await buildMode.verify(input.work_dir, input.requirements);
        const state = buildMode.getState(context.contact);
        if (state) buildMode.setState(context.contact, { ...state, phase: 'verified' });
        return `Build verification:\n\n${result}`;
      } catch (e) {
        return `Build verification failed: ${e.message}`;
      }
    }
    case 'build_raw': {
      await sock.sendMessage(context.contact, { text: `🔨 *Build Mode* — Running Claude Code in \`${input.work_dir}\`...` });
      try {
        const result = await buildMode.raw(input.prompt, input.work_dir);
        return `Claude Code result:\n\n${result}`;
      } catch (e) {
        return `Build command failed: ${e.message}`;
      }
    }
    // ─── GUARDIAN ───
    case 'guardian_scan': {
      const mode = input.mode || 'quick';
      await sock.sendMessage(context.contact, { text: `🛡️ *Guardian* — Running ${mode} scan on \`${input.target}\`...\nThis may take a few minutes.` });
      try {
        const { report, logs } = await guardian.scan(input.target, {
          mode,
          scope: input.scope || 'full',
        });
        const formatted = guardian.formatReport(report);
        return formatted;
      } catch (e) {
        return `Guardian scan failed: ${e.message}`;
      }
    }
    case 'guardian_report': {
      const last = guardian.getLastReport();
      if (!last) return 'No previous Guardian scan found. Run guardian_scan first.';
      return `Last scan: ${last.scannedAt}\n\n${guardian.formatReport(last.report)}`;
    }
    case 'guardian_status': {
      return guardian.formatGuardStatus();
    }
    // ─── SELF-CHECK ───
    case 'start_remote': {
      try {
        const dir = input.directory || '/root';
        const { execSync } = require('child_process');
        try { execSync('tmux kill-session -t claude-rc 2>/dev/null'); } catch {}
        execSync(`tmux new-session -d -s claude-rc -c "${dir}"`);
        execSync(`tmux send-keys -t claude-rc "claude --remote-control" Enter`);
        let sessionUrl = null;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const pane = execSync('tmux capture-pane -t claude-rc -p', { encoding: 'utf8' });
            const match = pane.match(/(https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+)/);
            if (match) { sessionUrl = match[1]; break; }
            if (pane.includes('Yes, I trust this folder')) {
              execSync('tmux send-keys -t claude-rc Enter');
            }
          } catch {}
        }
        if (sessionUrl) {
          await sock.sendMessage(context.contact, { text: `🖥️ *Remote Code Session Ready*\n\nOpen on your phone:\n${sessionUrl}\n\nRunning in: ${dir}\nSession: tmux (survives disconnects)` });
          return '__IMAGE_SENT__';
        }
        return 'Remote session started but could not capture URL. Check tmux session "claude-rc" manually.';
      } catch (e) {
        return 'Failed to start remote session: ' + e.message;
      }
    }
    case 'selfcheck': {
      await sock.sendMessage(context.contact, { text: '🛡️ *Self-Check* — Running health checks and cleanup...' });
      try {
        const report = await selfCheck.runAll();
        return selfCheck.formatReport(report);
      } catch (e) {
        return `Self-check failed: ${e.message}`;
      }
    }

    // ─── TEACH MODE ───
    case 'teach_create': {
      try {
        const id = db.saveTeachCommand(
          context.contact,
          input.command_name,
          input.description || '',
          input.trigger_phrase,
          input.pipeline || []
        );
        return `✅ Taught command created!\n*#${id} — ${input.command_name}*\nTrigger: "${input.trigger_phrase}"\nSteps: ${(input.pipeline || []).length}\n\nSay "${input.trigger_phrase}" anytime to run it.`;
      } catch (e) {
        return `Failed to create taught command: ${e.message}`;
      }
    }

    case 'teach_list': {
      const commands = db.listTeachCommands(context.contact);
      if (!commands.length) return 'No taught commands yet. Teach me something! Say "teach: when I say X, do Y"';
      return '*Your Commands:*\n\n' + commands.map(c =>
        `*#${c.id} — ${c.command_name}* ${c.enabled ? '✅' : '⏸️'}\n` +
        `  Trigger: "${c.trigger_phrase}"\n` +
        (c.description ? `  ${c.description}\n` : '') +
        `  Used ${c.execution_count}x` + (c.last_executed ? ` (last: ${c.last_executed})` : '')
      ).join('\n\n');
    }

    case 'teach_run': {
      const cmd = db.getTeachCommand(input.id);
      if (!cmd) return `Taught command #${input.id} not found.`;
      if (!cmd.enabled) return `Command "${cmd.command_name}" is disabled.`;
      const pipeline = JSON.parse(cmd.pipeline);
      if (!pipeline.length) return `Command "${cmd.command_name}" has no steps.`;

      await sock.sendMessage(context.contact, { text: `⚡ Running: *${cmd.command_name}* (${pipeline.length} steps)` });
      const results = [];
      for (let i = 0; i < pipeline.length; i++) {
        const step = pipeline[i];
        try {
          const result = await executeTool(step.tool, step.params || {}, context);
          results.push(`✓ Step ${i + 1}: ${step.description || step.tool} — OK`);
        } catch (e) {
          results.push(`✗ Step ${i + 1}: ${step.description || step.tool} — ${e.message}`);
          break;
        }
      }
      db.recordTeachExecution(cmd.id);
      return `*${cmd.command_name}* — Done\n\n${results.join('\n')}`;
    }

    case 'teach_update': {
      const cmd = db.getTeachCommand(input.id);
      if (!cmd) return `Taught command #${input.id} not found.`;
      const updates = {};
      if (input.command_name) updates.commandName = input.command_name;
      if (input.trigger_phrase) updates.triggerPhrase = input.trigger_phrase;
      if (input.description) updates.description = input.description;
      if (input.pipeline) updates.pipeline = input.pipeline;
      if (input.enabled !== undefined) updates.enabled = input.enabled;
      db.updateTeachCommand(input.id, updates);
      return `✅ Updated command #${input.id} — ${input.command_name || cmd.command_name}`;
    }

    case 'teach_delete': {
      const removed = db.deleteTeachCommand(input.id);
      return removed ? `🗑️ Deleted taught command #${input.id}` : `Command #${input.id} not found.`;
    }

    default: return 'Unknown tool: ' + name;
  }
}

// ─── SYSTEM PROMPT ───
// Prompt building extracted to core/prompts.js
const { buildSystemPrompt: _buildSystemPrompt } = require('./core/prompts');

// Thin wrappers that inject instance dependencies into extracted module
function buildMemoryPrompt(relevantMemories = []) {
  // LEGACY — kept for any internal callers. New code should use core/prompts.js directly.
  const { buildMemoryPrompt: _bmp } = require('./core/prompts');
  return _bmp(db, relevantMemories);
}
function buildSystemPrompt(contact, messageText = '', relevantMemories = []) {
  return _buildSystemPrompt({
    config, db, compactor, platform: PLATFORM,
    contact, messageText, relevantMemories,
    dynamicKnowledge: buildDynamicKnowledge(messageText),
  });
}

// ─── SESSION MANAGEMENT ───

// Sanitize history to ensure all tool_call messages have matching tool results
function sanitizeHistory(messages) {
  const clean = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Collect all consecutive tool result messages that follow
      const toolMsgs = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        toolMsgs.push(messages[j]);
        j++;
      }
      const foundIds = new Set(toolMsgs.map(m => m.tool_call_id));
      const missing = msg.tool_calls.filter(tc => !foundIds.has(tc.id));

      clean.push(msg);
      // Push each tool_call's result — existing if found, synthetic if missing
      for (const tc of msg.tool_calls) {
        const existing = toolMsgs.find(m => m.tool_call_id === tc.id);
        if (existing) {
          clean.push(existing);
        } else {
          console.log(`[SANITIZE] Injecting synthetic result for tool_call ${tc.id}`);
          clean.push({ role: 'tool', tool_call_id: tc.id, content: 'Error: tool execution was interrupted.' });
        }
      }
      if (missing.length) console.log(`[SANITIZE] Fixed ${missing.length} missing tool result(s)`);
      i = j; // skip past all tool messages we already handled
    } else if (msg.role === 'tool') {
      // Orphaned tool result with no preceding assistant tool_calls
      console.log('[SANITIZE] Dropping orphaned tool result at index ' + i);
      i++;
    } else {
      clean.push(msg);
      i++;
    }
  }
  while (clean.length > 0 && clean[0].role === 'assistant') clean.shift();
  return clean;
}

function getHistory(contact) {
  const topic = db.getActiveTopic(contact);
  if (topic) {
    const raw = topic.messages;
    const clean = sanitizeHistory(raw);
    // If sanitizer changed anything, save the fixed version back immediately
    if (clean.length !== raw.length) db.saveTopicMessages(topic.id, clean);
    return { messages: clean, topicId: topic.id };
  }
  const session = db.getSession(contact);
  if (!session) return { messages: [], topicId: null };
  const raw = session.messages;
  const clean = sanitizeHistory(raw);
  if (clean.length !== raw.length) db.saveSession(contact, clean);
  return { messages: clean, topicId: null };
}

async function saveHistory(contact, messages, topicId) {
  const result = await compactor.compactIfNeeded(contact, messages);
  const finalMessages = result.messages;
  if (topicId) {
    db.saveTopicMessages(topicId, finalMessages);
  } else {
    db.saveSession(contact, finalMessages);
  }
}

// ─── SCREEN AWARENESS ENGINE (Filmstrip Mode) ───
// Captures every 2 seconds, batches 3 frames into a "filmstrip" for GPT-4o analysis.
// AI sees temporal progression (like video) instead of isolated snapshots.
// Only sends flagged/important insights. Routine activity is trashed.
// Also silently logs workflow observations → saved to memory when session ends.
let screenAwarenessTimer = null;
let screenAwarenessActive = false;
let screenTickCount = 0;
let screenAwaitingContinue = false;
let screenTickInProgress = false;
let lastScreenContext = '';
let screenFrameBuffer = [];          // holds up to 3 frames before analysis
let screenWorkflowLog = [];          // accumulated workflow observations during session
const SCREEN_CAPTURE_MS = 2000;      // capture every 2 seconds
const SCREEN_FRAMES_PER_BATCH = 3;   // analyze 3 frames at once (6s of activity)
const SCREEN_CHECKIN_AFTER = 60000;   // ask to continue after 60s
let screenStartTime = 0;

function startScreenAwareness() {
  if (screenAwarenessActive) return;
  screenAwarenessActive = true;
  screenTickCount = 0;
  screenAwaitingContinue = false;
  screenTickInProgress = false;
  lastScreenContext = '';
  screenFrameBuffer = [];
  screenWorkflowLog = [];
  screenStartTime = Date.now();
  console.log('[SCREEN] Screen awareness ON (filmstrip mode: capture every 2s, analyze 3 frames at a time, learning workflow)');
  screenAwarenessLoop();
}

async function stopScreenAwareness() {
  screenAwarenessActive = false;
  screenAwaitingContinue = false;
  screenFrameBuffer = [];
  if (screenAwarenessTimer) {
    clearTimeout(screenAwarenessTimer);
    screenAwarenessTimer = null;
  }
  // Save accumulated workflow observations to memory
  if (screenWorkflowLog.length > 0) {
    try {
      await saveWorkflowSession();
    } catch (e) {
      console.error('[SCREEN] Failed to save workflow:', e.message);
    }
  }
  console.log('[SCREEN] Screen awareness OFF');
}

// Summarize and persist what was learned during this screen session
async function saveWorkflowSession() {
  const observations = screenWorkflowLog.join('\n');
  const duration = Math.round((Date.now() - screenStartTime) / 1000);
  const now = new Date().toISOString().split('T')[0];

  // Use Claude CLI to distill observations into a workflow profile update
  const screenPrompt = `Analyze this screen monitoring session. Distill into 3-8 bullet points about workflow habits, tools used, design patterns, and skill indicators. Only lasting insights, not one-time observations. If nothing meaningful, respond with: NOTHING_LEARNED

Screen session: ${duration}s, ${screenTickCount} captures, ${screenWorkflowLog.length} observations.

Raw observations:
${observations}`;
  const summary = await runClaudeCLI(screenPrompt, 60000) || '';
  if (summary && !summary.includes('NOTHING_LEARNED')) {
    const memContent = `[Workflow observation ${now}] ${summary}`;
    const memId = db.save('workflow', memContent.substring(0, 2000), null);
    getEmbedding(memContent.substring(0, 512)).then(emb => db.updateEmbedding(memId, emb)).catch(() => {});
    console.log(`[SCREEN] Saved workflow observations → memory #${memId} (${screenWorkflowLog.length} observations distilled)`);

    // Also update the operator profile knowledge file
    await updateOperatorProfile(summary);
  } else {
    console.log('[SCREEN] Session too short/idle — nothing new learned');
  }
  screenWorkflowLog = [];
}

// Append new insights to the persistent operator profile
async function updateOperatorProfile(newInsights) {
  const profilePath = path.join(__dirname, 'knowledge', 'operator_profile.md');
  let existing = '';
  try { existing = fs.readFileSync(profilePath, 'utf8'); } catch (_) {}

  if (!existing) {
    existing = `# Operator Profile
## Learned from screen observation, video courses, and interactions.
## The bot uses this to understand your workflow, design style, and preferences.

### Workflow & Habits\n\n### Design Style\n\n### Tools & Software\n\n### Skills & Techniques\n\n### Business Context\n`;
  }

  // Append timestamped observations
  const now = new Date().toISOString().split('T')[0];
  const updated = existing.trimEnd() + `\n\n---\n**Observed ${now}:**\n${newInsights}\n`;
  fs.writeFileSync(profilePath, updated);
  console.log('[SCREEN] Updated operator profile: knowledge/operator_profile.md');
}

async function screenAwarenessLoop() {
  if (!screenAwarenessActive) return;
  if (screenTickInProgress) return;
  const operatorJid = PLATFORM === 'telegram'
    ? `tg_${config.telegram?.operatorChatId || ''}`
    : (config.whatsapp.operatorNumber || '').replace('+', '') + '@s.whatsapp.net';

  if ((Date.now() - screenStartTime) >= SCREEN_CHECKIN_AFTER && !screenAwaitingContinue) {
    screenAwaitingContinue = true;
    const batchesDone = Math.floor(screenTickCount / SCREEN_FRAMES_PER_BATCH);
    await sock.sendMessage(operatorJid, { text: `*[Screen Awareness]*\nBeen watching for 1 minute (${screenTickCount} captures, ${batchesDone} analyses). Should I keep going?\n\nReply *"keep going"* or *"stop"*` });
    console.log(`[SCREEN] Check-in sent after ${screenTickCount} captures — waiting for response`);
    return;
  }

  screenTickInProgress = true;
  try {
    await screenCaptureTick();
  } catch (err) {
    console.error('[SCREEN] Tick error:', err.message);
  }
  screenTickInProgress = false;

  screenTickCount++;
  if (screenAwarenessActive && !screenAwaitingContinue) {
    screenAwarenessTimer = setTimeout(() => screenAwarenessLoop(), SCREEN_CAPTURE_MS);
  }
}

function resumeScreenAwareness() {
  if (!screenAwarenessActive || !screenAwaitingContinue) return;
  screenAwaitingContinue = false;
  screenTickCount = 0;
  screenStartTime = Date.now();
  screenFrameBuffer = [];
  console.log('[SCREEN] Resumed — next check-in in 60s');
  screenAwarenessLoop();
}

// Capture a frame and add to buffer. When buffer is full, analyze the batch.
async function screenCaptureTick() {
  if (!sock || !config.laptop?.enabled) return;

  const online = await isLaptopOnline();
  if (!online) { console.log('[SCREEN] Laptop offline — skipping'); return; }

  const result = await captureScreenshotBuffer();
  if (!result) { console.log('[SCREEN] Screenshot failed — skipping'); return; }

  screenFrameBuffer.push({ buffer: result.buffer, time: `${result.dateStr} ${result.timeStr.replace(/-/g, ':')}` });
  console.log(`[SCREEN] Frame ${screenFrameBuffer.length}/${SCREEN_FRAMES_PER_BATCH} captured`);

  // When we have enough frames, analyze the batch
  if (screenFrameBuffer.length >= SCREEN_FRAMES_PER_BATCH) {
    await analyzeScreenBatch();
  }
}

// Save buffered frames to temp files, analyze with Claude CLI + Read tool
async function analyzeScreenBatch() {
  const frames = [...screenFrameBuffer];
  screenFrameBuffer = [];

  const operatorJid = PLATFORM === 'telegram'
    ? `tg_${config.telegram?.operatorChatId || ''}`
    : (config.whatsapp.operatorNumber || '').replace('+', '') + '@s.whatsapp.net';

  // Save frames to temp files for Claude CLI to read
  const tmpFramePaths = [];
  for (let i = 0; i < frames.length; i++) {
    const tmpPath = `/tmp/screen_frame_${Date.now()}_${i}.png`;
    fs.writeFileSync(tmpPath, frames[i].buffer);
    tmpFramePaths.push(tmpPath);
  }

  const screenAnalysisPrompt = `Read the screenshot image files listed below, then analyze them. These are ${tmpFramePaths.length} sequential screenshots taken 2 seconds apart.

Image files to read:
${tmpFramePaths.map((p, i) => `- Frame ${i + 1}: ${p}`).join('\n')}

You have TWO jobs:

**JOB 1 — FLAG:** Actionable insight ONLY if flag-worthy (errors, mistakes, security issues, optimization tips). Otherwise: FLAG: NOTHING

**JOB 2 — WORKFLOW:** What the operator is doing/using — apps, design choices, patterns. If idle/lock screen: WORKFLOW: NOTHING

FORMAT:
FLAG: [insight or NOTHING]
WORKFLOW: [observation or NOTHING]

Be concise. 1-2 sentences per section max. Previous context (avoid repeating): "${lastScreenContext}"`;

  let reply = '';
  try {
    reply = await runClaudeCLI(screenAnalysisPrompt, 60000, { allowTools: true }) || '';
  } catch (e) {
    console.warn('[SCREEN] Claude CLI analysis failed:', e.message);
  }

  // Cleanup temp files
  for (const p of tmpFramePaths) { try { fs.unlinkSync(p); } catch {} }

  // Parse the two sections
  const flagMatch = reply.match(/FLAG:\s*(.+?)(?:\n|$)/i);
  const workflowMatch = reply.match(/WORKFLOW:\s*(.+?)(?:\n|$)/i);

  const flagText = flagMatch?.[1]?.trim() || '';
  const workflowText = workflowMatch?.[1]?.trim() || '';

  // Handle flag — send to operator if noteworthy
  if (flagText && !flagText.includes('NOTHING') && flagText.length > 5) {
    const latestFrame = frames[frames.length - 1];
    await sock.sendMessage(operatorJid, { image: latestFrame.buffer, caption: `*[Screen Awareness]*\n${flagText}` });
    lastScreenContext = flagText.substring(0, 200);
    console.log(`[SCREEN] FLAGGED — sent insight + screenshot (${flagText.length} chars)`);
  } else {
    console.log('[SCREEN] Nothing flag-worthy — trashed batch');
  }

  // Handle workflow — silently accumulate for learning
  if (workflowText && !workflowText.includes('NOTHING') && workflowText.length > 5) {
    screenWorkflowLog.push(workflowText);
    console.log(`[SCREEN] LEARNED — ${workflowText.substring(0, 80)}...`);
  }
}

// ─── BAILEYS WHATSAPP ───
// Use OpenClaw's credential store so no QR re-scan needed
const AUTH_DIR = config.whatsapp?.credentialsDir || '/root/whatsapp-bot/auth-state';
let sock;
let restartAttempts = 0;

async function startWhatsApp() {
  // Clean up previous socket to prevent overlapping connections (fixes 440 loop)
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(); } catch(e) {}
    sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    browser: ['Favor', 'Chrome', '125.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[WHATSAPP] QR code displayed — scan with WhatsApp');
      try { require('qrcode-terminal').generate(qr, { small: true }); } catch(e) {}
      try { require('qrcode').toFile('/tmp/whatsapp-qr.png', qr, { scale: 8 }); console.log('[WHATSAPP] QR saved to /tmp/whatsapp-qr.png'); } catch(e) {}
    }

    if (connection === 'open') {
      restartAttempts = 0;
      // Set presence to receive messages (critical for Baileys)
      await sock.sendPresenceUpdate('available');
      // Register known LID-to-phone mappings from credentials
      if (sock.user?.id && sock.user?.lid) {
        registerLidMapping(sock.user.lid, sock.user.id);
        console.log(`[FAVOR] Self: ${sock.user.id} <-> ${sock.user.lid}`);
      }
      // Register operator LID mapping (from creds.me)
      const creds = state.creds;
      if (creds.me?.lid && creds.me?.id) {
        registerLidMapping(creds.me.lid, creds.me.id);
      }
      // ─── AUTO-RESOLVE OPERATOR LID ───
      // Baileys now sends messages as LID JIDs — look up the operator's LID
      // so isOperator() works even when messages arrive as @lid instead of @s.whatsapp.net
      const opNum = (config.whatsapp?.operatorNumber || '').replace('+', '');
      if (opNum && sock.onWhatsApp) {
        try {
          const [result] = await sock.onWhatsApp(opNum + '@s.whatsapp.net');
          if (result?.jid) {
            // result.jid may be phone JID or LID — register the mapping either way
            const phoneJid = opNum + '@s.whatsapp.net';
            if (result.jid !== phoneJid) {
              registerLidMapping(result.jid, phoneJid);
              console.log(`[FAVOR] Operator LID resolved: ${opNum} <-> ${result.jid}`);
            }
          }
        } catch (e) {
          console.warn(`[FAVOR] Could not resolve operator LID: ${e.message}`);
        }
      }
      const counts = db.getMemoryCount();
      const cronCount = db.getActiveCrons().length;
      console.log(`[FAVOR] ${config.identity.name} is online (Baileys)`);
      console.log(`[FAVOR] Model: ${config.model.id}`);
      console.log(`[FAVOR] Memories: ${counts.facts}F ${counts.decisions}D ${counts.preferences}P ${counts.tasks}T`);
      console.log(`[FAVOR] Active crons: ${cronCount}`);
      console.log(`[FAVOR] Features: vision, voice, topics, crons, compaction, proactive, alive, sync`);
      db.audit('ready', `WhatsApp connected (Baileys). Model: ${config.model.id}`);
      cronEngine.start();

      // ─── ALIVE ENGINE: connect + register crons ───
      if (alive) {
        alive.setSock(sock);
        alive.ensureCrons();
        console.log('[ALIVE] Connected to WhatsApp + crons registered');
      }

      // Sync: Bot online
      syncBot.sync('bot', {
        type: 'connection',
        summary: `Bot online. Model: ${config.model.id}. Memories: ${counts.facts}F/${counts.decisions}D/${counts.preferences}P. Crons: ${cronCount}`,
        status: 'success',
        objective: 'Operational — awaiting user messages',
        fact: `Bot running model ${config.model.id}`,
        fact_type: 'session'
      });
      syncBot.createCheckpoint(syncBot.loadState(), 'bot_connected');

      // Send startup confirmation to operator (only once per process)
      if (!global._startupMessageSent) {
        global._startupMessageSent = true;
        const operatorJid = (config.whatsapp.operatorNumber || '').replace('+', '') + '@s.whatsapp.net';
        // Wire guardian alerts to WhatsApp
        global._guardianSock = sock;
        global._guardianOperatorJid = operatorJid;
        try {
          await sock.sendMessage(operatorJid, { text: getStartupMessage() });
          console.log('[FAVOR] Sent startup message to operator');
        } catch (e) {
          console.error('[FAVOR] Could not send startup message:', e.message);
        }

        // ─── SELF-CHECK CRON (every 3 days at 5am EST / 10am UTC) ───
        if (!global._selfCheckScheduled) {
          global._selfCheckScheduled = true;
          const scheduleNextSelfCheck = () => {
            const now = new Date();
            // Next 10:00 UTC (5am EST)
            const next = new Date(now);
            next.setUTCHours(10, 0, 0, 0);
            if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
            // Advance to next 3-day boundary (days 1, 4, 7, 10... of month)
            while ((next.getUTCDate() - 1) % 3 !== 0) {
              next.setUTCDate(next.getUTCDate() + 1);
            }
            const delay = next.getTime() - now.getTime();
            console.log(`[SELFCHECK] Next self-check: ${next.toISOString()} (in ${Math.round(delay / 3600000)}h)`);
            setTimeout(async () => {
              try {
                console.log('[SELFCHECK] Running scheduled self-check...');
                const report = await selfCheck.runAll();
                const formatted = selfCheck.formatReport(report);
                const opJid = (config.whatsapp.operatorNumber || '').replace('+', '') + '@s.whatsapp.net';
                // Only alert operator if there are critical issues or warnings
                if (report.critical.length > 0) {
                  await sock.sendMessage(opJid, { text: `🔴 *Self-Check Alert*\n\n${formatted}` });
                } else if (report.warnings.length > 0) {
                  await sock.sendMessage(opJid, { text: formatted });
                }
                console.log(`[SELFCHECK] Complete: ${report.critical.length} critical, ${report.warnings.length} warnings, ${report.cleaned.length} cleanups`);
                db.audit('selfcheck', `critical:${report.critical.length} warnings:${report.warnings.length} cleaned:${report.cleaned.length}`);

                // Run memory consolidation after self-check
                try {
                  const { run: consolidate } = require('./memory-consolidate');
                  const cStats = consolidate();
                  const reduced = cStats.total_before - cStats.total_after;
                  if (reduced > 0) {
                    console.log(`[CONSOLIDATE] Cleaned ${reduced} memories (${cStats.total_before} -> ${cStats.total_after})`);
                    await sock.sendMessage(opJid, { text: `*Memory Consolidation*\n${cStats.total_before} → ${cStats.total_after} memories\nRemoved: ${cStats.junk} junk, ${cStats.duplicates} duplicates, ${cStats.stale} stale` });
                  }
                } catch (ce) {
                  console.warn('[CONSOLIDATE] Failed (non-fatal):', ce.message);
                }
              } catch (e) {
                console.error('[SELFCHECK] Failed:', e.message);
              }
              scheduleNextSelfCheck(); // schedule the next one
            }, delay);
          };
          scheduleNextSelfCheck();
        }
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason;
      console.error(`[WHATSAPP] Disconnected. Status: ${statusCode}`);
      db.audit('disconnected', `status: ${statusCode}`);
      cronEngine.stop();

      // Sync: Bot disconnected
      syncBot.sync('bot', {
        type: 'connection',
        summary: `Bot disconnected. Status: ${statusCode}`,
        status: 'error',
        blocker: `WhatsApp disconnected (status ${statusCode})`
      });

      if (statusCode === reason.loggedOut) {
        console.error('[WHATSAPP] Session invalidated (401). Clearing credentials for fresh start...');
        db.audit('logged_out', 'Session invalidated (401) — clearing credentials');
        // Clear stale credentials to prevent 440 reconnect loop
        const credDir = config.whatsapp?.credentialsDir || '/root/whatsapp-bot/auth-state';
        try {
          if (fs.existsSync(credDir)) {
            const files = fs.readdirSync(credDir);
            for (const file of files) {
              fs.unlinkSync(path.join(credDir, file));
            }
            console.log(`[WHATSAPP] Cleared ${files.length} credential file(s) from ${credDir}`);
          }
        } catch (err) {
          console.error(`[WHATSAPP] Failed to clear credentials: ${err.message}`);
        }
        process.exit(0);
      } else {
        // Auto-reconnect for all other disconnect reasons
        if (restartAttempts < config.service.maxRestartAttempts) {
          restartAttempts++;
          const delay = config.service.restartDelayMs;
          console.log(`[WHATSAPP] Reconnect attempt ${restartAttempts}/${config.service.maxRestartAttempts} in ${delay}ms`);
          setTimeout(() => startWhatsApp(), delay);
        } else {
          console.error('[WHATSAPP] Max restart attempts reached.');
        }
      }
    }
  });

  // Message handler
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    // Accept both 'notify' (real-time) and 'append' (own sent messages echoed back)
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of msgs) {
      try {
        // Learn LID mappings from message metadata
        // Baileys may include both LID and phone JID in different message fields
        if (msg.key?.remoteJid?.endsWith('@lid') && msg.key?.participant && !msg.key.participant.endsWith('@lid')) {
          registerLidMapping(msg.key.remoteJid, msg.key.participant);
        } else if (msg.key?.participant?.endsWith('@lid') && msg.key?.remoteJid && !msg.key.remoteJid.endsWith('@lid')) {
          registerLidMapping(msg.key.participant, msg.key.remoteJid);
        }
        await handleMessage(msg);
      } catch (err) {
        console.error('[MSG ERROR]', err.message, err.stack?.split('\n')[1]);
      }
    }
  });
}

// ─── TELEGRAM STARTUP ───
async function startTelegram() {
  telegramAdapter = new TelegramAdapter(config, {
    onMessage: async (msg) => {
      try {
        await handleMessage(msg);
      } catch (err) {
        console.error('[MSG ERROR]', err.message, err.stack?.split('\n')[1]);
      }
    },
    onReady: (botInfo) => {
      // Create sock-compatible interface
      sock = telegramAdapter.createSockInterface();

      const counts = db.getMemoryCount();
      const cronCount = db.getActiveCrons().length;
      console.log(`[FAVOR] ${config.identity.name} is online (Telegram: @${botInfo.username})`);
      console.log(`[FAVOR] Model: ${config.model.id}`);
      console.log(`[FAVOR] Memories: ${counts.facts}F ${counts.decisions}D ${counts.preferences}P ${counts.tasks}T`);
      console.log(`[FAVOR] Active crons: ${cronCount}`);
      console.log(`[FAVOR] Features: vision, voice, topics, crons, compaction, proactive, alive`);
      db.audit('ready', `Telegram connected (@${botInfo.username}). Model: ${config.model.id}`);
      cronEngine.start();

      // Alive engine
      if (alive) {
        alive.setSock(sock);
        alive.ensureCrons();
        console.log('[ALIVE] Connected to Telegram + crons registered');
      }

      // Sync
      syncBot.sync('bot', {
        type: 'connection',
        summary: `Bot online (Telegram @${botInfo.username}). Model: ${config.model.id}. Memories: ${counts.facts}F/${counts.decisions}D/${counts.preferences}P. Crons: ${cronCount}`,
        status: 'success',
        objective: 'Operational — awaiting user messages',
        fact: `Bot running model ${config.model.id} on Telegram`,
        fact_type: 'session'
      });
      syncBot.createCheckpoint(syncBot.loadState(), 'bot_connected');

      // Send startup confirmation to operator
      if (!global._startupMessageSent && config.telegram?.operatorChatId) {
        global._startupMessageSent = true;
        const operatorJid = `tg_${config.telegram.operatorChatId}`;
        global._guardianSock = sock;
        global._guardianOperatorJid = operatorJid;
        sock.sendMessage(operatorJid, { text: getStartupMessage() }).catch(e => {
          console.error('[FAVOR] Could not send startup message:', e.message);
        });
      }
    },
  });

  await telegramAdapter.start();
  // sock is set in onReady callback above
}

// ─── LID-to-phone mapping (Baileys uses LID JIDs for incoming messages) ───
const lidToPhone = new Map();
const phoneToLid = new Map();

// Known LID mappings (add your own from testing)
// Example: lidToPhone.set('LID_NUMBER', 'PHONE_NUMBER');
// Example: phoneToLid.set('PHONE_NUMBER', 'LID_NUMBER');

function registerLidMapping(lidJid, phoneJid) {
  if (lidJid && phoneJid) {
    lidToPhone.set(lidJid.split('@')[0].split(':')[0], phoneJid.split('@')[0].split(':')[0]);
    phoneToLid.set(phoneJid.split('@')[0].split(':')[0], lidJid.split('@')[0].split(':')[0]);
  }
}

// ─── CONTACT FILTERING & OPERATOR SECURITY ───
// Track numbers verified via security phrase (resets on restart)
const verifiedNumbers = new Set();
// Track numbers awaiting security phrase answer
const pendingAuth = new Set();


function resolvePhone(jid) {
  // Telegram contacts use tg_CHATID format
  if (jid && jid.startsWith('tg_')) return jid;
  if (jid.endsWith('@lid')) {
    const lidNum = jid.split('@')[0].split(':')[0];
    return lidToPhone.get(lidNum) || null;
  }
  return jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
}

function isOperator(jid) {
  // Telegram: check operatorChatId
  if (PLATFORM === 'telegram') {
    const opChatId = config.telegram?.operatorChatId;
    if (!opChatId) return true; // no operator set = backwards compat
    return jid === `tg_${opChatId}` || verifiedNumbers.has(jid);
  }
  const opNum = (config.whatsapp.operatorNumber || '').replace('+', '');
  if (!opNum) return true; // no operator set = backwards compat
  const phone = resolvePhone(jid);
  if (!phone) return false;
  return phone.includes(opNum) || verifiedNumbers.has(phone);
}

function isStaff(jid) {
  const pConfig = PLATFORM === 'telegram' ? (config.telegram || {}) : config.whatsapp;
  const staffList = pConfig.staff || [];
  if (!staffList.length) return false;
  const phone = resolvePhone(jid);
  if (!phone) return false;
  // Telegram: staff list contains chat IDs (tg_12345 or raw 12345)
  if (PLATFORM === 'telegram') {
    return staffList.some(s => jid === `tg_${s}` || jid === s);
  }
  return staffList.some(s => phone.includes(s.replace('+', '')));
}

// Returns 'operator', 'staff', or 'customer'
function getRole(jid) {
  if (isOperator(jid)) return 'operator';
  if (isStaff(jid)) return 'staff';
  return 'customer';
}

// Tool access by role
const OPERATOR_ONLY_TOOLS = new Set([
  'server_exec', 'read_file', 'write_file',
  'laptop_run_command', 'laptop_write_file', 'laptop_read_file', 'laptop_list_files',
  'laptop_open_app', 'laptop_open_url', 'laptop_screenshot', 'laptop_status',
  'browser_evaluate', 'browser_fill_from_vault',
  'email_search', 'email_read'
]);

const STAFF_TOOLS = new Set([
  'memory_save', 'memory_search', 'memory_forget',
  'web_search', 'knowledge_search',
  'cron_create', 'cron_list', 'cron_delete', 'cron_toggle',
  'topic_create', 'topic_switch', 'topic_list',
  'send_message', 'send_email', 'send_image',
  'vault_save', 'vault_get', 'vault_list', 'vault_delete',
  'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_select', 'browser_fill_form', 'browser_get_fields',
  'browser_get_clickables', 'browser_get_text', 'browser_scroll',
  'browser_close', 'browser_status',
  'video_analyze', 'video_learn', 'learn_from_url'
]);

const CUSTOMER_TOOLS = new Set([
  'knowledge_search', 'web_search', 'memory_search'
]);

function canUseTool(role, toolName) {
  if (role === 'operator') return true;
  if (role === 'staff') return STAFF_TOOLS.has(toolName);
  return CUSTOMER_TOOLS.has(toolName); // customer
}

// Admin slash commands — operator only
const ADMIN_COMMANDS = new Set(['/update', '/model', '/reload', '/clear', '/sync', '/recover']);
// Staff slash commands
const STAFF_COMMANDS = new Set(['/status', '/memory', '/brain', '/crons', '/topics', '/help', '/laptop']);

function canUseCommand(role, cmd) {
  if (role === 'operator') return true;
  if (role === 'staff') return STAFF_COMMANDS.has(cmd) || !ADMIN_COMMANDS.has(cmd);
  return cmd === '/help' || cmd === '/status'; // customers can only check help/status
}

// Filter tools list based on role — AI only sees tools the user can access
function getToolsForRole(role) {
  if (role === 'operator') return TOOLS;
  return TOOLS.filter(t => canUseTool(role, t.function.name));
}

function isAllowed(jid) {
  // Telegram: bots only receive messages from users who started a chat
  // Use the same allowlist/open policy from config
  if (PLATFORM === 'telegram') {
    const policy = config.telegram?.dmPolicy || 'open';
    if (policy !== 'allowlist') return true;
    const allowed = config.telegram?.allowFrom || [];
    if (!allowed.length) return true;
    return allowed.includes(jid) || allowed.some(a => jid === `tg_${a}`);
  }
  if (config.whatsapp.dmPolicy !== 'allowlist') return true;
  const combined = [...new Set([
    ...(config.whatsapp.allowFrom || []),
    ...(config.whatsapp.trustedContacts || []),
    ...(config.whatsapp.staff || [])
  ])];
  if (!combined.length) return true;

  const phone = resolvePhone(jid);
  if (phone) {
    return combined.some(a => phone.includes(a.replace('+', '')));
  }

  // Unknown LID — pass through to auth gate (they can authenticate via security phrase)
  if (jid.endsWith('@lid')) {
    console.log(`[SECURITY] Unknown LID ${jid.split('@')[0].split(':')[0]} — passing to auth gate`);
    return true;
  }

  return false;
}

function isGroup(jid) {
  if (PLATFORM === 'telegram') {
    // Telegram group chat IDs are negative numbers
    if (jid && jid.startsWith('tg_-')) return true;
    return false;
  }
  return jid.endsWith('@g.us');
}

// ─── EXTRACT MESSAGE TEXT ───
function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  return '';
}

function getMessageType(msg) {
  const m = msg.message;
  if (!m) return 'unknown';
  if (m.imageMessage) return 'image';
  if (m.audioMessage || m.pttMessage) return 'voice';
  if (m.videoMessage) return 'video';
  if (m.documentMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  return 'text';
}

// ─── MEDIA DOWNLOAD (platform-agnostic) ───
async function downloadMedia(msg) {
  if (PLATFORM === 'telegram' && telegramAdapter) {
    return telegramAdapter.downloadMedia(msg);
  }
  return downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
}

// ─── IMAGE PROCESSING ───
async function processImage(msg) {
  try {
    const buffer = await downloadMedia(msg);
    if (!buffer) return null;

    const mime = msg.message?.imageMessage?.mimetype || msg.message?.stickerMessage?.mimetype || 'image/jpeg';
    const mimeType = mime.split(';')[0];
    console.log(`[VISION] Processing image: ${mimeType} (${Math.round(buffer.length / 1024)}KB)`);

    // Store for forwarding via send_image tool
    lastReceivedImage = { buffer, mimetype: mimeType };

    const base64 = buffer.toString('base64');

    return {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64}` }
    };
  } catch (e) {
    console.error('[VISION] Download failed:', e.message);
    return null;
  }
}

// ─── VOICE PROCESSING ───
async function processVoice(msg) {
  try {
    const buffer = await downloadMedia(msg);
    if (!buffer) return null;

    const mime = msg.message?.audioMessage?.mimetype || msg.message?.pttMessage?.mimetype || 'audio/ogg';
    console.log(`[VOICE] Processing voice note: ${mime}`);
    const transcript = await transcribeVoice(buffer, mime);

    if (transcript) {
      console.log(`[VOICE] Transcribed: ${transcript.substring(0, 80)}`);
      return transcript;
    }
    return null;
  } catch (e) {
    console.error('[VOICE] Processing failed:', e.message);
    return null;
  }
}

// ─── VIDEO PROCESSING ───
async function processVideoMessage(msg) {
  try {
    const buffer = await downloadMedia(msg);
    if (!buffer) return null;

    const size = buffer.length;
    console.log(`[VIDEO] Processing WhatsApp video: ${Math.round(size / 1024 / 1024 * 10) / 10}MB`);

    // Cap at 50MB
    if (size > 50 * 1024 * 1024) {
      return { error: 'Video too large (>50MB). Send a shorter clip or share a link instead.' };
    }

    const saved = videoProcessor.saveBuffer(buffer);
    const result = await videoProcessor.processVideo(saved.path, saved.dir);
    videoProcessor.cleanup(saved.dir);
    return result;
  } catch (e) {
    console.error('[VIDEO] Processing failed:', e.message);
    return { error: 'Video processing failed: ' + e.message };
  }
}

// ─── CRON ENGINE ───
const cronEngine = new CronEngine(db, {
  checkIntervalMs: 30000,
  onTrigger: async (cron) => {
    if (!sock) return;

    let taskData;
    try { taskData = JSON.parse(cron.task); } catch (_) { taskData = { type: 'proactive', prompt: cron.task }; }

    // ─── ALIVE ENGINE (check-ins + memory callbacks) ───
    if (taskData.type && taskData.type.startsWith('alive:') && alive) {
      try {
        await alive.handleTrigger(cron, taskData);
      } catch (err) {
        console.error(`[ALIVE] Trigger error:`, err.message);
      }
      return;
    }

    if (taskData.type === 'proactive' && cron.contact) {
      console.log(`[CRON] Proactive outreach: "${cron.label}" -> ${cron.contact}`);
      try {
        const cronPrompt = `${buildSystemPrompt(cron.contact)}\n\n[SYSTEM: Cron "${cron.label}" fired. ${taskData.prompt}]`;
        const reply = await runClaudeCLI(cronPrompt, 60000) || '';
        if (reply && !reply.includes('SKIP')) {
          const jid = PLATFORM === 'telegram'
            ? (cron.contact.startsWith('tg_') ? cron.contact : `tg_${cron.contact}`)
            : cron.contact.replace('+', '').replace('@c.us', '').replace('@s.whatsapp.net', '') + '@s.whatsapp.net';
          if (!sock) { console.warn('[CRON] Socket disconnected, skipping send'); return; }
          await sock.sendMessage(jid, { text: reply });
          console.log(`[CRON] Sent proactive message (${reply.length} chars)`);
        } else {
          console.log(`[CRON] Skipped (no actionable content)`);
        }
      } catch (err) {
        console.error(`[CRON] Proactive message failed:`, err.message);
      }
    }
  }
});

// ─── MESSAGE DEDUPLICATION ───
// Prevents duplicate processing when WhatsApp delivers the same message twice
const _recentMessages = new Map(); // hash -> timestamp
const DEDUP_WINDOW_MS = 5000;

function isDuplicateMessage(msg) {
  const text = extractText(msg) || '';
  const jid = msg.key.remoteJid || '';
  const key = `${jid}:${text.substring(0, 100)}`;
  const hash = require('crypto').createHash('md5').update(key).digest('hex');
  const now = Date.now();

  if (_recentMessages.has(hash) && now - _recentMessages.get(hash) < DEDUP_WINDOW_MS) {
    return true;
  }
  _recentMessages.set(hash, now);

  // Cleanup old entries every 100 messages
  if (_recentMessages.size > 200) {
    for (const [k, t] of _recentMessages) {
      if (now - t > DEDUP_WINDOW_MS * 2) _recentMessages.delete(k);
    }
  }
  return false;
}

// ─── MESSAGE HANDLER ───
async function handleMessage(msg) {
  // Skip own messages, status broadcasts
  if (msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  if (isDuplicateMessage(msg)) return; // Skip duplicate messages
  const platformConfig = PLATFORM === 'telegram' ? (config.telegram || {}) : config.whatsapp;
  if (isGroup(jid) && !platformConfig.allowGroups) return;
  if (!isAllowed(jid)) return;

  // ─── LID RESOLUTION: resolve unknown LID JIDs on the fly ───
  // If message comes from a LID we haven't mapped yet, try to resolve it via onWhatsApp lookup
  if (jid.endsWith('@lid') && !resolvePhone(jid) && sock.onWhatsApp) {
    try {
      // Look up the LID to find the associated phone number
      const [result] = await sock.onWhatsApp(jid);
      if (result?.jid && result.jid !== jid) {
        registerLidMapping(jid, result.jid);
        console.log(`[LID] Auto-resolved: ${jid} <-> ${result.jid}`);
      }
    } catch (e) {
      // Non-fatal — operator check will just fail gracefully
    }
  }

  // ─── GUARDIAN RATE LIMIT CHECK ───
  const guardCheck = guardian.checkRequest(jid, config.model.id, 'incoming');
  if (!guardCheck.allowed) {
    console.warn(`[GUARDIAN] Blocked request from ${jid}: ${guardCheck.reason}`);
    await sock.sendMessage(jid, { text: `⚠️ ${guardCheck.reason}. Try again later.` });
    return;
  }

  const ts = new Date().toLocaleTimeString();
  const msgType = getMessageType(msg);
  const body = extractText(msg).trim();
  const isVoice = msgType === 'voice';
  const isImage = msgType === 'image' || msgType === 'sticker';
  const isVideo = msgType === 'video';

  if (!body && msgType === 'text') return;

  console.log(`[${ts}] ${jid}: ${isVoice ? '[voice]' : isImage ? '[image]' : body?.substring(0, 80) || `[${msgType}]`}`);

  // Telegram: log chat ID to help users find their operatorChatId
  if (PLATFORM === 'telegram' && msg._telegramChatId) {
    console.log(`[TELEGRAM] Chat ID: ${msg._telegramChatId} (set as telegram.operatorChatId in config.json for admin access)`);
  }

  // ─── ACCESS CONTROL ───
  const role = getRole(jid);

  if (role !== 'operator' && role !== 'staff') {
    const phone = resolvePhone(jid);
    const authKey = phone || jid;
    const textLower = (body || '').toLowerCase().trim();
    const phrase = (platformConfig.securityPhrase || '').toLowerCase();

    // Trusted contacts can message the bot directly
    const trustedList = platformConfig.trustedContacts || [];
    const isTrusted = trustedList.some(t => phone && phone.includes(t.replace('+', '')));

    if (isTrusted) {
      console.log(`[SECURITY] Trusted contact ${phone} — allowing through`);
      // Fall through to normal message handling below
    } else if (verifiedNumbers.has(authKey)) {
      console.log(`[SECURITY] Previously verified ${authKey} — allowing through`);
      // Fall through to normal message handling below
    } else if (platformConfig.dmPolicy === 'open') {
      // Business mode — customers can message freely (with limited tools)
      console.log(`[SECURITY] Customer ${authKey} — open mode, limited tools`);
      // Fall through to normal message handling below
    } else {
      // Allowlist mode — require authentication
      // Step 1: They say "password" → ask for the security phrase
      if (textLower === 'password') {
        pendingAuth.add(authKey);
        await sock.sendMessage(jid, { text: "What's the security phrase?" });
        console.log(`[SECURITY] Auth challenge sent to ${authKey}`);
        return;
      }

      // Step 2: They answer the challenge
      if (pendingAuth.has(authKey)) {
        if (phrase && textLower === phrase) {
          verifiedNumbers.add(authKey);
          pendingAuth.delete(authKey);
          await sock.sendMessage(jid, { text: "Verified. What do you need?" });
          console.log(`[SECURITY] ${authKey} verified via security phrase`);
          return;
        } else {
          pendingAuth.delete(authKey);
          await sock.sendMessage(jid, { text: "That's not right. Access denied." });
          console.log(`[SECURITY] ${authKey} failed security phrase`);
          return;
        }
      }

      // Not operator, not staff, not authenticating — ignore
      console.log(`[SECURITY] Blocked non-operator message from ${authKey}`);
      return;
    }
  }

  // ─── COMMANDS ───
  if (body) {
    const cmd = body.toLowerCase();

    // Command access control
    if (cmd.startsWith('/') && !canUseCommand(role, cmd.split(' ')[0])) {
      await sock.sendMessage(jid, { text: 'That command is not available. Type /help to see what you can do.' });
      return;
    }

    // Screen awareness toggle
    if (cmd.includes('screen awareness on') || cmd.includes('turn on screen awareness') || cmd.includes('start watching my screen')) {
      startScreenAwareness();
      await sock.sendMessage(jid, { text: `*Screen Awareness is ON (Filmstrip Mode)*\nCapturing every 2 seconds, analyzing 3 frames at a time — I see what you're *doing*, not just what's on screen.\n\nAfter 1 minute I'll ask if you want me to keep going. Say *"screen awareness off"* or *"stop"* anytime to disable.` });
      return;
    }
    if (cmd.includes('screen awareness off') || cmd.includes('turn off screen awareness') || cmd.includes('stop watching my screen') || (cmd === 'stop' && screenAwarenessActive)) {
      stopScreenAwareness();
      await sock.sendMessage(jid, { text: '*Screen Awareness is OFF*' });
      return;
    }
    if ((cmd.includes('keep going') || cmd.includes('yes') || cmd.includes('continue')) && screenAwaitingContinue) {
      await sock.sendMessage(jid, { text: '*Continuing screen monitoring.* Next check-in in 1 minute.' });
      resumeScreenAwareness();
      return;
    }

    if (cmd === '/clear') {
      db.clearSession(jid);
      await sock.sendMessage(jid, { text: 'Conversation cleared. Memories intact.' });
      return;
    }

    if (cmd === '/status') {
      const counts = db.getMemoryCount();
      const { messages } = getHistory(jid);
      const kDir = path.resolve(__dirname, config.knowledge.dir);
      const kFiles = fs.existsSync(kDir) ? fs.readdirSync(kDir).filter(f => f.endsWith('.txt') || f.endsWith('.md')) : [];
      const on = await isLaptopOnline();
      const threads = db.getOpenThreads(jid);
      const total = counts.facts + counts.decisions + counts.preferences + counts.tasks;
      const uptime = process.uptime();
      const hrs = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const cronCount = db.getActiveCrons().length;
      const topicCount = db.getTopics(jid).length;
      const summaryCount = db.getCompactionSummaries(jid).length;
      await sock.sendMessage(jid, { text:
        `*${config.identity.name} — Status*\n` +
        `Model: ${config.model.id}\n` +
        `Uptime: ${hrs}h ${mins}m\n` +
        `Messages: ${messages.length}\n` +
        `Knowledge: ${kFiles.length} files\n` +
        `Memories: ${total} (${counts.facts}F ${counts.decisions}D ${counts.preferences}P ${counts.tasks}T)\n` +
        `Topics: ${topicCount} | Crons: ${cronCount} | Compactions: ${summaryCount} | Threads: ${threads.length}\n` +
        `Laptop: ${on ? 'Connected' : 'Offline'}\n` +
        `Screen Awareness: ${config.screenAwareness?.enabled ? 'ON' : 'OFF'}\n` +
        `Features: vision, voice, topics, crons, compaction, alive\n` +
        `Alive: ${alive ? 'ON' : 'OFF'}\n` +
        `Engine: Favor (Baileys)`
      });
      return;
    }

    if (cmd === '/brain') {
      const kDir = path.resolve(__dirname, config.knowledge.dir);
      const kFiles = fs.existsSync(kDir) ? fs.readdirSync(kDir).filter(f => f.endsWith('.txt') || f.endsWith('.md')) : [];
      await sock.sendMessage(jid, { text: kFiles.length ? '*Brain:*\n' + kFiles.map(f => '- ' + f).join('\n') : 'No knowledge files.' });
      return;
    }

    if (cmd === '/laptop') {
      const on = await isLaptopOnline();
      await sock.sendMessage(jid, { text: on ? 'Laptop *online*.' : 'Laptop *offline*. Run tunnel script.' });
      return;
    }

    if (cmd === '/memory') {
      const mem = db.getAllMemories();
      const lines = [];
      if (mem.facts.length) lines.push(`*Facts (${mem.facts.length}):*\n` + mem.facts.slice(-10).map(f => '- ' + f.content).join('\n'));
      if (mem.decisions.length) lines.push(`*Decisions (${mem.decisions.length}):*\n` + mem.decisions.slice(-10).map(d => '- ' + d.content).join('\n'));
      if (mem.preferences.length) lines.push(`*Preferences (${mem.preferences.length}):*\n` + mem.preferences.slice(-10).map(p => '- ' + p.content).join('\n'));
      if (mem.tasks.length) lines.push(`*Tasks (${mem.tasks.length}):*\n` + mem.tasks.slice(-10).map(t => `- [${t.status || '?'}] ${t.content}`).join('\n'));
      await sock.sendMessage(jid, { text: lines.length ? lines.join('\n\n') : 'No memories yet.' });
      return;
    }

    if (cmd.startsWith('/model')) {
      const parts = body.split(/\s+/);
      if (parts.length < 2) {
        await sock.sendMessage(jid, { text: `*Current model:* ${config.model.id}\n\nUsage: /model <model-id>` });
        return;
      }
      const newModel = parts[1];
      config.model.id = newModel;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      db.audit('model.switch', `Switched to ${newModel}`);
      await sock.sendMessage(jid, { text: `Model switched to *${newModel}*` });
      return;
    }

    if (cmd === '/reload') {
      const result = reloadConfig();
      KNOWLEDGE = loadKnowledge();
      await sock.sendMessage(jid, { text: result.error ? `Reload failed: ${result.error}` : `Config reloaded. Model: ${config.model.id}` });
      return;
    }

    if (cmd === '/crons') {
      const crons = db.getCrons(jid);
      if (!crons.length) { await sock.sendMessage(jid, { text: 'No scheduled tasks.' }); return; }
      const list = crons.map(c => `#${c.id} [${c.enabled ? 'ON' : 'OFF'}] *${c.label}*\n  ${c.schedule} | Next: ${c.next_run || 'N/A'}`).join('\n\n');
      await sock.sendMessage(jid, { text: `*Scheduled Tasks:*\n\n${list}` });
      return;
    }

    if (cmd === '/topics') {
      const topics = db.getTopics(jid);
      if (!topics.length) { await sock.sendMessage(jid, { text: 'No topics. All conversation is in the main thread.' }); return; }
      const list = topics.map(t => `${t.active ? '→ ' : '  '}#${t.id} *${t.name}* (${t.updated_at})`).join('\n');
      await sock.sendMessage(jid, { text: `*Topics:*\n\n${list}\n\nActive topic has → arrow.` });
      return;
    }

    if (cmd === '/sync') {
      const state = syncBot.loadState();
      const drift = syncBot.detectDrift(state);
      const events = syncBot.readRecentEvents(5);
      const recentLines = events.map(e => `[${e.timestamp.slice(11,19)}] ${e.source_agent}: ${e.summary}`).join('\n');
      const driftText = drift.length > 0 ? drift.map(d => `⚠ ${d.message}`).join('\n') : 'No drift detected';
      await sock.sendMessage(jid, { text:
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
      return;
    }

    if (cmd === '/recover') {
      const recovery = syncBot.recover();
      await sock.sendMessage(jid, { text:
        `*State Recovery*\n\n` +
        `*Mission:* ${recovery.mission || 'none'}\n` +
        `*Unfinished tasks:* ${recovery.unfinished_tasks.length}\n` +
        `*Last success:* ${recovery.last_successful_action || 'none'}\n` +
        `*Last failure:* ${recovery.last_failed_action || 'none'}\n` +
        `*Blockers:* ${(recovery.open_blockers || []).join(', ') || 'none'}\n` +
        `*Next step:* ${recovery.recommended_next}\n\n` +
        `*Recent events:*\n${recovery.recent_events_summary.slice(-5).join('\n') || 'none'}`
      });
      return;
    }

    if (cmd === '/update') {
      await sock.sendMessage(jid, { text: 'Updating to latest version...' });
      try {
        const { execSync } = require('child_process');
        const dir = __dirname;
        // Stash local changes if any
        const localChanges = execSync(`cd ${dir} && git status --porcelain 2>/dev/null | grep -v '??' || true`, { timeout: 10000 }).toString().trim();
        let stashed = false;
        if (localChanges) {
          execSync(`cd ${dir} && git stash push -m "favor-update-$(date +%Y%m%d-%H%M%S)"`, { timeout: 10000 });
          stashed = true;
        }
        // Pull updates
        const pull = execSync(`cd ${dir} && git pull origin master 2>&1`, { timeout: 30000 }).toString().trim();
        // Restore local changes
        let customStatus = '';
        if (stashed) {
          try {
            execSync(`cd ${dir} && git stash pop`, { timeout: 10000 });
            customStatus = '\n\nYour custom code was preserved.';
          } catch (e) {
            customStatus = '\n\n⚠ Merge conflict with your custom code. Run ./update.sh on the server to fix.';
            execSync(`cd ${dir} && git checkout . 2>/dev/null; git stash pop 2>/dev/null || true`, { timeout: 10000 });
          }
        }
        execSync(`cd ${dir} && npm install --silent 2>&1`, { timeout: 60000 });
        await sock.sendMessage(jid, { text: `*Update complete.*\n\n${pull}${customStatus}\n\nRestarting...` });
        setTimeout(() => process.exit(0), 2000); // pm2 will restart
      } catch (err) {
        await sock.sendMessage(jid, { text: `Update failed: ${err.message}` });
      }
      return;
    }

    if (cmd === '/help') {
      await sock.sendMessage(jid, { text:
        `*${config.identity.name} — Commands*\n\n` +
        `/status — System status\n` +
        `/memory — View memories\n` +
        `/brain — Knowledge files\n` +
        `/laptop — Laptop status\n` +
        `/model <id> — Switch model\n` +
        `/crons — View scheduled tasks\n` +
        `/topics — View conversation topics\n` +
        `/sync — Memory sync status\n` +
        `/recover — Recover shared state\n` +
        `/reload — Reload config\n` +
        `/update — Update to latest version\n` +
        `/clear — Clear conversation\n` +
        `/help — This message\n\n` +
        `*Features:* vision, voice notes, topics, scheduled tasks, proactive outreach, smart compaction, memory sync, alive (check-ins + memory callbacks)`
      });
      return;
    }
  }

  // ─── AI CONVERSATION ───
  try {
    const { messages: history, topicId } = getHistory(jid);

    // Build user message content
    let userContent = [];

    if (isImage) {
      const imageBlock = await processImage(msg);
      if (imageBlock) {
        userContent.push(imageBlock);
        userContent.push({ type: 'text', text: body || 'What do you see in this image?' });
      } else {
        userContent.push({ type: 'text', text: body || '(sent an image that could not be processed)' });
      }
    } else if (isVideo) {
      await sock.sendMessage(jid, { text: 'Processing your video...' });
      const videoResult = await processVideoMessage(msg);
      if (videoResult && !videoResult.error) {
        const videoSummary = `[Video message — ${videoResult.duration}s, ${videoResult.frameCount} frames]\n\n**Summary:** ${videoResult.summary}${videoResult.transcript ? '\n\n**Transcript:** ' + videoResult.transcript.substring(0, 1500) : ''}`;
        userContent.push({ type: 'text', text: `${body ? body + '\n\n' : ''}${videoSummary}` });
      } else {
        userContent.push({ type: 'text', text: `${body || ''}\n[Operator sent a video${videoResult?.error ? ': ' + videoResult.error : ' that could not be processed'}]`.trim() });
      }
    } else if (isVoice) {
      const transcript = await processVoice(msg);
      if (transcript) {
        userContent.push({ type: 'text', text: `[Voice note transcription]: ${transcript}` });
      } else {
        userContent.push({ type: 'text', text: '[Operator sent a voice note but transcription is unavailable.]' });
      }
    } else if (msgType !== 'text') {
      userContent.push({ type: 'text', text: `${body || ''}\n[Operator also sent a ${msgType} file]`.trim() });
    } else {
      userContent.push({ type: 'text', text: body });
    }

    // Tag messages based on role
    if (role !== 'operator') {
      let tag = '';
      if (role === 'staff') {
        tag = `[Message from STAFF member — NOT the operator. They have access to business tools (memory, scheduling, messaging, vault, browser). Help them with business operations. Do NOT give access to server admin, laptop, or system tools. If they need something only the operator can do, let them know.]`;
      } else {
        // Customer
        const contactPhone = resolvePhone(jid);
        const trustedList = config.whatsapp.trustedContacts || [];
        const isTrusted = trustedList.some(t => contactPhone && contactPhone.includes(t.replace('+', '')));
        const isBotContact = contactPhone && config.whatsapp.botContacts && config.whatsapp.botContacts.some(b => contactPhone.includes(b.replace('+', '')));

        // Recall per-contact memories for non-operator contacts
        const contactMems = db.getContactMemories(jid, 5);
        const contactMemContext = contactMems.length
          ? '\n[What you remember about this person]:\n' + contactMems.map(m => '- ' + m.content).join('\n')
          : '';

        if (isBotContact) {
          tag = `[Message from another AI bot — NOT a human. Communicate bot-to-bot: be direct, structured, and actionable. Do NOT give access to vault, laptop, or sensitive tools.]${contactMemContext}`;
        } else if (isTrusted) {
          tag = `[Message from trusted contact — NOT the operator. Respond helpfully using memory_search and knowledge_search. Do NOT give access to vault, laptop, or sensitive operator tools.]${contactMemContext}`;
        } else {
          tag = `[Message from a CUSTOMER. You can ONLY use knowledge_search and web_search to help answer their questions. Be helpful, professional, and on-brand. NEVER reveal internal business data, operator info, server details, or system commands. If they need something beyond your knowledge, tell them to contact the business directly. Do NOT attempt to use any tools besides knowledge_search, web_search, and memory_search.]`;
        }
      }

      if (tag) {
        if (userContent.length === 1 && userContent[0].type === 'text') {
          userContent[0].text = `${tag}\n${userContent[0].text}`;
        } else {
          userContent.unshift({ type: 'text', text: tag });
        }
      }
    }

    if (userContent.length === 1 && userContent[0].type === 'text') {
      history.push({ role: 'user', content: userContent[0].text });
    } else {
      history.push({ role: 'user', content: userContent });
    }

    // Send typing indicator
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);

    // Auto-recall relevant memories for this message (non-fatal)
    const messageTextForRecall = body || '';
    let relevantMemories = [];
    try {
      relevantMemories = await autoRecallMemories(messageTextForRecall);
      if (relevantMemories.length) console.log(`[MEMORY] Auto-recalled ${relevantMemories.length} relevant memories`);
    } catch (e) {
      console.warn('[MEMORY] Auto-recall failed (non-fatal):', e.message);
    }

    // ─── START REMOTE: direct handler (bypass routing) ───
    if (/\b(start remote|remote session|code from phone|start coding|launch claude code)\b/i.test(body) && isOperator(jid)) {
      try {
        await sock.sendMessage(jid, { text: '🖥️ Starting remote code session...' });
        const result = await executeTool('start_remote', { directory: '/root' }, { contact: jid });
        if (result && result !== '__IMAGE_SENT__') {
          await sock.sendMessage(jid, { text: result });
        }
      } catch (e) {
        await sock.sendMessage(jid, { text: 'Failed to start remote session: ' + e.message });
      }
      return;
    }

    // ─── TEACH MODE: check for trigger match before routing ───
    const teachMatch = db.matchTeachCommand(jid, body);
    if (teachMatch) {
      const pipeline = JSON.parse(teachMatch.pipeline);
      console.log(`[TEACH] Matched command #${teachMatch.id}: "${teachMatch.command_name}" (${pipeline.length} steps)`);
      await sock.sendMessage(jid, { text: `⚡ *${teachMatch.command_name}*` });
      const results = [];
      for (let i = 0; i < pipeline.length; i++) {
        const step = pipeline[i];
        try {
          const result = await executeTool(step.tool, step.params || {}, { contact: jid });
          results.push({ step: step.description || step.tool, result, ok: true });
        } catch (e) {
          results.push({ step: step.description || step.tool, result: e.message, ok: false });
          break;
        }
      }
      db.recordTeachExecution(teachMatch.id);
      const summary = results.map((r, i) => `${r.ok ? '✓' : '✗'} ${r.step}`).join('\n');
      await sock.sendMessage(jid, { text: summary || 'Done.' });
      history.push({ role: 'user', content: [{ type: 'text', text: body }] });
      history.push({ role: 'assistant', content: `[Teach Mode] Executed "${teachMatch.command_name}":\n${summary}` });
      db.saveSession(jid, history);
      return;
    }

    const systemMsg = { role: 'system', content: buildSystemPrompt(jid, messageTextForRecall, relevantMemories) };
    const routerStart = Date.now();

    // ─── DECISION ROUTER ───
    const recentContext = history.slice(-3).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    const userText = typeof history[history.length - 1]?.content === 'string'
      ? history[history.length - 1].content
      : body || '';
    const decision = await classify(openai, userText, recentContext);

    // Sync: message received, routed
    syncBot.sync('bot', {
      type: 'message_received',
      summary: `Message from ${jid.split('@')[0]}: route=${decision.route}, escalation=${decision.escalation_score || 0}`,
      step: `processing message (route: ${decision.route})`
    });

    // Videos still need GPT-4o (Claude CLI can't process video frames)
    if (isVideo && ['mini', 'claude', 'chat'].includes(decision.route)) {
      decision.route = 'full';
      decision.reason += ' (escalated: message contains video)';
    }

    console.log(`[ROUTER] route=${decision.route} score=${decision.escalation_score} reason="${decision.reason}"`);

    // ─── SECURITY: Block tool/device routes for non-operator contacts ───
    if (!isOperator(jid) && ['tool', 'hybrid', 'agent'].includes(decision.route)) {
      console.warn(`[SECURITY] Blocked ${decision.route} route for non-operator — downgrading to chat`);
      decision.route = 'chat';
    }

    let reply = '';
    let modelUsed = config.model.id;
    const toolsUsed = [];

    // ─── ROUTE: image — Claude CLI with vision (free via Max subscription) ───
    if (!reply && isImage) {
      let imgPath = null;
      try {
        // Save image to temp file for Claude CLI to read
        const imgExt = (lastReceivedImage?.mimetype || 'image/jpeg').split('/')[1]?.replace('webp', 'png') || 'jpg';
        imgPath = `/tmp/favor_vision_${Date.now()}.${imgExt}`;
        const imgBuffer = lastReceivedImage?.buffer;
        if (!imgBuffer) throw new Error('No image buffer available — download may have failed');

        fs.writeFileSync(imgPath, imgBuffer);
        console.log(`[VISION] Saved image to ${imgPath} (${Math.round(imgBuffer.length / 1024)}KB) for Claude CLI`);

        const recentHistory = history.slice(-10).map(m => {
          if (m.role === 'tool') return null;
          if (m.tool_calls) return null;
          const content = typeof m.content === 'string' ? m.content : '';
          if (!content) return null;
          return `${m.role === 'user' ? 'Human' : 'Assistant'}: ${content}`;
        }).filter(Boolean).join('\n\n');

        const cliPrompt = `${buildSystemPrompt(jid, messageTextForRecall, relevantMemories)}

=== CONVERSATION ===
${recentHistory}

The operator just sent an image. Read the image file at: ${imgPath}
Their message: ${body || 'What do you see in this image?'}

Analyze the image and respond naturally. Be yourself — follow your identity, personality, and rules from your knowledge files.`;
        const cliResult = await runClaudeCLI(cliPrompt, 90000, { imagePath: imgPath });
        reply = cliResult;
        modelUsed = 'claude-cli-vision';
        history.push({ role: 'assistant', content: reply });
      } catch (cliErr) {
        console.warn('[VISION] Claude CLI vision failed, falling back to GPT-4o:', cliErr.message);
        decision.route = 'full'; // ensure GPT-4o fallback picks it up
      } finally {
        // Always clean up temp file
        if (imgPath) fs.unlink(imgPath, () => {});
      }
    }

    // ─── ROUTE: claude — engineering tasks via Claude CLI ───
    if (!reply && decision.route === 'claude') {
      try {
        const cliPrompt = `You are an engineering assistant for the operator's system.
Working directory: /root/favor
Task: ${userText}
Be concise. Return your analysis/solution directly.`;
        const cliResult = await runClaudeCLI(cliPrompt);
        reply = `*[Claude Engineering]*\n\n${cliResult}`;
        modelUsed = 'claude-cli';
        history.push({ role: 'assistant', content: reply });
      } catch (cliErr) {
        console.warn('[ROUTER] Claude CLI failed, escalating to GPT-4o:', cliErr.message);
        decision.route = 'full'; // fall through to full below
      }
    }

    // ─── ROUTE: chat / full (no media) — Claude CLI via Max subscription ───
    if (!reply && (decision.route === 'chat' || decision.route === 'full') && !isImage && !isVideo) {
      try {
        // Build conversation context for Claude CLI
        const recentHistory = history.slice(-10).map(m => {
          if (m.role === 'tool') return null; // skip tool results
          if (m.tool_calls) return null; // skip tool call messages
          const content = typeof m.content === 'string' ? m.content : '';
          if (!content) return null;
          return `${m.role === 'user' ? 'Human' : 'Assistant'}: ${content}`;
        }).filter(Boolean).join('\n\n');

        const cliPrompt = `${buildSystemPrompt(jid, messageTextForRecall, relevantMemories)}

=== TOOLS AVAILABLE ===
You can take actions via Bash commands:
- Send WhatsApp message: curl -s -X POST http://localhost:3099/send -H 'Content-Type: application/json' -d '{"to":"+1XXXXXXXXXX","message":"your message"}'
- Send email: python3 /root/send-gmail.py <to> <subject> <body> [attachment]
- Search bot memory: curl -s http://localhost:3099/memory-search?q=query (if available)
- Run server commands: any bash command
When you need to message someone, USE these tools. Do NOT say you can't send messages.

=== CONVERSATION ===
${recentHistory}

Respond to the latest message. Be yourself — follow your identity, personality, and rules from your knowledge files.`;
        const cliResult = await runClaudeCLI(cliPrompt, 180000, { allowTools: true });
        reply = cliResult;
        modelUsed = 'claude-cli';
        history.push({ role: 'assistant', content: reply });
      } catch (cliErr) {
        console.warn('[ROUTER] Claude CLI attempt 1 failed for chat/full:', cliErr.message);
        // Retry with simplified prompt — do NOT fall back to GPT-4o
        try {
          const retryPrompt = `${buildSystemPrompt(jid, messageTextForRecall, relevantMemories)}\n\n=== CONVERSATION ===\nHuman: ${userText}\n\nRespond to the latest message. Be yourself — follow your identity, personality, and rules from your knowledge files.`;
          const cliResult = await runClaudeCLI(retryPrompt, 180000);
          reply = cliResult;
          modelUsed = 'claude-cli';
          history.push({ role: 'assistant', content: reply });
          console.log('[ROUTER] Claude CLI retry 1 succeeded');
        } catch (retryErr1) {
          console.warn('[ROUTER] Claude CLI attempt 2 failed:', retryErr1.message);
          // Final attempt — minimal prompt
          try {
            const finalPrompt = `Reply to this message:\n\n${userText}`;
            const cliResult = await runClaudeCLI(finalPrompt, 180000);
            reply = cliResult;
            modelUsed = 'claude-cli';
            history.push({ role: 'assistant', content: reply });
            console.log('[ROUTER] Claude CLI retry 2 succeeded');
          } catch (retryErr2) {
            console.error('[ROUTER] Claude CLI failed 3 times:', retryErr2.message);
            reply = 'Sorry, I\'m having trouble thinking right now. Try again in a moment.';
            modelUsed = 'claude-cli-failed';
            history.push({ role: 'assistant', content: reply });
          }
        }
      }
    }

    // ─── ROUTE: gemini — large document analysis via Gemini ───
    if (!reply && decision.route === 'gemini') {
      try {
        const geminiPrompt = `You are an analyst for the Favor AI assistant. Analyze the following request thoroughly.

Context from recent conversation: ${recentContext.slice(-500)}

Request: ${userText}

Provide a detailed, well-structured analysis. Use markdown formatting.`;
        const geminiResult = await runGeminiAnalyst(geminiPrompt, costTracker);
        reply = `*[Gemini Analyst]*\n\n${geminiResult}`;
        modelUsed = 'gemini-analyst';
        // ─── AUTO-SAVE: extract & persist Gemini analyst findings ───
        autoSaveFindings(userText, geminiResult, 'gemini').catch(() => {});
      } catch (gemErr) {
        console.warn('[ROUTER] Gemini analyst failed, escalating to GPT-4o:', gemErr.message);
        decision.route = 'full';
      }
    }

    // ─── ROUTE: kimi — structured artifact production via Kimi ───
    if (!reply && decision.route === 'kimi') {
      try {
        const kimiPrompt = `Task from the Favor AI assistant:

${userText}

Context: ${recentContext.slice(-500)}

Produce a well-structured, professional output. Use markdown formatting with headers, tables, and lists as appropriate.`;
        const kimiResult = await runKimi(kimiPrompt, config, costTracker);
        reply = `*[Kimi Worker]*\n\n${kimiResult}`;
        modelUsed = 'kimi-k2';
      } catch (kimiErr) {
        console.warn('[ROUTER] Kimi failed, escalating to GPT-4o:', kimiErr.message);
        decision.route = 'full';
      }
    }

    // ─── ROUTE: mini — try Claude CLI first, fall back to gpt-4o-mini for tool tasks ───
    if (!reply && decision.route === 'mini') {
      // Try Claude CLI first for simple responses
      try {
        const recentHistoryMini = history.slice(-10).map(m => {
          if (m.role === 'tool') return null;
          if (m.tool_calls) return null;
          const content = typeof m.content === 'string' ? m.content : '';
          if (!content) return null;
          return `${m.role === 'user' ? 'Human' : 'Assistant'}: ${content}`;
        }).filter(Boolean).join('\n\n');

        const cliPrompt = `${buildSystemPrompt(jid, messageTextForRecall, relevantMemories)}

=== TOOLS AVAILABLE ===
You can take actions via Bash commands:
- Send WhatsApp message: curl -s -X POST http://localhost:3099/send -H 'Content-Type: application/json' -d '{"to":"+1XXXXXXXXXX","message":"your message"}'
- Send email: python3 /root/send-gmail.py <to> <subject> <body> [attachment]
When you need to message someone, USE these tools. Do NOT say you can't send messages.

=== CONVERSATION ===
${recentHistoryMini}

Respond briefly and directly. Be yourself — follow your identity, personality, and rules from your knowledge files.`;
        const cliResult = await runClaudeCLI(cliPrompt, 30000, { allowTools: true });
        reply = cliResult;
        modelUsed = 'claude-cli';
        history.push({ role: 'assistant', content: reply });
      } catch (cliErr) {
        console.warn('[ROUTER] Claude CLI failed for mini, falling back to gpt-4o-mini:', cliErr.message);
      }

      // Fall back to gpt-4o-mini with tools if Claude CLI failed
      if (!reply) {
        let miniResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 1024,
          tools: getToolsForRole(role),
          messages: [systemMsg, ...history]
        });
        let miniLoops = 0;
        while (miniResponse.choices?.[0]?.finish_reason === 'tool_calls' && miniLoops < 5) {
          miniLoops++;
          const assistantMsg = miniResponse.choices[0].message;
          if (assistantMsg.content && assistantMsg.content.trim() && isOperator(jid)) {
            if (sock) await sock.sendMessage(jid, { text: assistantMsg.content.trim() });
          }
          history.push(assistantMsg);
          for (const toolCall of (assistantMsg.tool_calls || [])) {
            let input;
            try { input = JSON.parse(toolCall.function.arguments); } catch (parseErr) {
              console.error(`[TOOL/mini] Failed to parse args for ${toolCall.function.name}:`, parseErr.message);
              history.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error parsing tool arguments: ${parseErr.message}` });
              continue;
            }
            console.log(`[TOOL/mini] ${toolCall.function.name}: ${JSON.stringify(input).substring(0, 100)}`);
            toolsUsed.push(toolCall.function.name);
            const result = await executeTool(toolCall.function.name, input, { contact: jid, role: getRole(jid) });
            history.push({ role: 'tool', tool_call_id: toolCall.id, content: String(result) });
          }
          await sock.sendPresenceUpdate('composing', jid);
          miniResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 1024,
            tools: getToolsForRole(role),
            messages: [systemMsg, ...history]
          });
        }
        reply = miniResponse.choices?.[0]?.message?.content || '';
        if (miniResponse.choices?.[0]?.message) history.push(miniResponse.choices[0].message);
        modelUsed = 'gpt-4o-mini';
      }
    }

    // ─── ROUTE: memory — pre-fetch relevant memory before reasoning ───
    if (!reply && decision.route === 'memory') {
      const memResults = db.search(userText.slice(0, 100));
      if (memResults.length) {
        const memContext = memResults.slice(0, 5).map(m => `[${m.category}] ${m.content}`).join('\n');
        history[history.length - 1] = {
          role: 'user',
          content: `${userText}\n\n[Relevant memory retrieved]:\n${memContext}`
        };
      }
      decision.route = 'full'; // then full reasoning with injected memory
    }

    // ─── ROUTE: tool / hybrid / agent — Try Claude CLI first (free), fall back to GPT-4o ───
    if (!reply && (decision.route === 'tool' || decision.route === 'hybrid' || decision.route === 'agent')) {
      // First attempt: Claude CLI with tool-runner.js (free via Max/Pro subscription)
      try {
        const toolRunnerPath = path.join(__dirname, 'tool-runner.js');
        const operatorNum = PLATFORM === 'telegram'
          ? (config.telegram?.operatorChatId || '')
          : (config.whatsapp?.operatorNumber || '');
        const toolPrompt = `DO NOT EXPLAIN. Execute immediately using Bash.

User wants: "${userText}"

Tool runner: node ${toolRunnerPath} TOOL 'JSON'

Tools: laptop_open_app({"app":"path"}), laptop_open_url({"url":"..."}), laptop_run_command({"command":"..."}), laptop_status, phone_open_app({"app":"name"}), phone_status, phone_shell({"command":"..."}), server_exec({"command":"..."}), memory_search({"query":"..."}), cron_list, web_search({"query":"..."})

For SCREENSHOTS: phone_screenshot and laptop_screenshot produce a file path. After running the tool, send the image:
curl -s -X POST http://localhost:3099/send-image -H 'Content-Type: application/json' -d '{"to":"${operatorNum}","image_path":"THE_PATH_FROM_TOOL","caption":"Screenshot"}'

Run the Bash command NOW.`;
        const cliResult = await runClaudeCLI(toolPrompt, 45000, { allowTools: true, model: 'haiku' });
        if (cliResult && cliResult.trim()) {
          // If tool already sent an image/result via /trigger, don't repeat
          const lower = cliResult.toLowerCase();
          if (lower.includes('screenshot captured') || lower.includes('sent to whatsapp') || lower.includes('__image_sent__') || lower.includes('sent.') || lower.includes('image sent')) {
            reply = '__SKIP__'; // Image already sent, no text reply needed
          } else {
            reply = cliResult;
          }
          modelUsed = 'claude-cli-tools';
          history.push({ role: 'assistant', content: reply === '__SKIP__' ? '(screenshot sent)' : reply });
        }
      } catch (cliErr) {
        console.warn('[ROUTER] Claude CLI tool route failed, falling back to GPT-4o:', cliErr.message);
      }
    }

    // ─── ROUTE: tool / hybrid / agent — GPT-4o fallback (if Claude CLI failed) ───
    if (!reply && (decision.route === 'tool' || decision.route === 'hybrid' || decision.route === 'agent')) {
      // First call: GPT-4o (full reasoning with all context)
      let response = await openai.chat.completions.create({
        model: config.model.id,
        max_tokens: config.model.maxTokens,
        tools: getToolsForRole(role),
        messages: [systemMsg, ...history]
      });

      // Tool loop: use gpt-4o for browser tasks (multi-step navigation needs full reasoning),
      // gpt-4o-mini for everything else (cheaper, faster, higher rate limits)
      const BROWSER_TOOLS = new Set(['browser_navigate', 'browser_click', 'browser_type', 'browser_select',
        'browser_fill_form', 'browser_get_fields', 'browser_get_clickables', 'browser_get_text',
        'browser_scroll', 'browser_evaluate', 'browser_screenshot', 'browser_close', 'browser_status', 'browser_fill_from_vault']);
      let useFullModel = false; // escalate to gpt-4o if browser tools detected
      let toolLoops = 0;
      while (response.choices?.[0]?.finish_reason === 'tool_calls' && toolLoops < 10) {
        toolLoops++;
        const assistantMsg = response.choices[0].message;
        // ─── PROGRESS REPORTING — send inline text to operator during multi-step tool tasks ───
        if (assistantMsg.content && assistantMsg.content.trim() && isOperator(jid)) {
          if (sock) await sock.sendMessage(jid, { text: assistantMsg.content.trim() });
        }
        history.push(assistantMsg);
        for (const toolCall of (assistantMsg.tool_calls || [])) {
          let input;
          try { input = JSON.parse(toolCall.function.arguments); } catch (parseErr) {
            console.error(`[TOOL] Failed to parse args for ${toolCall.function.name}:`, parseErr.message);
            history.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error parsing tool arguments: ${parseErr.message}` });
            continue;
          }
          // Detect browser tools — stay on gpt-4o for the entire loop
          if (BROWSER_TOOLS.has(toolCall.function.name)) useFullModel = true;
          console.log(`[TOOL] ${toolCall.function.name}: ${JSON.stringify(input).substring(0, 100)}`);
          toolsUsed.push(toolCall.function.name);
          const result = await executeTool(toolCall.function.name, input, { contact: jid, role: getRole(jid) });
          history.push({ role: 'tool', tool_call_id: toolCall.id, content: String(result) });
        }
        await sock.sendPresenceUpdate('composing', jid);
        const toolModel = useFullModel ? config.model.id : 'gpt-4o-mini';
        response = await openai.chat.completions.create({
          model: toolModel,
          max_tokens: useFullModel ? config.model.maxTokens : 2048,
          tools: getToolsForRole(role),
          messages: [systemMsg, ...history]
        });
        if (toolLoops === 1) console.log(`[TOOL-LOOP] Using ${toolModel} for execution${useFullModel ? ' (browser task)' : ''}`);
      }

      // Tag which model handled tool execution
      reply = response.choices?.[0]?.message?.content || '';
      if (toolLoops > 0 && reply) {
        modelUsed = useFullModel ? config.model.id : `${config.model.id}+mini`;
        console.log(`[TOOL-LOOP] Done after ${toolLoops} loops (${useFullModel ? '4o full' : 'mini executed, 4o planned'})`);
      } else {
        modelUsed = config.model.id;
      }
      if (response.choices?.[0]?.message) history.push(response.choices[0].message);
    }

    // ─── AUTO-SAVE: extract & persist web search findings ───
    if (toolsUsed.includes('web_search') && reply && reply.length > 50) {
      autoSaveFindings(userText, reply, 'web_search').catch(() => {});
    }

    // ─── TELEMETRY ───
    logTelemetry(db.db, {
      contact: jid,
      route: decision.route,
      escalation_score: decision.escalation_score,
      model_used: modelUsed,
      tools_used: toolsUsed,
      needs_review: decision.needs_review,
      success: !!reply,
      classifier_ms: decision.classifier_ms,
      total_ms: Date.now() - routerStart,
      reason: decision.reason
    });

    reply = reply || 'Done.';
    await saveHistory(jid, history, topicId);

    await sock.sendPresenceUpdate('paused', jid);

    // Image was already sent by laptop_screenshot tool — skip text reply
    if (reply === '__IMAGE_SENT__') return;

    // Tool already sent the result (e.g. screenshot image via Claude CLI) — no text reply needed
    if (reply === '__SKIP__') {
      console.log('[ROUTER] Skipping text reply — tool already sent result');
      // Still log telemetry above, just don't send text
      return;
    }

    // ─── CLAUDE CLI TIP: One-time suggestion if CLI not installed ───
    if (!isClaudeAvailable() && modelUsed && !modelUsed.startsWith('claude-cli')) {
      reply += getClaudeTip();
    }

    // ─── GUARDIAN: Redact any leaked API keys before sending ───
    reply = guardian.redactKeys(reply);
    if (guardian.scanForKeyLeak(reply)) {
      db.audit('security.key_leak', 'API key detected in outgoing message — redacted');
    }

    if (reply.length > 4000) {
      const chunks = splitMessage(reply, 4000);
      for (const c of chunks) await sock.sendMessage(jid, { text: c });
    } else {
      await sock.sendMessage(jid, { text: reply });
    }

    // ─── GUARDIAN: Track API usage ───
    guardian.trackUsage(jid, modelUsed || config.model.id, 0, reply.length, decision?.route || 'full');

    console.log(`[${new Date().toLocaleTimeString()}] ${config.identity.name} replied (${reply.length} chars${topicId ? `, topic #${topicId}` : ''})`);

    // Sync: message handled successfully
    syncBot.sync('bot', {
      type: 'message_handled',
      summary: `Replied to ${jid.split('@')[0]} (${reply.length} chars, model: ${modelUsed}, tools: ${toolsUsed.length > 0 ? toolsUsed.join(',') : 'none'})`,
      status: 'success',
      step: 'idle — awaiting next message'
    });

    // ─── THREAD TRACKING (detect unresolved topics for follow-up) ───
    detectAndTrackThreads(jid, body || '', reply).catch(e =>
      console.warn('[THREADS] Detection failed (non-fatal):', e.message)
    );

    // ─── AUTO FACT EXTRACTION — learn from every operator conversation (free via CLI) ───
    if (isOperator(jid) && body && body.length > 20 && reply && reply !== '__SKIP__' && reply.length > 20) {
      (async () => {
        try {
          const extractPrompt = `Extract 0-3 key facts worth remembering long-term from this conversation. Focus on: personal preferences, decisions made, new information about people/projects/plans, or anything the user would expect you to remember next time.

Do NOT extract: greetings, small talk, questions without answers, things already obvious from context, or generic information.

Return ONLY a JSON array of objects: [{"category":"fact|preference|decision","content":"concise fact"}]
If nothing worth saving, return [].

User said: ${(body || '').substring(0, 600)}
Bot replied: ${reply.substring(0, 600)}`;
          const raw = await runClaudeCLI(extractPrompt, 15000, { model: 'haiku' });
          if (!raw) return;
          const cleaned = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
          const extracted = JSON.parse(cleaned);
          if (!Array.isArray(extracted)) return;
          for (const item of extracted.slice(0, 3)) {
            if (!item.content || item.content.length < 10) continue;
            const category = ['fact', 'preference', 'decision'].includes(item.category) ? item.category : 'fact';
            // Dedup: check if similar content exists
            const existing = db.db.prepare(
              'SELECT id FROM memories WHERE category = ? AND content LIKE ? LIMIT 1'
            ).get(category, `%${item.content.substring(0, 50)}%`);
            if (!existing) {
              const memId = db.save(category, item.content, 'auto-extracted');
              getEmbedding(item.content).then(emb => db.updateEmbedding(memId, emb)).catch(() => {});
              console.log(`[MEMORY] Auto-extracted: [${category}] ${item.content.substring(0, 80)}`);
            }
          }
        } catch (_) { /* non-fatal */ }
      })();
    }

    // ─── PER-CONTACT MEMORY — auto-save key facts about non-operator contacts ───
    if (!isOperator(jid) && reply && reply !== '__SKIP__' && body && body.length > 10) {
      (async () => {
        try {
          const factPrompt = `Extract 0-2 key facts worth remembering about this person from this exchange. Return ONLY a JSON array of short strings. If nothing worth saving, return [].

Their message: ${(body || '').substring(0, 500)}
Your reply: ${reply.substring(0, 500)}`;
          const raw = await runClaudeCLI(factPrompt, 20000, { model: 'haiku' });
          const facts = JSON.parse((raw || '[]').replace(/```json?\n?/g, '').replace(/```/g, ''));
          if (Array.isArray(facts)) {
            for (const fact of facts.slice(0, 2)) {
              if (typeof fact === 'string' && fact.length > 5) {
                db.saveContactMemory(jid, fact);
                console.log(`[CONTACT-MEM] Saved for ${jid}: ${fact.substring(0, 60)}`);
              }
            }
          }
        } catch (e) {
          // Non-fatal — contact memory extraction failure should never break the bot
        }
      })();
    }

  } catch (err) {
    console.error('[ERROR]', err.message);
    db.audit('error', err.message);

    // Sync: error
    syncBot.sync('bot', {
      type: 'error',
      priority: 'high',
      summary: `Error handling message: ${err.message}`,
      status: 'error'
    });

    // Auto-recover from broken tool_call history — sanitize in place and retry with context intact
    if (err.message?.includes('tool_calls') && err.message?.includes('tool_call_id') && !err._sessionCleared) {
      console.log('[RECOVER] Broken tool_call history — sanitizing and retrying with context preserved');
      db.audit('session_sanitized', `Auto-sanitized broken tool_call history for ${jid}`);
      try {
        const { messages: fixedHistory, topicId: fixedTopicId } = getHistory(jid);
        const retryResponse = await openai.chat.completions.create({
          model: config.model.id,
          max_tokens: config.model.maxTokens,
          tools: getToolsForRole(role),
          messages: [{ role: 'system', content: buildSystemPrompt(jid) }, ...fixedHistory]
        });
        const retryReply = retryResponse.choices?.[0]?.message?.content || 'Done.';
        if (retryResponse.choices?.[0]?.message) fixedHistory.push(retryResponse.choices[0].message);
        await saveHistory(jid, fixedHistory, fixedTopicId);
        await sock.sendMessage(jid, { text: retryReply });
        return;
      } catch (e2) {
        console.error('[RECOVER] Retry also failed:', e2.message);
      }
    }

    if (config.fallbackModel && !err._fallbackAttempted) {
      console.log(`[FALLBACK] Trying ${config.fallbackModel.id}...`);
      try {
        const { messages: history, topicId } = getHistory(jid);
        const response = await openai.chat.completions.create({
          model: config.fallbackModel.id || 'gpt-4o-mini',
          max_tokens: config.fallbackModel.maxTokens || 1024,
          messages: [{ role: 'system', content: buildSystemPrompt(jid) }, ...history]
        });
        const reply = response.choices?.[0]?.message?.content || 'Done.';
        if (response.choices?.[0]?.message) history.push(response.choices[0].message);
        await saveHistory(jid, history, topicId);
        await sock.sendMessage(jid, { text: reply });
        return;
      } catch (e2) {
        console.error('[FALLBACK] Also failed:', e2.message);
      }
    }
    await sock.sendMessage(jid, { text: `Something went wrong. Error: ${err.message}` });
  }
}

function splitMessage(text, maxLen) {
  const chunks = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= maxLen) { chunks.push(rem); break; }
    let s = rem.lastIndexOf('\n', maxLen);
    if (s < maxLen * 0.3) s = maxLen;
    chunks.push(rem.substring(0, s));
    rem = rem.substring(s).trimStart();
  }
  return chunks;
}

// ─── HEARTBEAT ───
if (config.service.heartbeatIntervalMs > 0) {
  setInterval(() => {
    const counts = db.getMemoryCount();
    const cronCount = db.getActiveCrons().length;
    const uptime = Math.floor(process.uptime() / 60);
    console.log(`[HEARTBEAT] Up ${uptime}m | Mem: ${counts.facts}F ${counts.decisions}D ${counts.preferences}P ${counts.tasks}T | Crons: ${cronCount} | Model: ${config.model.id}`);
  }, config.service.heartbeatIntervalMs);
}

// ─── GRACEFUL SHUTDOWN ───
function shutdown(signal) {
  console.log(`[FAVOR] ${signal} received. Shutting down...`);
  db.audit('shutdown', signal);
  cronEngine.stop();
  if (telegramAdapter) telegramAdapter.stop();
  else if (sock) sock.end();
  if (notifyServer) notifyServer.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Prevent EPIPE crashes (broken pipe on console.log when pm2 restarts)
process.stdout?.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr?.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

// ─── LOCAL NOTIFICATION API ───
// Allows favor-runner and other local processes to push WhatsApp messages
const NOTIFY_PORT = 3099;
const NOTIFY_TOKEN = config.notifyToken || require('crypto').randomBytes(16).toString('hex');
const OPERATOR_JID = PLATFORM === 'telegram'
  ? `tg_${config.telegram?.operatorChatId || ''}`
  : (config.whatsapp?.operatorNumber || '').replace('+', '') + '@s.whatsapp.net';

// Log token on startup so tool-runner.js can use it
console.log(`[NOTIFY] API token: ${NOTIFY_TOKEN} (set "notifyToken" in config.json to fix this)`);

const notifyServer = http.createServer((req, res) => {
  // Auth check for all POST endpoints
  if (req.method === 'POST') {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (token !== NOTIFY_TOKEN) {
      console.warn(`[NOTIFY] Unauthorized request to ${req.url}`);
      res.writeHead(401); res.end('unauthorized'); return;
    }
  }
  if (req.method === 'POST' && req.url === '/notify') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body);
        if (!message) { res.writeHead(400); res.end('missing message'); return; }
        if (!sock) { res.writeHead(503); res.end('not connected'); return; }
        await sock.sendMessage(OPERATOR_JID, { text: message });
        res.writeHead(200); res.end('ok');
      } catch (e) {
        console.error('[NOTIFY] Failed to send:', e.message);
        res.writeHead(500); res.end(e.message);
      }
    });
  } else if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { to, message } = JSON.parse(body);
        if (!to || !message) { res.writeHead(400); res.end('missing to or message'); return; }
        if (!sock) { res.writeHead(503); res.end('not connected'); return; }
        let jid;
        if (PLATFORM === 'telegram') {
          // Accept tg_CHATID or raw chat ID
          jid = to.startsWith('tg_') ? to : `tg_${to}`;
        } else {
          const cleaned = to.replace(/[^0-9+]/g, '');
          if (!cleaned || cleaned.replace('+', '').length < 10) { res.writeHead(400); res.end('invalid phone number'); return; }
          jid = cleaned.replace('+', '') + '@s.whatsapp.net';
        }
        await sock.sendMessage(jid, { text: message });
        console.log(`[SEND API] Sent to ${to}: ${message.substring(0, 60)}`);
        res.writeHead(200); res.end('ok');
      } catch (e) {
        console.error('[SEND API] Failed:', e.message);
        res.writeHead(500); res.end(e.message);
      }
    });
  } else if (req.method === 'POST' && req.url === '/trigger') {
    // Trigger tool actions (screenshot capture, etc.) — used by tool-runner.js
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { action, args } = JSON.parse(body);
        if (!action) { res.writeHead(400); res.end('missing action'); return; }
        if (!sock) { res.writeHead(503); res.end('not connected'); return; }
        if (action === 'laptop_screenshot') {
          const result = await captureScreenshotBuffer();
          if (!result) { res.writeHead(500); res.end('screenshot failed'); return; }
          await sock.sendMessage(OPERATOR_JID, { image: result.buffer, caption: 'Laptop Screenshot' });
          res.writeHead(200); res.end('sent');
        } else if (action === 'phone_screenshot') {
          const imgResult = await executeTool('phone_screenshot', {}, { contact: OPERATOR_JID });
          res.writeHead(200); res.end(imgResult || 'done');
        } else {
          const toolResult = await executeTool(action, args || {}, { contact: OPERATOR_JID });
          res.writeHead(200); res.end(String(toolResult || 'done'));
        }
      } catch (e) {
        console.error('[TRIGGER] Failed:', e.message);
        res.writeHead(500); res.end(e.message);
      }
    });
  } else if (req.method === 'POST' && req.url === '/send-image') {
    // Send an image to a contact — used by Claude CLI tool route for screenshots
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';

        if (contentType.includes('multipart/form-data')) {
          const boundary = contentType.split('boundary=')[1];
          if (!boundary) { res.writeHead(400); res.end('no boundary'); return; }

          const bodyStr = body.toString('latin1');
          const parts = bodyStr.split('--' + boundary).filter(p => p.trim() && p.trim() !== '--');

          let to = null, imagePath = null, caption = '';
          for (const part of parts) {
            if (part.includes('name="to"')) {
              to = part.split('\r\n\r\n')[1]?.trim();
            } else if (part.includes('name="caption"')) {
              caption = part.split('\r\n\r\n')[1]?.trim() || '';
            } else if (part.includes('name="image"') || part.includes('filename=')) {
              const val = part.split('\r\n\r\n')[1]?.trim();
              if (val && val.startsWith('/')) imagePath = val;
            }
          }

          if (!to || !imagePath) { res.writeHead(400); res.end('missing to or image path'); return; }
          if (!sock) { res.writeHead(503); res.end('not connected'); return; }
          if (!fs.existsSync(imagePath)) { res.writeHead(400); res.end('image file not found'); return; }

          let jid;
          if (PLATFORM === 'telegram') {
            jid = to.startsWith('tg_') ? to : `tg_${to}`;
          } else {
            const cleaned = to.replace(/[^0-9+]/g, '');
            jid = cleaned.replace('+', '') + '@s.whatsapp.net';
          }
          const imageBuffer = fs.readFileSync(imagePath);
          await sock.sendMessage(jid, { image: imageBuffer, caption: caption || undefined });
          console.log(`[SEND-IMAGE API] Sent image to ${to}: ${imagePath}`);
          res.writeHead(200); res.end('ok');
        } else {
          // JSON body with file path
          const data = JSON.parse(body.toString());
          if (!data.to || !data.image_path) { res.writeHead(400); res.end('missing to or image_path'); return; }
          if (!sock) { res.writeHead(503); res.end('not connected'); return; }
          if (!fs.existsSync(data.image_path)) { res.writeHead(400); res.end('image file not found'); return; }

          let jid;
          if (PLATFORM === 'telegram') {
            jid = data.to.startsWith('tg_') ? data.to : `tg_${data.to}`;
          } else {
            const cleaned = data.to.replace(/[^0-9+]/g, '');
            jid = cleaned.replace('+', '') + '@s.whatsapp.net';
          }
          const imageBuffer = fs.readFileSync(data.image_path);
          await sock.sendMessage(jid, { image: imageBuffer, caption: data.caption || undefined });
          console.log(`[SEND-IMAGE API] Sent image to ${data.to}: ${data.image_path}`);
          res.writeHead(200); res.end('ok');
        }
      } catch (e) {
        console.error('[SEND-IMAGE API] Failed:', e.message);
        res.writeHead(500); res.end(e.message);
      }
    });
  } else {
    res.writeHead(404); res.end();
  }
});
notifyServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.warn(`[FAVOR] Port ${NOTIFY_PORT} in use, retrying in 3s...`);
    setTimeout(() => notifyServer.listen(NOTIFY_PORT, '127.0.0.1'), 3000);
  } else {
    console.error('[FAVOR] Notify server error:', e.message);
  }
});
notifyServer.listen(NOTIFY_PORT, '127.0.0.1', () => {
  console.log(`[FAVOR] Notify API listening on localhost:${NOTIFY_PORT}`);
});

// ─── START ───
console.log(`[FAVOR] Starting ${config.identity.name} v${require('./package.json').version}...`);
console.log(`[FAVOR] "${config.identity.tagline}"`);
console.log(`[FAVOR] Features: vision | voice | topics | crons | compaction | proactive | alive`);

// Claude CLI availability check
const { isAvailable: _claudeAvail } = require('./utils/claude');
if (!_claudeAvail()) {
  console.warn('[FAVOR] ⚠ Claude CLI not found — running in FALLBACK MODE (higher API costs)');
  console.warn('[FAVOR] Install for free routing: curl -fsSL https://claude.ai/install.sh | sh');
  console.warn('[FAVOR] Routes affected: chat, mini, claude, classification, compaction, alive check-ins');
} else {
  console.log('[FAVOR] Claude CLI detected — primary brain active (free via subscription)');
}

if (PLATFORM === 'telegram') {
  console.log(`[FAVOR] Using Telegram — set botToken in config.json`);
  startTelegram().catch(err => {
    console.error('[FATAL] Failed to start Telegram:', err.message);
    process.exit(1);
  });
} else {
  console.log(`[FAVOR] Using Baileys (WhatsApp) — credentials: ${AUTH_DIR}`);
  startWhatsApp().catch(err => {
    console.error('[FATAL] Failed to start WhatsApp:', err.message);
    process.exit(1);
  });
}
