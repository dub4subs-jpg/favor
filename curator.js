'use strict';

/**
 * Memory Curator v2 — Core Favor Framework Feature
 *
 * Reads raw SQLite memories → classifies (rule-based) → scores by frequency →
 * deduplicates → optionally refines via AI (Claude CLI haiku) → renders structured
 * markdown knowledge files per scope. Prompt builder loads curated files automatically.
 *
 * v2 improvements over v1:
 *   - Frequency-based promotion (single-mention low-value stays raw_only)
 *   - AI refinement pass (optional, merges fragments into structured entries)
 *   - Structured output templates (Symptom/Cause/Fix, Decision/Why/Tradeoffs)
 *   - Override layer (hand-curated files preserved across auto-runs)
 *   - Better dedup (semantic grouping before merge)
 *
 * Usage:
 *   const curator = require('./curator');
 *   await curator.run(db, config);         // full curation cycle
 *   curator.loadCuratedBrain(config);      // returns markdown for prompt injection
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ─── In-Memory Cache ─────────────────────────────────────────────────────────

let _cache = { scope: null, content: '', loadedAt: 0, mtime: 0 };
const CACHE_TTL_MS = 60_000;

// ─── Secret Detection ────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  // Anthropic / OpenAI
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-proj-[a-zA-Z0-9\-_]{20,}/g,
  /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
  // Google
  /AIza[a-zA-Z0-9\-_]{30,}/g,
  // Brave
  /BSA[a-zA-Z0-9]{20,}/g,
  // GitHub (all formats)
  /ghp_[a-zA-Z0-9]{30,}/g,
  /gho_[a-zA-Z0-9]{30,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  // GitLab
  /glpat-[a-zA-Z0-9\-_]{15,}/g,
  // Slack (all token types)
  /xox[bpas]-[a-zA-Z0-9\-]{10,}/g,
  /xapp-[a-zA-Z0-9\-]{10,}/g,
  // AWS
  /AKIA[A-Z0-9]{12,}/g,
  // Omi
  /omi_dev_[a-zA-Z0-9\-_]{10,}/g,
  /omi_mcp_[a-zA-Z0-9\-_]{10,}/g,
  // NVIDIA
  /nvapi-[a-zA-Z0-9\-_]{10,}/g,
  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9\-_.]{20,}/g,
  // JWTs (three base64 segments separated by dots)
  /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g,
  // UUIDs (commonly used as secrets)
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
  // GHL / 2gether specific
  /pit-[a-zA-Z0-9\-]{20,}/g,
  /2g-admin-[a-zA-Z0-9]{6,}/g,
  // PEM private key blocks
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
];

const SECRET_KEYWORDS = [
  'api_key', 'apikey', 'api key', 'secret', 'password', 'token',
  'credential', 'auth_header', 'private_key', 'oauth',
  'refresh_token', 'access_token', 'client_secret',
];

function containsSecret(text) {
  for (const pat of SECRET_PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) return true;
  }
  const lower = text.toLowerCase();
  for (const kw of SECRET_KEYWORDS) {
    if (lower.includes(kw) && /[:=]\s*["']?[a-zA-Z0-9\-_.]{15,}/.test(text)) return true;
  }
  return false;
}

function redactSecrets(text) {
  let result = text;
  for (const pat of SECRET_PATTERNS) {
    result = result.replace(pat, '[REDACTED]');
  }
  return result;
}

// ─── Classification ──────────────────────────────────────────────────────────

const JUNK_PATTERNS = [
  /^\s*$/,
  /^[\[\{].*[\]\}]$/s,
  /^.{0,14}$/,
  /^(ok|yes|no|sure|thanks|got it|done)\s*$/i,
  /battery.*\d+%/i,
  /charging.*until/i,
  /^\[?(pre-compact|compacted)\]/i,
  /^notification:/i,
  /^\[Claude Code:/i,
];

const FAILURE_KEYWORDS = [
  'bug', 'crash', 'fix', 'broke', 'error', 'fail', 'workaround',
  'symptom', 'cause', 'prevention', 'gotcha', 'brittle', 'wipe',
  'loop', 'disconnect', 'timeout', 'stale', 'corrupt', 'kill',
  '440', 'SIGTERM', 'SIGINT', 'exit code', 'circuit breaker',
];

const DECISION_KEYWORDS = [
  'decided', 'chose', 'switched to', 'migrated', 'replaced',
  'architecture', 'tradeoff', 'trade-off', 'approach', 'strategy',
  'why we', 'rationale', 'because', 'instead of', 'over',
];

const ACTIVE_KEYWORDS = [
  'in progress', 'in-progress', 'wip', 'building', 'working on',
  'blocker', 'blocked', 'pending', 'todo', 'next step', 'current',
  'started', 'deploying', 'testing', 'waiting for', 'eta',
];

function classify(row) {
  const content = (row.content || '').trim();
  const category = (row.category || '').toLowerCase();
  const status = (row.status || '').toLowerCase();

  if (status === 'superseded' || status === 'resolved') return 'junk';
  if (status && status.startsWith('bridge:')) return 'raw_only';
  if (status && status.startsWith('consolidated:')) return 'raw_only';

  for (const pat of JUNK_PATTERNS) {
    if (pat.test(content)) return 'junk';
  }

  if (containsSecret(content)) return 'raw_only';
  if (content.length > 2000) return 'raw_only';
  if (category === 'contact_fact') return 'contact';

  const lower = content.toLowerCase();
  let failureScore = 0, decisionScore = 0, activeScore = 0;

  for (const kw of FAILURE_KEYWORDS) { if (lower.includes(kw)) failureScore++; }
  for (const kw of DECISION_KEYWORDS) { if (lower.includes(kw)) decisionScore++; }
  for (const kw of ACTIVE_KEYWORDS) { if (lower.includes(kw)) activeScore++; }

  if (category === 'decision') decisionScore += 3;
  if (category === 'task' || category === 'project_update') activeScore += 3;
  if (category === 'workflow') activeScore += 2;

  const maxScore = Math.max(failureScore, decisionScore, activeScore);
  if (maxScore >= 2) {
    if (failureScore >= 3 && failureScore >= decisionScore && failureScore >= activeScore) return 'failure';
    if (decisionScore === maxScore) return 'decision';
    if (activeScore === maxScore) return 'active';
    if (failureScore === maxScore && decisionScore >= 2) return 'decision';
    if (failureScore === maxScore) return 'failure';
  }

  if (['preference', 'personality', 'fact', 'observation'].includes(category)) return 'permanent';
  if (category === 'omi_memory' || category === 'sensor_memory') {
    const age = Date.now() - new Date(row.created_at).getTime();
    return age < 7 * 24 * 60 * 60 * 1000 ? 'active' : 'permanent';
  }
  if (category === 'idea') return 'permanent';
  if (content.length < 40) return 'raw_only';

  return 'permanent';
}

// ─── Frequency Scoring ───────────────────────────────────────────────────────

function wordOverlap(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

/**
 * Score each row by how many other rows corroborate it (>40% word overlap).
 * Attaches `row._frequency` (1 = unique, 2+ = corroborated).
 * Single-mention rows with short content (<80 chars) get demoted to raw_only.
 */
