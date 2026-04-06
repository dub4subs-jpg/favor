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
const ConversationScribe = require('./scribe');
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
const localEmbeddings = require('./embeddings');
const MessageQueue = require('./message-queue');
const ToolAudit = require('./tool-audit');
const AdaptiveTimeouts = require('./adaptive-timeouts');
const Planner = require('./planner');
const DellAPI = require('./api');
const AccessControl = require('./core/access-control');
const CommandHandler = require('./core/command-handler');
const MediaHandler = require('./core/media-handler');
const { createToolExecutor } = require('./core/tool-executor');
const ScreenAwareness = require('./core/screen-awareness');
const reaper = require('./reaper');
const pino = require('pino');

const logger = pino({ level: 'silent' }); // suppress baileys noise

// localTranscribe delegated to mediaHandler (core/media-handler.js)
function localTranscribe(audioPath, language = 'en') { return mediaHandler.localTranscribe(audioPath, language); }

// Suppress libsignal session noise (Closing session / Session already closed / Session already open)
const _origInfo = console.info;
const _origWarn = console.warn;
console.info = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('Closing session')) return; _origInfo.apply(console, args); };
console.warn = (...args) => { if (typeof args[0] === 'string' && (args[0].startsWith('Session already') || args[0] === 'Session already open')) return; _origWarn.apply(console, args); };

// ─── CONFIG ───
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = loadConfig();

