// reflect.js — Self-Improvement Loop for DellV2/Favor
// Analyzes recent interactions, extracts behavioral lessons, stores them for future use.
// Runs every 6 hours via setInterval (scheduled in favor.js).

const { runClaudeCLI } = require('./router');

const WINDOW_HOURS = 6;
const MAX_PROBLEMS = 5; // max problematic interactions to analyze per cycle

// ─── PHASE A: SIGNAL COLLECTION (pure SQL + JS, no AI) ───

function scoreInteraction(row) {
  let score = 7; // start neutral-positive

  // Failure
  if (!row.success) score -= 3;

  // Slow response (>45s)
  if (row.total_ms > 45000) score -= 2;

  // Excessive tool usage
  let toolList = [];
  try { toolList = JSON.parse(row.tools_used || '[]'); } catch (_) {}
  if (toolList.length > 3) score -= 1;

  // Tool retry (same tool called multiple times = probably failed first time)
  const toolCounts = {};
  for (const t of toolList) toolCounts[t] = (toolCounts[t] || 0) + 1;
  const hasRetry = Object.values(toolCounts).some(c => c > 1);
  if (hasRetry) score -= 3;

  // Clean success bonus
  if (row.success && toolList.length <= 2 && row.total_ms < 20000) score += 2;

  return Math.max(0, Math.min(10, score));
}

function collectSignals(db, windowStart, windowEnd) {
  const rawDb = db.db || db;

  // Get telemetry for this window
  const rows = rawDb.prepare(`
    SELECT * FROM router_telemetry
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at DESC
  `).all(windowStart, windowEnd);

  if (!rows.length) return { rows: [], problems: [], stats: null };

  // Score each interaction
  const scored = rows.map(r => ({ ...r, quality_score: scoreInteraction(r) }));

  // Get worst interactions (score < 5)
  const problems = scored
    .filter(r => r.quality_score < 5)
    .sort((a, b) => a.quality_score - b.quality_score)
    .slice(0, MAX_PROBLEMS);

  // Aggregate stats
  const routes = {};
  const toolFailures = {};
  let totalMs = 0, successCount = 0;
  for (const r of scored) {
    routes[r.route] = (routes[r.route] || 0) + 1;
    totalMs += r.total_ms || 0;
    if (r.success) successCount++;
    let tools = [];
    try { tools = JSON.parse(r.tools_used || '[]'); } catch (_) {}
    if (!r.success) {
      for (const t of tools) toolFailures[t] = (toolFailures[t] || 0) + 1;
    }
  }

  const stats = {
    total: rows.length,
    successRate: Math.round((successCount / rows.length) * 100),
    avgResponseMs: Math.round(totalMs / rows.length),
    routeDistribution: routes,
    toolFailures: Object.keys(toolFailures).length ? toolFailures : null,
    problemCount: problems.length
  };

  // Pull audit errors from same window
  const auditErrors = rawDb.prepare(`
    SELECT action, detail, timestamp FROM config_audit
    WHERE timestamp >= ? AND timestamp <= ?
    AND (action LIKE '%error%' OR action LIKE '%fail%' OR action LIKE '%block%')
    ORDER BY timestamp DESC LIMIT 10
  `).all(windowStart, windowEnd);

  return { rows: scored, problems, stats, auditErrors };
}

// ─── PHASE B: REFLECTION (1 Claude Haiku CLI call) ───

async function reflect(db, problems, stats, auditErrors) {
  // Get existing active lessons for context
  const activeLessons = db.getAllActiveLessons();

  // Build the reflection prompt
  const prompt = `You are analyzing DellV2's recent WhatsApp bot interactions to extract behavioral lessons that will make the bot better over time.

=== PERFORMANCE STATS (last ${WINDOW_HOURS} hours) ===
Total interactions: ${stats.total}
Success rate: ${stats.successRate}%
Avg response time: ${stats.avgResponseMs}ms
Route distribution: ${JSON.stringify(stats.routeDistribution)}
${stats.toolFailures ? 'Tool failures: ' + JSON.stringify(stats.toolFailures) : 'No tool failures'}
Problem interactions: ${stats.problemCount}

${problems.length ? `=== PROBLEMATIC INTERACTIONS ===
${problems.map((p, i) => `
[${i + 1}] Route: ${p.route} | Model: ${p.model_used} | Score: ${p.quality_score}/10
Tools used: ${p.tools_used}
Success: ${p.success ? 'yes' : 'NO'}
Response time: ${p.total_ms}ms
Reason: ${p.reason}
`).join('')}` : ''}

${auditErrors?.length ? `=== SYSTEM ERRORS ===
${auditErrors.map(e => `${e.action}: ${e.detail}`).join('\n')}` : ''}

${activeLessons.length ? `=== CURRENT ACTIVE LESSONS (ID — confidence — lesson) ===
${activeLessons.map(l => `[${l.id}] (${l.confidence.toFixed(2)}) ${l.type}: ${l.lesson}`).join('\n')}` : '=== NO EXISTING LESSONS YET ==='}

Extract 0-3 NEW actionable lessons from the data above. Each lesson must be:
- Specific and actionable (not "be better" but "when X happens, do Y instead of Z")
- About behavior the bot can actually change
- Different from existing lessons (don't duplicate)
- One of these types: behavioral, routing, tool, correction

For existing lessons: if this data reinforces one, include its ID in "reinforce". If data contradicts one, include its ID in "contradict".

If everything looks healthy and there's nothing to learn, return empty arrays.

Return ONLY valid JSON (no markdown, no explanation):
{"new_lessons":[{"type":"behavioral|routing|tool|correction","lesson":"...","evidence":"..."}],"reinforce":[],"contradict":[],"summary":"one-line summary"}`;

  const raw = await runClaudeCLI(prompt, 30000, { model: 'haiku' });

  // Parse JSON from response (handle markdown wrapping)
  let cleaned = raw.trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in reflection response');
  return JSON.parse(jsonMatch[0]);
}