function scoreFrequency(rows) {
  for (const row of rows) {
    let count = 0;
    for (const other of rows) {
      if (other.id === row.id) continue;
      if (wordOverlap(row.content, other.content) > 0.40) count++;
    }
    row._frequency = count + 1; // 1 = self only
  }
  return rows;
}

/**
 * Demote low-frequency, low-signal rows from a promotable bucket to raw_only.
 * Returns [promoted, demoted].
 */
function applyFrequencyFilter(rows) {
  const promoted = [];
  const demoted = [];
  for (const row of rows) {
    // Single mention + short + not pinned → raw_only
    if (row._frequency === 1 && (row.content || '').length < 80 && !row.pinned) {
      demoted.push(row);
    } else {
      promoted.push(row);
    }
  }
  return [promoted, demoted];
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function dedup(rows) {
  if (rows.length <= 1) return rows;

  const sorted = [...rows].sort((a, b) => {
    const lenDiff = (b.content || '').length - (a.content || '').length;
    if (lenDiff !== 0) return lenDiff;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  const kept = [];
  const consumed = new Set();

  for (const row of sorted) {
    if (consumed.has(row.id)) continue;
    let isDupe = false;
    for (const k of kept) {
      if (wordOverlap(row.content, k.content) >= 0.85) {
        isDupe = true;
        break;
      }
    }
    if (!isDupe) kept.push(row);
    consumed.add(row.id);
  }

  return kept;
}

// ─── AI Refinement ───────────────────────────────────────────────────────────

/**
 * Refine a bucket of raw entries using Claude CLI.
 * Produces structured markdown. Falls back to template rendering on failure.
 * @param {string} bucket - 'permanent' | 'decision' | 'failure' | 'active' | 'contact'
 * @param {Array} rows - classified + deduped rows
 * @param {object} scopeConfig - { operatorName, botName, refineModel }
 * @returns {string} markdown
 */
function aiRefine(bucket, rows, scopeConfig) {
  if (rows.length === 0) return '';

  const model = scopeConfig.refineModel || 'haiku';
  const operatorName = scopeConfig.operatorName || 'the Operator';
  const rawContent = rows.map((r, i) => `[${i + 1}] (${r.category}, ${r.created_at ? r.created_at.split('T')[0] : '?'}): ${r.content}`).join('\n');

  const prompts = {
    permanent: `Output ONLY a markdown document. No commentary, no meta-descriptions, no explanations.

Synthesize these ${rows.length} memory fragments about "${operatorName}" into this EXACT structure:

## What I Know About ${operatorName}

(bullet list of personal facts, preferences, habits, communication style)

## Permanent Facts

(bullet list of system facts, business details, technical details)

## Workflows & Patterns

(bullet list of recurring processes, routines)

## Ideas

(bullet list of ideas and suggestions)

RULES: Merge duplicates. Preserve EXACT paths, ports, IPs, commands, config values. No secrets/keys. Skip empty sections. Output the markdown directly — nothing else.

Entries:
${rawContent}`,

    decision: `Output ONLY a markdown document. No commentary, no meta-descriptions.

Synthesize these ${rows.length} decision fragments into structured entries:

## [Short Decision Title]
- **Decision**: What was decided
- **Why**: The reasoning
- **Tradeoffs**: What was gained/lost
- **Date**: When

RULES: Merge fragments about the same decision. Preserve exact tool names, config values, architecture choices. Do not fabricate reasoning. Output markdown directly — nothing else.

Entries:
${rawContent}`,

    failure: `Output ONLY a markdown document. No commentary, no meta-descriptions.

Synthesize these ${rows.length} failure/bug fragments into structured entries:

## [Short Failure Title]
- **Symptom**: What went wrong
- **Cause**: Root cause
- **Fix**: What resolved it
- **Prevention**: How to avoid it

RULES: Merge fragments about the same failure. Preserve exact error messages, exit codes, process names, commands. Do not fabricate fixes. Output markdown directly — nothing else.

Entries:
${rawContent}`,

    active: `Output ONLY a markdown document. No commentary, no meta-descriptions.

Synthesize these ${rows.length} in-progress fragments into:

## Pending Tasks
## Project Updates
## In Motion

RULES: Merge fragments about the same project/task. Preserve exact status, blockers, next steps. Use bullet points. Output markdown directly — nothing else.

Entries:
${rawContent}`,

    contact: `Output ONLY a markdown document. No commentary, no meta-descriptions.

Group these ${rows.length} contact fragments by person:

## [Person Name or Identifier]
- **Role**: Their role/relationship
- **Key Facts**: Important things to remember
- **Communication Style**: How they communicate (if known)

RULES: Merge fragments about the same person. Preserve phone numbers, roles. No secrets/credentials. Output markdown directly — nothing else.

Entries:
${rawContent}`,
  };

  const prompt = prompts[bucket];
  if (!prompt) return null; // unknown bucket, fall back to template

  try {
    const result = execFileSync('claude', ['-p', prompt, '--model', model], {
      cwd: path.join(__dirname),
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_API_KEY: '' }, // empty string = CLI ignores it, uses OAuth/Max
    });
    const trimmed = (result || '').trim();
    // Guard: detect meta-commentary instead of actual content
    const isMeta = /^(Done|I've|I'll|I can|I would|Here's what|Here is|Here are|Looking at|Let me|Sure|Certainly|Absolutely|Below is|Below are|Okay|Of course|Great|Based on)/i.test(trimmed);
    // Also reject if first line doesn't start with # or - (not markdown)
    const firstLine = trimmed.split('\n')[0].trim();
    const looksLikeMarkdown = /^[#\-*>|]/.test(firstLine);
    if (trimmed.length > 100 && !isMeta && looksLikeMarkdown) return trimmed;
    if (isMeta || !looksLikeMarkdown) console.warn(`[CURATOR] AI output rejected for ${bucket} (meta or non-markdown), using template`);
  } catch (e) {
    console.warn(`[CURATOR] AI refine failed for ${bucket} (falling back to template):`, e.message);
  }

  return null; // signal to use template fallback
}

// ─── Template Rendering (non-AI fallback) ────────────────────────────────────

function renderMemoryMd(rows, scopeConfig) {
  const operatorName = scopeConfig.operatorName || 'the Operator';
  const groups = { preferences: [], facts: [], workflows: [], ideas: [], other: [] };

  for (const r of rows) {
    const cat = r.category;
    if (cat === 'preference' || cat === 'personality') groups.preferences.push(r);
    else if (cat === 'fact' || cat === 'observation') groups.facts.push(r);
    else if (cat === 'workflow') groups.workflows.push(r);
    else if (cat === 'idea') groups.ideas.push(r);
    else groups.other.push(r);
  }

  let md = `# MEMORY.md — Long-Term Memory\n\n`;
  if (groups.preferences.length) {
    md += `## What I Know About ${operatorName}\n\n`;
    for (const r of groups.preferences) md += `- ${r.content}\n`;
    md += `\n`;
  }
  if (groups.facts.length) {
    md += `## Permanent Facts\n\n`;
    for (const r of groups.facts) md += `- ${r.content}\n`;
    md += `\n`;
  }
  if (groups.workflows.length) {
    md += `## Workflows & Patterns\n\n`;
    for (const r of groups.workflows) md += `- ${r.content}\n`;
    md += `\n`;
  }
  if (groups.ideas.length) {
    md += `## Ideas\n\n`;
    for (const r of groups.ideas) md += `- ${r.content}\n`;
    md += `\n`;
  }
  if (groups.other.length) {
    md += `## Other\n\n`;
    for (const r of groups.other) md += `- ${r.content}\n`;
    md += `\n`;
  }
  return md;
}

function renderActiveMd(rows) {
  const tasks = rows.filter(r => r.category === 'task');
  const projects = rows.filter(r => r.category === 'project_update');
  const rest = rows.filter(r => !['task', 'project_update'].includes(r.category));
  let md = `# ACTIVE.md — Current State\n\n`;
  if (tasks.length) { md += `## Pending Tasks\n\n`; for (const r of tasks) md += `- ${r.content}\n`; md += `\n`; }
  if (projects.length) { md += `## Project Updates\n\n`; for (const r of projects) md += `- ${r.content}\n`; md += `\n`; }
  if (rest.length) { md += `## In Motion\n\n`; for (const r of rest) md += `- ${r.content}\n`; md += `\n`; }
  return md;
}

function renderDecisionsMd(rows) {
  let md = `# DECISIONS.md — Key Decisions\n\n`;
  for (const r of rows) {
    const date = r.created_at ? r.created_at.split('T')[0] : 'unknown';
    const firstLine = r.content.split('\n')[0].slice(0, 100).trim();
    md += `## ${firstLine}\n\n- **Decision**: ${r.content}\n- **Date**: ${date}\n\n---\n\n`;
  }
  return md;
}

function renderFailuresMd(rows) {
  let md = `# FAILURES.md — Known Issues & Workarounds\n\n`;
  for (const r of rows) {
    const date = r.created_at ? r.created_at.split('T')[0] : 'unknown';
    const firstLine = r.content.split('\n')[0].slice(0, 100).trim();
    md += `## ${firstLine}\n\n- **Details**: ${r.content}\n- **Date**: ${date}\n\n---\n\n`;
  }
  return md;
}

function formatContactId(jid, nameMap) {
  if (nameMap && nameMap[jid]) return nameMap[jid];
  let clean = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '').replace(/@g\.us$/, '').replace(/^tg_/, 'Telegram:');
  if (/^\d{10,}$/.test(clean)) return `+${clean}`;
  return clean;
}

function renderContactsMd(rows, nameMap) {
  const byContact = {};
  for (const r of rows) {
    const c = r.contact || 'unknown';
    if (!byContact[c]) byContact[c] = [];
    byContact[c].push(r);
  }
  let md = `# CONTACTS.md — People & Relationships\n\n`;
  for (const [contact, memories] of Object.entries(byContact)) {
    md += `## ${formatContactId(contact, nameMap)}\n\n`;
    for (const r of memories) md += `- ${r.content}\n`;
    md += `\n`;
  }
  return md;
}

// ─── Override Layer ──────────────────────────────────────────────────────────

/**
 * Load hand-curated override file if it exists.
 * Overrides are never touched by the curator — they're prepended to auto-curated content.
 */
function loadOverride(outputDir, filename) {
  const overridePath = path.join(outputDir, 'overrides', filename);
  if (fs.existsSync(overridePath)) {
    try {
      return fs.readFileSync(overridePath, 'utf8').trim();
    } catch (_) {}
  }
  return '';
}

// ─── Metadata ────────────────────────────────────────────────────────────────

function buildMeta(classified, demotedCount) {
  const meta = {
    lastRun: new Date().toISOString(),
    version: 2,
    stats: { total: 0, permanent: 0, active: 0, decision: 0, failure: 0, contact: 0, junk: 0, raw_only: 0, demotedByFrequency: demotedCount },
    sourceRows: {},
  };
  for (const [bucket, rows] of Object.entries(classified)) {
    meta.stats[bucket] = rows.length;
    meta.stats.total += rows.length;
    if (bucket !== 'junk' && bucket !== 'raw_only') {
      meta.sourceRows[bucket] = rows.map(r => r.id);
    }
  }
  return meta;
}

// ─── Core Run ────────────────────────────────────────────────────────────────

async function run(db, curatorConfig = {}) {
  const scope = curatorConfig.scope || 'default';
  const baseDir = curatorConfig.outputDir || path.join(__dirname, 'data', 'knowledge');
  const outputDir = path.join(baseDir, scope);
  const maxPerBucket = curatorConfig.maxPerBucket || 100;
  const operatorName = curatorConfig.operatorName || 'the Operator';
  const botName = curatorConfig.botName || 'the Bot';
  const staleActiveDays = curatorConfig.staleActiveDays || 14;
  const useAiRefine = curatorConfig.aiRefine || false;
  const refineModel = curatorConfig.refineModel || 'haiku';

  // Atomic file lock using exclusive create (O_EXCL via 'wx' flag)
  const lockPath = path.join(outputDir, '.curator-lock');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'overrides'), { recursive: true });
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      // Lock exists — check if stale (>5 min = process probably died)
      try {
        const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAge < 300_000) {
          console.log(`[CURATOR] Skipping — lock held (age: ${Math.round(lockAge / 1000)}s)`);
          return { stats: {}, outputDir };
        }
        // Stale lock — force remove and retry
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' });
      } catch (_) {
        console.log(`[CURATOR] Skipping — could not acquire lock`);
        return { stats: {}, outputDir };
      }
    } else {
      throw e;
    }
  }

  try {
    // ── Step 1: Read ──
    let allRows;
    if (db.db && typeof db.db.prepare === 'function') {
      allRows = db.db.prepare(`
        SELECT id, category, content, status, contact, source, pinned,
               created_at, updated_at, last_referenced
        FROM memories
        WHERE (status IS NULL OR status NOT IN ('superseded', 'resolved'))
        ORDER BY created_at DESC
      `).all();
    } else {
      const byCategory = db.getAllMemories();
      allRows = [];
      for (const rows of Object.values(byCategory)) allRows.push(...rows);
    }
    console.log(`[CURATOR] Read ${allRows.length} active memories for scope "${scope}"`);

    // ── Step 2: Classify ──
    const classified = { permanent: [], active: [], decision: [], failure: [], contact: [], junk: [], raw_only: [] };
    for (const row of allRows) classified[classify(row)].push(row);
    console.log(`[CURATOR] Classified: perm=${classified.permanent.length} act=${classified.active.length} dec=${classified.decision.length} fail=${classified.failure.length} contact=${classified.contact.length} junk=${classified.junk.length} raw=${classified.raw_only.length}`);

    // ── Step 3: Frequency scoring + demotion ──
    let totalDemoted = 0;
    for (const bucket of ['permanent', 'decision', 'failure']) {
      scoreFrequency(classified[bucket]);
      const [promoted, demoted] = applyFrequencyFilter(classified[bucket]);
      if (demoted.length) {
        console.log(`[CURATOR] Frequency filter ${bucket}: ${demoted.length} demoted to raw_only`);
        classified.raw_only.push(...demoted);
        classified[bucket] = promoted;
        totalDemoted += demoted.length;
      }
    }

    // ── Step 4: Dedup ──
    for (const bucket of ['permanent', 'active', 'decision', 'failure', 'contact']) {
      const before = classified[bucket].length;
      classified[bucket] = dedup(classified[bucket]);
      const after = classified[bucket].length;
      if (before !== after) console.log(`[CURATOR] Dedup ${bucket}: ${before} → ${after}`);
    }

    // ── Step 5: Cap ──
    for (const bucket of ['permanent', 'active', 'decision', 'failure', 'contact']) {
      if (classified[bucket].length > maxPerBucket) {
        classified[bucket].sort((a, b) => {
          if ((a.pinned || 0) !== (b.pinned || 0)) return (b.pinned || 0) - (a.pinned || 0);
          if ((a._frequency || 1) !== (b._frequency || 1)) return (b._frequency || 1) - (a._frequency || 1);
          return new Date(b.created_at) - new Date(a.created_at);
        });
        classified[bucket] = classified[bucket].slice(0, maxPerBucket);
      }
    }

    // ── Step 6: Expire stale active ──
    const staleMs = staleActiveDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    classified.active = classified.active.filter(r => (now - new Date(r.created_at).getTime()) < staleMs);

    // ── Step 7: Redact secrets (immutable) ──
    for (const bucket of ['permanent', 'active', 'decision', 'failure', 'contact']) {
      classified[bucket] = classified[bucket].map(r => ({ ...r, content: redactSecrets(r.content) }));
    }

    // ── Step 8: Render (AI or template) ──
    const scopeConfig = { operatorName, botName, refineModel };
    const files = {};

    if (useAiRefine) {
      console.log(`[CURATOR] AI refinement enabled (model: ${refineModel})`);
      for (const [bucket, filename] of [['permanent', 'MEMORY.md'], ['decision', 'DECISIONS.md'], ['failure', 'FAILURES.md'], ['active', 'ACTIVE.md'], ['contact', 'CONTACTS.md']]) {
        if (classified[bucket].length === 0) { files[filename] = ''; continue; }
        const refined = aiRefine(bucket, classified[bucket], scopeConfig);
        if (refined) {
          files[filename] = `# ${filename.replace('.md', '')} — Auto-Curated\n\n${refined}`;
        } else {
          // AI failed, use template
          files[filename] = bucket === 'permanent' ? renderMemoryMd(classified[bucket], scopeConfig) :
                           bucket === 'active' ? renderActiveMd(classified[bucket]) :
                           bucket === 'decision' ? renderDecisionsMd(classified[bucket]) :
                           bucket === 'failure' ? renderFailuresMd(classified[bucket]) :
                           renderContactsMd(classified[bucket], curatorConfig.contactNames || {});
        }
      }
    } else {
      files['MEMORY.md'] = renderMemoryMd(classified.permanent, scopeConfig);
      files['ACTIVE.md'] = renderActiveMd(classified.active);
      files['DECISIONS.md'] = renderDecisionsMd(classified.decision);
      files['FAILURES.md'] = renderFailuresMd(classified.failure);
      files['CONTACTS.md'] = renderContactsMd(classified.contact, curatorConfig.contactNames || {});
    }

    // ── Step 9: Prepend overrides + write atomically ──
    for (const [filename, content] of Object.entries(files)) {
      const override = loadOverride(outputDir, filename);
      const final = override ? override + '\n\n---\n\n' + content : content;
      const filePath = path.join(outputDir, filename);
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, final, 'utf8');
      fs.renameSync(tmpPath, filePath);
    }

    // ── Step 10: Metadata ──
    const meta = buildMeta(classified, totalDemoted);
    const metaPath = path.join(outputDir, '.curator-meta.json');
    fs.writeFileSync(metaPath + '.tmp', JSON.stringify(meta, null, 2), 'utf8');
    fs.renameSync(metaPath + '.tmp', metaPath);

    _cache = { scope: null, content: '', loadedAt: 0, mtime: 0 };
    console.log(`[CURATOR] Wrote curated files to ${outputDir} (aiRefine: ${useAiRefine})`);
    return { stats: meta.stats, outputDir };

  } finally {
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}

