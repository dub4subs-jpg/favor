// ─── API COST TRACKER ───
// Logs every API call with token counts and estimated costs
// Stores in SQLite for dashboard display

const PRICING = {
  // OpenAI (per 1M tokens)
  'gpt-4o':        { input: 2.50, output: 10.00 },
  'gpt-4o-mini':   { input: 0.15, output: 0.60 },
  'gpt-4.1':       { input: 2.00, output: 8.00 },
  'gpt-4.1-mini':  { input: 0.40, output: 1.60 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  // Gemini (per 1M tokens)
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  // Kimi (per 1M tokens)
  'kimi-k2':       { input: 0.60, output: 2.50 },
  'kimi-k2.5':     { input: 0.60, output: 2.50 },
};

class CostTracker {
  constructor(db) {
    this.db = db;
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_costs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        caller TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_costs_date ON api_costs(created_at);
      CREATE INDEX IF NOT EXISTS idx_costs_model ON api_costs(model);
    `);
  }

  // Log an OpenAI API call (extracts tokens from response)
  logOpenAI(response, caller = 'unknown') {
    try {
      const usage = response.usage;
      if (!usage) return;

      const model = response.model || 'unknown';
      const inputTokens = usage.prompt_tokens || 0;
      const outputTokens = usage.completion_tokens || 0;
      const cost = this._calcCost(model, inputTokens, outputTokens);

      this.db.prepare(
        'INSERT INTO api_costs (model, provider, caller, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(model, 'openai', caller, inputTokens, outputTokens, cost);
    } catch (e) {
      // Non-fatal — don't break the bot if tracking fails
    }
  }

  // Log a Gemini API call
  logGemini(result, model = 'gemini-2.5-flash', caller = 'unknown') {
    try {
      const usage = result.response?.usageMetadata;
      if (!usage) return;

      const inputTokens = usage.promptTokenCount || 0;
      const outputTokens = usage.candidatesTokenCount || 0;
      const cost = this._calcCost(model, inputTokens, outputTokens);

      this.db.prepare(
        'INSERT INTO api_costs (model, provider, caller, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(model, 'google', caller, inputTokens, outputTokens, cost);
    } catch (e) {
      // Non-fatal
    }
  }

  // Log an embedding call
  logEmbedding(response, caller = 'embeddings') {
    try {
      const usage = response.usage;
      if (!usage) return;

      const tokens = usage.total_tokens || usage.prompt_tokens || 0;
      const cost = this._calcCost('text-embedding-3-small', tokens, 0);

      this.db.prepare(
        'INSERT INTO api_costs (model, provider, caller, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('text-embedding-3-small', 'openai', caller, tokens, 0, cost);
    } catch (e) {
      // Non-fatal
    }
  }

  // Get summary for dashboard
  getSummary() {
    const today = this.db.prepare(`
      SELECT provider, model, caller,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(cost_usd) as cost,
             COUNT(*) as calls
      FROM api_costs
      WHERE created_at >= date('now')
      GROUP BY provider, model, caller
      ORDER BY cost DESC
    `).all();

    const week = this.db.prepare(`
      SELECT provider, model,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(cost_usd) as cost,
             COUNT(*) as calls
      FROM api_costs
      WHERE created_at >= date('now', '-7 days')
      GROUP BY provider, model
      ORDER BY cost DESC
    `).all();

    const month = this.db.prepare(`
      SELECT provider, model,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(cost_usd) as cost,
             COUNT(*) as calls
      FROM api_costs
      WHERE created_at >= date('now', '-30 days')
      GROUP BY provider, model
      ORDER BY cost DESC
    `).all();

    const dailyTrend = this.db.prepare(`
      SELECT date(created_at) as day,
             SUM(cost_usd) as cost,
             SUM(input_tokens + output_tokens) as tokens,
             COUNT(*) as calls
      FROM api_costs
      WHERE created_at >= date('now', '-14 days')
      GROUP BY date(created_at)
      ORDER BY day ASC
    `).all();

    const totals = {
      today: today.reduce((s, r) => s + r.cost, 0),
      week: week.reduce((s, r) => s + r.cost, 0),
      month: month.reduce((s, r) => s + r.cost, 0),
    };

    return { totals, today, week, month, dailyTrend };
  }

  _calcCost(model, inputTokens, outputTokens) {
    // Normalize model name (OpenAI returns versioned names like gpt-4o-2024-08-06)
    const base = Object.keys(PRICING).find(k => model.startsWith(k)) || model;
    const pricing = PRICING[base];
    if (!pricing) return 0;
    return (inputTokens / 1_000_000 * pricing.input) + (outputTokens / 1_000_000 * pricing.output);
  }
}

module.exports = CostTracker;