function validateConfig(cfg) {
  const required = [
    ['model.id', cfg.model?.id],
    ['memory.dbPath', cfg.memory?.dbPath],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`[CONFIG] Missing required fields: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!validateConfig(cfg)) process.exit(1);
    return cfg;
  } catch (e) { console.error('Failed to load config.json:', e.message); process.exit(1); }
}

function reloadConfig() {
  try {
    const prev = config;
    const newCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!validateConfig(newCfg)) {
      console.error('[CONFIG] Reload rejected — invalid config, keeping previous');
      return { changed: false, error: 'validation failed' };
    }
    config = newCfg;
    // Propagate config to all extracted modules
    if (typeof accessControl !== 'undefined') accessControl.updateConfig(config);
    if (typeof commandHandler !== 'undefined') commandHandler.updateConfig(config);
    if (typeof mediaHandler !== 'undefined') mediaHandler.updateConfig(config);
    if (typeof screenAwareness !== 'undefined') screenAwareness.updateConfig(config);
    if (typeof toolExecutor !== 'undefined') toolExecutor.updateConfig(config);
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
} else if (PLATFORM === 'evolution') {
  console.log('[PLATFORM] Evolution API');
} else {
  console.error(`[PLATFORM] Unknown platform: ${PLATFORM}. Use 'whatsapp', 'telegram', or 'evolution'.`);
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

// ─── PLAYWRIGHT (advanced browser automation via @playwright/cli) ───
let pw = null;
try {
  const { execFileSync } = require('child_process');
  execFileSync('playwright-cli', ['--version'], { timeout: 5000, encoding: 'utf8' });
  const PlaywrightCLI = require('./playwright');
  pw = new PlaywrightCLI();
  console.log('[PLAYWRIGHT] playwright-cli wrapper loaded');
} catch {
  console.log('[PLAYWRIGHT] playwright-cli not installed — Playwright tools disabled (install: npm install -g @playwright/cli)');
}

// ─── VIDEO PROCESSOR ───
let videoProcessor = new VideoProcessor(openai);
console.log('[VIDEO] Video processor initialized');

// ─── MEDIA HANDLER ───
const mediaHandler = new MediaHandler({ config, videoProcessor, PLATFORM, botDir: __dirname });
mediaHandler.setLogger(logger);

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

// ─── ACCESS CONTROL ───
const accessControl = new AccessControl({ config, PLATFORM, TOOLS });

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
        }).catch(e => console.warn('[GUARDIAN] Alert send failed:', e.message));
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
    botName: config.identity?.name || 'Favor' || 'Favor',
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
localEmbeddings.warmup(); // pre-load embedding model (downloads ~80MB on first run)
memoryBridge.init(db, getEmbedding);

// ─── COMPACTOR ───
const compactor = new Compactor(db, {
  apiKey: OPENAI_API_KEY,
  compactModel: config.compaction?.model || 'gpt-4o-mini',
  threshold: config.compaction?.threshold || 50,
  keepRecent: config.compaction?.keepRecent || 20,
  summaryTokens: config.compaction?.summaryTokens || 512
});

// ─── CONVERSATION SCRIBE ───
const scribe = new ConversationScribe(db);

// ─── MESSAGE QUEUE (global concurrency limiter) ───
const messageQueue = new MessageQueue({ maxConcurrent: config.queue?.maxConcurrent || 3 });
console.log(`[QUEUE] Message queue initialized (max concurrent: ${messageQueue.maxConcurrent})`);

// ─── TOOL AUDIT (execution checkpoints) ───
const toolAudit = new ToolAudit(db.db);
console.log('[AUDIT] Tool audit initialized');

// ─── ADAPTIVE TIMEOUTS ───
const adaptiveTimeouts = new AdaptiveTimeouts(db.db);
console.log('[ADAPTIVE] Adaptive timeouts initialized');

// ─── PLANNER (multi-turn plan tracking) ───
const planner = new Planner(db.db);
console.log('[PLANNER] Multi-turn planner initialized');

// ─── ANALYTICS ───
let analytics = null;
try {
  const Analytics = require('./analytics');
  analytics = new Analytics(db.db);
  console.log('[ANALYTICS] Analytics engine initialized');
} catch (e) {
  console.log('[ANALYTICS] Not available:', e.message);
}

// ─── REST API + DASHBOARD ───
const dellAPI = new DellAPI({ db, config, messageQueue, costTracker: typeof costTracker !== 'undefined' ? costTracker : null, guardian, planner, analytics });
dellAPI.start();

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
function getKnowledgeFiles() {
  const dir = path.resolve(__dirname, config.knowledge.dir);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return []; }
  const manifestPath = path.join(dir, 'knowledge.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return (manifest.files || []).filter(f => fs.existsSync(path.join(dir, f)));
    } catch (e) { console.warn('[KNOWLEDGE] Bad manifest, falling back to dir scan'); }
  }
  return fs.readdirSync(dir).filter(f =>
    (f.endsWith('.txt') || f.endsWith('.md')) && !f.includes('.example.')
  );
}

function loadKnowledge() {
  const dir = path.resolve(__dirname, config.knowledge.dir);
  const files = getKnowledgeFiles();
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
  const files = getKnowledgeFiles();
  const contents = {};
  for (const file of files) {
    contents[file] = fs.readFileSync(path.join(dir, file), 'utf8');
  }
  knowledgeFileContents = contents;
  console.log(`[KNOWLEDGE] Indexed ${files.length} file(s) for dynamic selection`);
  return contents;
}

async function embedKnowledgeFiles() {
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
  // Local embeddings (all-MiniLM-L6-v2) — no API key needed
  return localEmbeddings.getEmbedding(text);
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
      getEmbedding(memContent.substring(0, 512)).then(emb => db.updateEmbedding(memId, emb)).catch(e => console.warn(`[EMBED] Failed for memory #${memId}:`, e.message));
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
  const missing = db.getWithoutEmbeddings();
  if (!missing.length) return;
  console.log(`[MEMORY] Backfilling embeddings for ${missing.length} memories...`);
  let count = 0;
  for (const row of missing) {
    try {
      const emb = await getEmbedding(row.content);
      db.updateEmbedding(row.id, emb);
      count++;
    } catch (e) {
      console.warn('[MEMORY] Backfill failed for id', row.id, e.message);
      break;
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

// transcribeVoice delegated to mediaHandler (core/media-handler.js)
async function transcribeVoice(buf, mime) { return mediaHandler.transcribeVoice(buf, mime); }

// TOOLS and oaiTool already loaded above (before plugin loader)
// Instance-specific tools can be appended: TOOLS.push(oaiTool(...))
// All core definitions are in core/tool-definitions.js

// ─── PROMPT INJECTION DEFENSE ───
const { sanitizeExternalInput, stripInjectionPatterns } = require('./utils/sanitize');
function sanitizeBrowserOutput(text) { return stripInjectionPatterns(text); }

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

const MAX_TOOL_RESULT_LENGTH = 8000;

// ─── TOOL EXECUTOR (delegated to core/tool-executor.js) ───
const toolExecutor = createToolExecutor({
  db, config, vault, browser, pw, videoProcessor, buildMode, guardian, selfCheck,
  pluginLoader, accessControl, mediaHandler, syncBot,
  getEmbedding, runClaudeCLI, semanticSearch, updateOperatorProfile,
  laptopExec, isLaptopOnline, captureScreenshotBuffer,
  sanitizeExternalInput, sanitizeBrowserOutput,
  PLATFORM, botDir: __dirname,
});

// executeTool with size cap + audit logging wrapper
let executeTool = async function(name, input, context = {}) {
  const auditId = toolAudit.logIntent(name, input, context.contact);
  const start = Date.now();
  try {
    let result = await toolExecutor.execute(name, input, context);
    const isToolError = typeof result === 'string' &&
      /^Error:|offline|failed|timed out|not configured|ECONNREFUSED|EHOSTUNREACH/i.test(result);
    toolAudit.logResult(auditId, isToolError ? 'error' : 'success',
      typeof result === 'string' ? result.substring(0, 500) : 'ok', Date.now() - start);
    if (typeof result === 'string' && result.length > MAX_TOOL_RESULT_LENGTH) {
      console.warn(`[TOOL] Result from "${name}" truncated: ${result.length} → ${MAX_TOOL_RESULT_LENGTH} chars`);
      result = result.substring(0, MAX_TOOL_RESULT_LENGTH) + `\n\n[... truncated — full output was ${result.length} chars]`;
    }
    return result;
  } catch (err) {
    toolAudit.logResult(auditId, 'error', err.message, Date.now() - start);
    throw err;
  }
};

// REMOVED: 780 lines of inline tool switch cases — now in core/tool-executor.js
// REMOVED: old audit wrapper — merged into new executeTool above
// (old tool switch cases and audit wrapper removed — now in core/tool-executor.js)
// ─── SYSTEM PROMPT ───
// Prompt building extracted to core/prompts.js
const { buildSystemPrompt: _buildSystemPrompt } = require('./core/prompts');

// Thin wrappers that inject instance dependencies into extracted module
function buildMemoryPrompt(relevantMemories = [], contact = null) {
  // LEGACY — kept for any internal callers. New code should use core/prompts.js directly.
  const { buildMemoryPrompt: _bmp } = require('./core/prompts');
  return _bmp(db, relevantMemories, contact);
}
function buildSystemPrompt(contact, messageText = '', relevantMemories = []) {
  return _buildSystemPrompt({
    config, db, compactor, platform: PLATFORM,
    contact, messageText, relevantMemories,
    dynamicKnowledge: buildDynamicKnowledge(messageText),
    scribe,
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

// ─── SCREEN AWARENESS (delegated to core/screen-awareness.js) ───
const screenAwareness = new ScreenAwareness({
  config, db, sock: null, captureScreenshotBuffer, runClaudeCLI, getEmbedding, isLaptopOnline, PLATFORM, botDir: __dirname,
});
// Aliases for backward compat
const startScreenAwareness = () => screenAwareness.start();
const stopScreenAwareness = () => screenAwareness.stop();
const resumeScreenAwareness = () => screenAwareness.resume();
// updateOperatorProfile is used by tool executor too
async function updateOperatorProfile(insights) { return ScreenAwareness.updateOperatorProfile(insights, __dirname); }

// ─── COMMAND HANDLER ───
const commandHandler = new CommandHandler({
  db, config, sock: null, syncBot, alive, accessControl,
  getHistory, isLaptopOnline, reloadConfig, loadKnowledge,
  screenAwareness,
  CONFIG_PATH, botDir: __dirname,
});

// ─── BAILEYS WHATSAPP ───
// Use OpenClaw's credential store so no QR re-scan needed
const AUTH_DIR = config.whatsapp?.credentialsDir || path.join(__dirname, 'auth-state');
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
      console.log(`[FAVOR] ${config.identity?.name || 'Favor'} is online (Baileys)`);
      console.log(`[FAVOR] Model: ${config.model.id}`);
      console.log(`[FAVOR] Memories: ${counts.facts}F ${counts.decisions}D ${counts.preferences}P ${counts.tasks}T`);
      console.log(`[FAVOR] Active crons: ${cronCount}`);
      console.log(`[FAVOR] Features: vision, voice, topics, crons, compaction, proactive, alive, sync`);

      // ─── STARTUP HEALTH CHECK ───
      try {
        const integrity = db.db.pragma('integrity_check');
        if (integrity[0]?.integrity_check !== 'ok') {
          console.error('[BOOT] DATABASE INTEGRITY CHECK FAILED:', integrity);
          db.audit('boot.health', 'DB integrity check FAILED');
        } else {
          console.log('[BOOT] DB integrity: ok');
        }
      } catch (e) {
        console.error('[BOOT] DB health check error:', e.message);
      }
      const memUsage = process.memoryUsage();
      console.log(`[BOOT] Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);

      db.audit('ready', `WhatsApp connected (Baileys). Model: ${config.model.id}`);
      cronEngine.start();

      // ─── EXTRACTED MODULES: connect sock ───
      commandHandler.setSock(sock);
      mediaHandler.setSock(sock);
      mediaHandler.setDownloadMediaMessage(downloadMediaMessage);
      toolExecutor.setSock(sock);
      screenAwareness.setSock(sock);

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
        const credDir = config.whatsapp?.credentialsDir || path.join(__dirname, 'auth-state');
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
        // Auto-reconnect with exponential backoff (5s, 10s, 20s, 40s... capped at 60s)
        if (restartAttempts < config.service.maxRestartAttempts) {
          restartAttempts++;
          const baseDelay = config.service.restartDelayMs || 5000;
          const delay = Math.min(baseDelay * Math.pow(2, restartAttempts - 1), 60000);
          console.log(`[WHATSAPP] Reconnect attempt ${restartAttempts}/${config.service.maxRestartAttempts} in ${delay}ms`);
          setTimeout(() => startWhatsApp(), delay);
        } else {
          console.error('[WHATSAPP] Max restart attempts reached — letting pm2 handle full restart.');
          process.exit(1);
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
      console.log(`[FAVOR] ${config.identity?.name || 'Favor'} is online (Telegram: @${botInfo.username})`);
      console.log(`[FAVOR] Model: ${config.model.id}`);
      console.log(`[FAVOR] Memories: ${counts.facts}F ${counts.decisions}D ${counts.preferences}P ${counts.tasks}T`);
      console.log(`[FAVOR] Active crons: ${cronCount}`);
      console.log(`[FAVOR] Features: vision, voice, topics, crons, compaction, proactive, alive`);
      db.audit('ready', `Telegram connected (@${botInfo.username}). Model: ${config.model.id}`);
      cronEngine.start();

      // Extracted modules + Alive engine
      commandHandler.setSock(sock);
      mediaHandler.setSock(sock);
      mediaHandler.setTelegramAdapter(telegramAdapter);
      toolExecutor.setSock(sock);
      screenAwareness.setSock(sock);
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

// ─── ACCESS CONTROL (delegated to core/access-control.js) ───
// Convenience aliases for the rest of favor.js during incremental migration
const resolvePhone = (jid) => accessControl.resolvePhone(jid);
const isOperator = (jid) => accessControl.isOperator(jid);
const getRole = (jid) => accessControl.getRole(jid);
const canUseTool = (role, name) => accessControl.canUseTool(role, name);
const canUseCommand = (role, cmd) => accessControl.canUseCommand(role, cmd);
const getToolsForRole = (role) => accessControl.getToolsForRole(role);
const isAllowed = (jid) => accessControl.isAllowed(jid);
const isGroup = (jid) => accessControl.isGroup(jid);
const registerLidMapping = (lid, phone) => accessControl.registerLidMapping(lid, phone);

// ─── MEDIA FUNCTIONS (delegated to core/media-handler.js) ───
const extractText = (msg) => mediaHandler.extractText(msg);
const getMessageType = (msg) => mediaHandler.getMessageType(msg);
const downloadMedia = (msg) => mediaHandler.downloadMedia(msg);
const processImage = (msg) => mediaHandler.processImage(msg);
const processVoice = (msg) => mediaHandler.processVoice(msg);
const processVideoMessage = (msg) => mediaHandler.processVideoMessage(msg);

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
          scribe.capture(jid, `[Cron: ${cron.label}] ${reply.substring(0, 100)}`, 'proactive');
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

// isDuplicateMessage delegated to mediaHandler (core/media-handler.js)
const isDuplicateMessage = (msg) => mediaHandler.isDuplicateMessage(msg);

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
    } else if (accessControl.verifiedNumbers.has(authKey)) {
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
        accessControl.pendingAuth.add(authKey);
        await sock.sendMessage(jid, { text: "What's the security phrase?" });
        console.log(`[SECURITY] Auth challenge sent to ${authKey}`);
        return;
      }

      // Step 2: They answer the challenge
      if (accessControl.pendingAuth.has(authKey)) {
        if (phrase && textLower === phrase) {
          accessControl.verifiedNumbers.add(authKey);
          accessControl.pendingAuth.delete(authKey);
          await sock.sendMessage(jid, { text: "Verified. What do you need?" });
          console.log(`[SECURITY] ${authKey} verified via security phrase`);
          return;
        } else {
          accessControl.pendingAuth.delete(authKey);
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

  // ─── COMMANDS (delegated to core/command-handler.js) ───
  if (body) {
    const cmdResult = await commandHandler.handle(jid, body, role);
    if (cmdResult.handled) {
      if (cmdResult.knowledgeReloaded) KNOWLEDGE = cmdResult.knowledgeReloaded;
      return;
    }
  }

  // ─── AI CONVERSATION (with global concurrency control) ───
  const senderTrustForQueue = getTrustLevel(jid);
  let slot;
  try {
    slot = await messageQueue.acquire(senderTrustForQueue, jid);
  } catch (qErr) {
    if (qErr.message === 'QUEUE_FULL' || qErr.message === 'QUEUE_TIMEOUT') {
      console.warn(`[QUEUE] ${qErr.message} for ${jid.split('@')[0]}`);
      try { await sock.sendMessage(jid, { text: `I'm handling a few things right now — try again in a minute.` }); } catch (_) {}
    }
    return;
  }
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
      // typing indicator handles it — only reply when done
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
    if (typeof sock.presenceSubscribe === 'function') await sock.presenceSubscribe(jid);
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
      scribe.capture(jid, `[Teach] Ran "${teachMatch.command_name}": ${(summary || '').substring(0, 100)}`, 'teach');
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

    // ─── TASK ACKNOWLEDGMENT (only for long-running routes) ───
    const ack = decision.route === 'agent' ? 'This might take a minute or two' : null;
    if (ack) {
      try {
        await sock.sendMessage(jid, { text: ack });
      } catch (_) {}
    }

    let reply = '';
    let modelUsed = config.model.id;
    const toolsUsed = [];

    // ─── ROUTE: image — Claude CLI with vision (free via Max subscription) ───
    if (!reply && isImage) {
      let imgPath = null;
      try {
        // Save image to temp file for Claude CLI to read
        const imgExt = (mediaHandler.lastReceivedImage?.mimetype || 'image/jpeg').split('/')[1]?.replace('webp', 'png') || 'jpg';
        imgPath = `/tmp/favor_vision_${Date.now()}.${imgExt}`;
        const imgBuffer = mediaHandler.lastReceivedImage?.buffer;
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

Analyze the image and respond naturally. Respond as ${config.identity?.name || 'Favor'}.`;
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
- Send email: python3 send-gmail.py <to> <subject> <body> [attachment]
- Run server commands: any bash command
When you need to message someone, USE these tools. Do NOT say you can't send messages.

=== CONVERSATION ===
${recentHistory}

Respond to the latest message. Respond as ${config.identity?.name || 'Favor'}.`;
        const cliResult = await runClaudeCLI(cliPrompt, 180000, { allowTools: true });
        reply = cliResult;
        modelUsed = 'claude-cli';
        history.push({ role: 'assistant', content: reply });
      } catch (cliErr) {
        console.warn('[ROUTER] Claude CLI attempt 1 failed for chat/full:', cliErr.message);
        // Retry with simplified prompt — do NOT fall back to GPT-4o
        try {
          const retryPrompt = `${buildSystemPrompt(jid, messageTextForRecall, relevantMemories)}\n\n=== CONVERSATION ===\nHuman: ${userText}\n\nRespond to the latest message. Respond as ${config.identity?.name || 'Favor'}.`;
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
        autoSaveFindings(userText, geminiResult, 'gemini').catch(e => console.warn('[AUTO-SAVE] Gemini findings save failed:', e.message));
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
- Send email: python3 send-gmail.py <to> <subject> <body> [attachment]
When you need to message someone, USE these tools. Do NOT say you can't send messages.

=== CONVERSATION ===
${recentHistoryMini}

Respond briefly and directly. Respond as ${config.identity?.name || 'Favor'}.`;
        const cliResult = await runClaudeCLI(cliPrompt, 30000, { allowTools: true });
        reply = cliResult;
        modelUsed = 'claude-cli';
        history.push({ role: 'assistant', content: reply });
      } catch (cliErr) {
        console.warn('[ROUTER] Claude CLI failed for mini, falling back to gpt-4o-mini:', cliErr.message);
      }

      // Fall back to gpt-4o-mini with tools if Claude CLI failed
      if (!reply && openai) {
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
    if (!reply && openai && (decision.route === 'tool' || decision.route === 'hybrid' || decision.route === 'agent')) {
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
        'browser_scroll', 'browser_evaluate', 'browser_screenshot', 'browser_close', 'browser_status',
        'browser_fill_from_vault', 'browser_read_page', 'browser_crawl',
        'playwright_navigate', 'playwright_snapshot', 'playwright_click', 'playwright_fill',
        'playwright_type', 'playwright_press', 'playwright_select', 'playwright_hover',
        'playwright_screenshot', 'playwright_evaluate', 'playwright_tabs',
        'playwright_close', 'playwright_status']);
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
      autoSaveFindings(userText, reply, 'web_search').catch(e => console.warn('[AUTO-SAVE] Web search findings save failed:', e.message));
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

    console.log(`[${new Date().toLocaleTimeString()}] ${config.identity?.name || 'Favor'} replied (${reply.length} chars${topicId ? `, topic #${topicId}` : ''})`);

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

    // ─── AUTO FACT EXTRACTION + CONVERSATION SCRIBE — learn from every operator conversation (free via CLI) ───
    if (isOperator(jid) && body && body.length > 20 && reply && reply !== '__SKIP__' && reply.length > 20) {
      (async () => {
        try {
          // Get active pending/task entries for auto-resolution
          const activeEntries = scribe.getTodayJournal(jid)
            .filter(e => ['pending', 'task'].includes(e.category))
            .map(e => `#${e.id}: ${e.summary}`)
            .join('\n');
          const resolveSection = activeEntries
            ? `\n- resolved: array of entry IDs (numbers) from the open items below that this exchange resolves/answers. Return [] if none resolved.\n\nOpen items:\n${activeEntries}`
            : '';

          const extractPrompt = `Extract key information from this conversation. Return ONLY valid JSON:
{"facts":[{"category":"fact|preference|decision|idea|project_update|task","content":"concise fact","detail":"optional elaboration for ideas/decisions"}],"directives":[{"rule":"permanent rule","context":"why"}],"entities":[{"name":"Name","type":"person|company|product|project|location","metadata":{}}],"relationships":[{"from":"Entity A","to":"Entity B","type":"works_at|supplies|owns|knows|uses","context":"brief context"}],"journal":"1-line summary of what was discussed/decided/requested in this exchange","journal_category":"exchange|decision|task|pending"${activeEntries ? ',"resolved":[1,2]' : ''}}

Rules:
- facts: 0-3 key facts worth remembering. Skip greetings/small talk. Categories:
  - "idea" — app concepts, business ideas, product concepts, side projects. Signals: "I want to build", "what about an app that", "we should make", "idea for", "what if we"
  - "project_update" — status changes on known projects. Signals: "X is done", "paused X", "launched X", "killed X", "X is live now"
  - "decision" — a concrete choice between options. Signals: "let's go with", "use X not Y", "decided on", "switching to"
  - "task" — action items or reminders. Signals: "remind me", "need to", "send the", "schedule"
  - "fact" — knowledge, contacts, numbers, dates, addresses, technical info
  - "preference" — behavioral or stylistic preferences. Signals: "always", "never", "I like", "I prefer"
  For ideas: content = the concept name, detail = what it does / who it's for / why it's interesting (1-2 sentences)
  For decisions: detail = brief reasoning if given
  "detail" is optional — omit for facts/preferences/tasks
- directives: 0-2 STANDING ORDERS from the operator — permanent rules like "never do X", "always do Y", "stop doing Z", "from now on...", "don't ever...". Only real commands, not casual preferences.
- entities: people, companies, products, projects mentioned. Include metadata like role/title if apparent.
- relationships: connections between entities. Only include if clearly stated.
- journal: ALWAYS provide a 1-line summary (max 150 chars) of what this exchange was about. Include specific names, numbers, prices, file paths if mentioned.
- journal_category: "decision" if a choice was made, "task" if work was requested, "pending" if a question is unanswered, otherwise "exchange"
- If nothing worth saving for facts, return empty arrays but STILL provide journal.${resolveSection}

User said: ${(body || '').substring(0, 600)}
Bot replied: ${reply.substring(0, 600)}`;
          const raw = await runClaudeCLI(extractPrompt, 15000, { model: 'haiku' });
          if (!raw) {
            const fallback = `${(body || '').substring(0, 80)} → ${reply.substring(0, 80)}`;
            scribe.capture(jid, fallback);
            return;
          }
          const cleaned = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
          let parsed;
          try { parsed = JSON.parse(cleaned); } catch (_) {
            const fallback = `${(body || '').substring(0, 80)} → ${reply.substring(0, 80)}`;
            scribe.capture(jid, fallback);
            return;
          }

          // ─── SCRIBE: Save conversation journal entry ───
          if (parsed.journal && typeof parsed.journal === 'string') {
            const jCat = ['exchange', 'decision', 'task', 'pending'].includes(parsed.journal_category)
              ? parsed.journal_category : 'exchange';
            scribe.capture(jid, parsed.journal, jCat);
          } else {
            const fallback = `${(body || '').substring(0, 80)} → ${reply.substring(0, 80)}`;
            scribe.capture(jid, fallback);
          }

          // ─── SCRIBE: Auto-resolve completed items ───
          if (Array.isArray(parsed.resolved)) {
            for (const id of parsed.resolved) {
              if (typeof id === 'number' && id > 0) {
                scribe.resolve(id);
                console.log(`[SCRIBE] Auto-resolved entry #${id}`);
              }
            }
          }

          // Backward-compatible: if array (old format), treat as facts
          const facts = Array.isArray(parsed) ? parsed : (parsed.facts || []);
          for (const item of facts.slice(0, 3)) {
            if (!item.content || item.content.length < 10) continue;
            // Never save internal routing/mode state as memories
            if (/\b(chat mode|agent mode|tool access|no tools|limited mode|without tools)\b/i.test(item.content)) {
              console.log(`[MEMORY] Skipped internal-state memory: ${item.content.substring(0, 60)}`);
              continue;
            }
            const category = ['fact', 'preference', 'decision', 'idea', 'project_update', 'task'].includes(item.category) ? item.category : 'fact';
            const existing = db.db.prepare(
              'SELECT id FROM memories WHERE category = ? AND content LIKE ? LIMIT 1'
            ).get(category, `%${item.content.substring(0, 50)}%`);
            if (!existing) {
              const status = category === 'task' ? 'pending' : 'auto-extracted';
              const memId = db.save(category, item.content, status);
              getEmbedding(item.content).then(emb => db.updateEmbedding(memId, emb)).catch(e => console.warn(`[EMBED] Failed for memory #${memId}:`, e.message));
              console.log(`[MEMORY] Auto-extracted: [${category}] ${item.content.substring(0, 80)}`);
            }
          }

          // ─── REVERSE BRIDGE: Push high-value memories to Claude Code ───
          const highValueItems = facts.filter(item =>
            ['idea', 'project_update', 'decision'].includes(item.category) &&
            item.content && item.content.length >= 10
          );
          if (highValueItems.length > 0) {
            try {
              for (const item of highValueItems) {
                memoryBridge.push(item.category, item.content, item.detail || null);
              }
            } catch (e) {
              console.warn('[REVERSE-BRIDGE] Push failed (non-fatal):', e.message);
            }
          }

          // ─── AUTO-DETECT STANDING DIRECTIVES ───
          if (parsed.directives && Array.isArray(parsed.directives)) {
            for (const d of parsed.directives.slice(0, 2)) {
              if (!d || typeof d.rule !== 'string' || d.rule.length < 8) continue;
              if (typeof db.saveDirective === 'function') {
                const id = db.saveDirective(d.rule, d.context || null);
                console.log(`[DIRECTIVE] Auto-extracted: #${id} "${d.rule.substring(0, 80)}"`);
              }
            }
          }
        } catch (_) { /* non-fatal */ }
      })();
    } else if (isOperator(jid) && reply && reply !== '__SKIP__') {
      // Scribe fallback: operator messages too short for fact extraction (media, short texts)
      const fallback = `${(body || '').substring(0, 80)} → ${reply.substring(0, 80)}`;
      scribe.capture(jid, fallback);

      // Even for short messages, check if any pending/task items got resolved
      // Uses keyword matching instead of CLI to avoid concurrency limits
      const pendingItems = scribe.getTodayJournal(jid).filter(e => ['pending', 'task'].includes(e.category));
      if (pendingItems.length && body && body.length > 2) {
        const msg = (body || '').toLowerCase() + ' ' + reply.substring(0, 500).toLowerCase();
        const RESOLVE_SIGNALS = /\b(done|finished|ok i (ate|did|got|fixed|found)|completed|all set|got it|i did|it'?s done|taken care|sorted|resolved|already|back|ready|let'?s go|nevermind|nvm|figured it out)\b/i;
        if (RESOLVE_SIGNALS.test(msg)) {
          // Only resolve pending entries (not task — tasks need explicit completion)
          const resolvable = pendingItems.filter(e => e.category === 'pending');
          if (resolvable.length === 1) {
            scribe.resolve(resolvable[0].id);
            console.log(`[SCRIBE] Auto-resolved entry #${resolvable[0].id} (single pending + signal)`);
          } else if (resolvable.length > 1) {
            for (const entry of resolvable) {
              const words = entry.summary.toLowerCase().split(/[\s,;]+/).filter(w => w.length > 3);
              const overlap = words.filter(w => msg.includes(w)).length;
              if (overlap >= 1) {
                scribe.resolve(entry.id);
                console.log(`[SCRIBE] Auto-resolved entry #${entry.id} (keyword match: ${overlap} words)`);
              }
            }
          }
        }
      }
    }

    // ─── PER-CONTACT MEMORY + SCRIBE — auto-save key facts about non-operator contacts ───
    if (!isOperator(jid) && reply && reply !== '__SKIP__' && body && body.length > 10) {
      // Scribe: capture journal entry for non-operator contacts too
      const contactJournal = `${(body || '').substring(0, 80)} → ${reply.substring(0, 80)}`;
      scribe.capture(jid, contactJournal);

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
        if (!openai) throw new Error('OpenAI not configured');
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

    if (config.fallbackModel && !err._fallbackAttempted && openai) {
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
  } finally {
    if (slot) slot.release();
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

// ─── MAP CLEANUP (prevent unbounded growth) ───
setInterval(() => {
  accessControl.cleanup();
}, 3600000); // every hour

// ─── GRACEFUL SHUTDOWN ───
function shutdown(signal) {
  console.log(`[FAVOR] ${signal} received. Shutting down...`);
  db.audit('shutdown', signal);
  reaper.killAll();
  reaper.stop();
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

// ─── GLOBAL EXCEPTION HANDLERS ───
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  try { db.audit('uncaughtException', err.message); } catch (_) {}
  setTimeout(() => process.exit(1), 3000);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  try { db.audit('unhandledRejection', String(reason)); } catch (_) {}
  setTimeout(() => process.exit(1), 3000);
});

// ─── LOCAL NOTIFICATION API ───
// Allows favor-runner and other local processes to push WhatsApp messages
const NOTIFY_PORT = 3099;
const NOTIFY_TOKEN = config.notifyToken || require('crypto').randomBytes(16).toString('hex');
const OPERATOR_JID = PLATFORM === 'telegram'
  ? `tg_${config.telegram?.operatorChatId || ''}`
  : (config.whatsapp?.operatorNumber || '').replace('+', '') + '@s.whatsapp.net';

// Log token on startup so tool-runner.js can use it
console.log(`[NOTIFY] API token: ${NOTIFY_TOKEN} (set "notifyToken" in config.json to fix this)`);
reaper.setNotifyToken(NOTIFY_TOKEN);

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
          // phone_screenshot requires ADB phone integration (configure phone section in config.json)
          const imgResult = await executeTool('phone_screenshot', {}, { contact: OPERATOR_JID });
          res.writeHead(200); res.end(imgResult || 'phone_screenshot not configured — add phone settings to config.json');
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
console.log(`[FAVOR] Starting ${config.identity?.name || 'Favor'} v${require('./package.json').version}...`);
console.log(`[FAVOR] "${config.identity?.tagline || ''}"`);
console.log(`[FAVOR] Features: vision | voice | topics | crons | compaction | proactive | alive`);

// ─── PROCESS REAPER (kills stale Claude CLI processes) ───
reaper.start();

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