// ─── Prompt Loading ──────────────────────────────────────────────────────────

function loadCuratedBrain(curatorConfig = {}, options = {}) {
  if (!curatorConfig.enabled) return '';
  if (options.operatorOnly === false) return '';

  const scope = curatorConfig.scope || 'default';
  const baseDir = curatorConfig.outputDir || path.join(__dirname, 'data', 'knowledge');
  const outputDir = path.join(baseDir, scope);

  if (!fs.existsSync(outputDir) || !fs.existsSync(path.join(outputDir, 'MEMORY.md'))) {
    _scheduleBootstrap(curatorConfig, scope);
    return '';
  }

  const now = Date.now();
  if (_cache.scope === scope && (now - _cache.loadedAt) < CACHE_TTL_MS) {
    try {
      const mtime = fs.statSync(path.join(outputDir, 'MEMORY.md')).mtimeMs;
      if (mtime === _cache.mtime) return _cache.content;
    } catch (_) {}
  }

  const alwaysLoad = curatorConfig.alwaysLoad || ['MEMORY.md', 'ACTIVE.md', 'FAILURES.md'];
  const conditionalLoad = curatorConfig.conditionalLoad || ['DECISIONS.md', 'CONTACTS.md'];
  const maxChars = curatorConfig.maxPromptChars || 15000;

  const filesToLoad = options.lightweight ? ['MEMORY.md'] : [...alwaysLoad, ...conditionalLoad];

  let sections = [];
  let totalChars = 0;
  let memoryMtime = 0;

  for (const filename of filesToLoad) {
    const filePath = path.join(outputDir, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      if (filename === 'MEMORY.md') memoryMtime = fs.statSync(filePath).mtimeMs;
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content || content.length < 20) continue;
      if (totalChars + content.length > maxChars) {
        const remaining = maxChars - totalChars;
        if (remaining > 200) sections.push(content.slice(0, remaining) + '\n\n[... truncated for prompt budget]');
        break;
      }
      sections.push(content);
      totalChars += content.length;
    } catch (_) {}
  }

  if (sections.length === 0) return '';

  const result = '\n\n=== CURATED KNOWLEDGE (auto-maintained) ===\n\n'
    + sections.join('\n\n---\n\n')
    + '\n\n=== END CURATED KNOWLEDGE ===\n\n';

  _cache = { scope, content: result, loadedAt: now, mtime: memoryMtime };
  return result;
}

