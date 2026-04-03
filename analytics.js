// analytics.js — Route + cost + quality analytics for DellV2
// Generates Markdown reports from router_telemetry, api_costs, signals, and lessons tables

class Analytics {
  constructor(db) {
    // Accept FavorMemory wrapper or raw better-sqlite3
    this.db = (db && typeof db.exec === 'function') ? db : (db && db.db);
  }

  // Route distribution for a time window
  routeStats(since = '-1 day') {
    // Check if confidence column exists
    const cols = this.db.prepare("PRAGMA table_info(router_telemetry)").all().map(c => c.name);
    const hasConf = cols.includes('confidence');
    return this.db.prepare(`
      SELECT route, COUNT(*) as calls,
        ROUND(AVG(total_ms)) as avg_ms,
        ${hasConf ? 'ROUND(AVG(confidence), 2) as avg_conf,' : ''}
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
      FROM router_telemetry
      WHERE created_at > datetime('now', ?)
      GROUP BY route ORDER BY calls DESC
    `).all(since);
  }

  // Cost breakdown by model
  costStats(since = '-1 day') {
    return this.db.prepare(`
      SELECT model, provider, COUNT(*) as calls,
        SUM(input_tokens) as total_in,
        SUM(output_tokens) as total_out,
        ROUND(SUM(cost_usd), 4) as total_cost
      FROM api_costs
      WHERE created_at > datetime('now', ?)
      GROUP BY model ORDER BY total_cost DESC
    `).all(since);
  }

  // Daily cost trend (last N days)
  dailyCostTrend(days = 7) {
    return this.db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as calls,
        ROUND(SUM(cost_usd), 4) as cost
      FROM api_costs
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY day ORDER BY day DESC
    `).all(days);
  }

  // Misroute count
  misrouteCount(since = '-1 day') {
    try {
      return this.db.prepare(`
        SELECT COUNT(*) as count FROM signals
        WHERE type = 'misroute' AND created_at > datetime('now', ?)
      `).get(since)?.count || 0;
    } catch { return 0; }
  }

  // Low confidence routing events
  lowConfidenceCount(since = '-1 day') {
    try {
      return this.db.prepare(`
        SELECT COUNT(*) as count FROM router_telemetry
        WHERE confidence < 0.5 AND created_at > datetime('now', ?)
      `).get(since)?.count || 0;
    } catch { return 0; }
  }

  // Active lesson stats
  lessonStats() {
    try {
      const total = this.db.prepare('SELECT COUNT(*) as c FROM lessons').get()?.c || 0;
      const active = this.db.prepare('SELECT COUNT(*) as c FROM lessons WHERE confidence > 0.5').get()?.c || 0;
      const topHit = this.db.prepare('SELECT lesson, hit_count FROM lessons ORDER BY hit_count DESC LIMIT 3').all();
      return { total, active, topHit };
    } catch { return { total: 0, active: 0, topHit: [] }; }
  }

  // Generate a full Markdown report
  report(period = 'day') {
    const since = period === 'week' ? '-7 days' : '-1 day';
    const label = period === 'week' ? 'This Week' : 'Today';

    const routes = this.routeStats(since);
    const costs = this.costStats(since);
    const trend = period === 'week' ? this.dailyCostTrend(7) : null;
    const misroutes = this.misrouteCount(since);
    const lowConf = this.lowConfidenceCount(since);
    const lessons = this.lessonStats();

    const totalCalls = routes.reduce((s, r) => s + r.calls, 0);
    const totalCost = costs.reduce((s, c) => s + c.total_cost, 0);
    const avgMs = totalCalls ? Math.round(routes.reduce((s, r) => s + r.avg_ms * r.calls, 0) / totalCalls) : 0;
    const successRate = totalCalls ? Math.round(routes.reduce((s, r) => s + r.successes, 0) / totalCalls * 100) : 0;

    let md = `*Analytics — ${label}*\n\n`;

    // Overview
    md += `*Overview*\n`;
    md += `Messages: ${totalCalls} | Success: ${successRate}% | Avg: ${avgMs}ms\n`;
    md += `Cost: $${totalCost.toFixed(4)} | Misroutes: ${misroutes} | Low-conf: ${lowConf}\n\n`;

    // Route breakdown
    if (routes.length) {
      md += `*Routes*\n`;
      for (const r of routes) {
        const pct = totalCalls ? Math.round(r.calls / totalCalls * 100) : 0;
        md += `${r.route}: ${r.calls} (${pct}%) — ${r.avg_ms}ms, conf ${r.avg_conf || '?'}\n`;
      }
      md += '\n';
    }

    // Cost breakdown
    if (costs.length) {
      md += `*Costs*\n`;
      for (const c of costs) {
        md += `${c.model}: ${c.calls} calls, $${c.total_cost} (${(c.total_in / 1000).toFixed(0)}k in / ${(c.total_out / 1000).toFixed(0)}k out)\n`;
      }
      md += '\n';
    }

    // Weekly trend
    if (trend?.length) {
      md += `*Daily Trend*\n`;
      for (const d of trend) {
        md += `${d.day}: ${d.calls} calls, $${d.cost}\n`;
      }
      md += '\n';
    }

    // Lessons
    if (lessons.active > 0) {
      md += `*Lessons*: ${lessons.active} active / ${lessons.total} total\n`;
      if (lessons.topHit.length) {
        md += `Top: ${lessons.topHit.map(l => `"${l.lesson.slice(0, 50)}" (${l.hit_count}x)`).join(', ')}\n`;
      }
    }

    return md.trim();
  }
}

module.exports = Analytics;