// ─── PHASE C: STORAGE ───

function storeResults(db, result) {
  let created = 0, reinforced = 0, retired = 0;

  // Store new lessons
  if (result.new_lessons?.length) {
    for (const lesson of result.new_lessons.slice(0, 3)) {
      if (!lesson.lesson || lesson.lesson.length < 10) continue;
      const validTypes = ['behavioral', 'routing', 'tool', 'correction'];
      const rawType = (lesson.type || '').toLowerCase();
      const type = validTypes.find(t => rawType.includes(t)) || 'behavioral';
      const confidence = type === 'correction' ? 0.6 : 0.3;
      db.saveLesson(type, lesson.lesson, lesson.evidence || null, confidence);
      created++;
    }
  }

  // Reinforce existing lessons
  if (result.reinforce?.length) {
    for (const id of result.reinforce) {
      if (typeof id === 'number' && id > 0) {
        db.reinforceLesson(id);
        reinforced++;
      }
    }
  }

  // Contradict existing lessons
  if (result.contradict?.length) {
    for (const id of result.contradict) {
      if (typeof id === 'number' && id > 0) {
        db.contradictLesson(id);
      }
    }
  }

  // Staleness cleanup
  const { stale, overflow } = db.retireStale();
  retired = stale + overflow;

  return { created, reinforced, retired };
}

// ─── MAIN ENTRY POINT ───

async function run(db) {
  const now = new Date();
  const windowEnd = now.toISOString().replace('T', ' ').substring(0, 19);
  const windowStart = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').substring(0, 19);

  console.log(`[REFLECT] Starting reflection cycle: ${windowStart} → ${windowEnd}`);

  // Phase A: collect signals
  const { problems, stats, auditErrors } = collectSignals(db, windowStart, windowEnd);

  if (!stats || stats.total === 0) {
    console.log('[REFLECT] No interactions in window, skipping');
    db.logReflection({
      windowStart, windowEnd, analyzed: 0,
      created: 0, reinforced: 0, retired: 0,
      summary: 'No interactions in window'
    });
    return { skipped: true, reason: 'no interactions' };
  }

  console.log(`[REFLECT] ${stats.total} interactions, ${stats.problemCount} problems, ${stats.successRate}% success rate`);

  // Phase B: reflect with Claude Haiku (only if there are problems OR we have no lessons yet)
  const lessonCount = db.getAllActiveLessons().length;
  if (problems.length === 0 && lessonCount > 0 && stats.successRate >= 90) {
    // Everything is going well — just run staleness cleanup
    const { stale, overflow } = db.retireStale();
    const summary = `All healthy: ${stats.successRate}% success, ${stats.total} interactions. Retired ${stale + overflow} stale lessons.`;
    console.log(`[REFLECT] ${summary}`);
    db.logReflection({
      windowStart, windowEnd, analyzed: stats.total,
      created: 0, reinforced: 0, retired: stale + overflow,
      summary
    });
    return { skipped: false, healthy: true, summary };
  }

  let result;
  try {
    result = await reflect(db, problems, stats, auditErrors);
  } catch (e) {
    console.error('[REFLECT] Haiku reflection failed:', e.message);
    db.logReflection({
      windowStart, windowEnd, analyzed: stats.total,
      created: 0, reinforced: 0, retired: 0,
      summary: `Reflection failed: ${e.message}`
    });
    return { error: e.message };
  }

  // Phase C: store results
  const { created, reinforced, retired } = storeResults(db, result);
  const summary = result.summary || `Created ${created}, reinforced ${reinforced}, retired ${retired}`;

  console.log(`[REFLECT] Done: ${summary}`);
  db.logReflection({
    windowStart, windowEnd, analyzed: stats.total,
    created, reinforced, retired, summary
  });

  db.audit('reflect.cycle', `analyzed:${stats.total} created:${created} reinforced:${reinforced} retired:${retired}`);

  return { created, reinforced, retired, summary, stats };
}

module.exports = { run, scoreInteraction, collectSignals };