// Async bootstrap
let _bootstrapScheduled = false;
function _scheduleBootstrap(curatorConfig, scope) {
  if (_bootstrapScheduled) return;
  _bootstrapScheduled = true;
  setImmediate(() => {
    try {
      const dbPath = curatorConfig.dbPath || path.join(__dirname, 'data', 'favor.db');
      const curatorPath = path.join(__dirname, 'curator.js');
      const configPath = path.join(__dirname, 'config.json');
      if (!fs.existsSync(dbPath) || !fs.existsSync(curatorPath) || !fs.existsSync(configPath)) {
        _bootstrapScheduled = false; return;
      }
      const { execFile } = require('child_process');
      execFile('node', [curatorPath, scope], { cwd: __dirname, timeout: 120_000 }, (err) => {
        _bootstrapScheduled = false;
        if (!err) {
          console.log(`[CURATOR] Auto-bootstrap complete for scope "${scope}".`);
          _cache = { scope: null, content: '', loadedAt: 0, mtime: 0 };
        }
      });
    } catch (_) { _bootstrapScheduled = false; }
  });
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

if (require.main === module) {
  const scope = process.argv[2] || 'default';
  const configPath = path.join(__dirname, 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {
    console.error('[CURATOR] Could not load config.json:', e.message); process.exit(1);
  }
  const FavorMemory = require('./db');
  const dbPath = (config.memory && config.memory.dbPath) || './data/favor.db';
  const db = new FavorMemory(dbPath);
  const curatorConfig = { ...(config.curator || {}), scope };

  run(db, curatorConfig).then(result => {
    console.log(`[CURATOR] Done. Stats:`, JSON.stringify(result.stats));
    process.exit(0);
  }).catch(err => {
    console.error('[CURATOR] Error:', err);
    process.exit(1);
  });
}

module.exports = { run, loadCuratedBrain, classify, dedup, containsSecret, scoreFrequency };
