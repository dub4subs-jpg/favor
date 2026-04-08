const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const Analytics = require('../analytics');

const TEST_DB_PATH = path.join(__dirname, '.test-analytics.db');
let sqliteDb;
let analytics;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  sqliteDb = new Database(TEST_DB_PATH);

  // Create tables that Analytics queries
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS router_telemetry (
      id INTEGER PRIMARY KEY,
      route TEXT,
      total_ms INTEGER,
      confidence REAL,
      success INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS api_costs (
      id INTEGER PRIMARY KEY,
      model TEXT,
      provider TEXT,
      caller TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY,
      type TEXT,
      data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY,
      lesson TEXT,
      confidence REAL DEFAULT 1.0,
      hit_count INTEGER DEFAULT 0
    );
  `);

  analytics = new Analytics(sqliteDb);
});

afterEach(() => {
  sqliteDb.close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
});

describe('Analytics', () => {
  test('constructor accepts raw better-sqlite3 db', () => {
    const a = new Analytics(sqliteDb);
    expect(a.db).toBe(sqliteDb);
  });

  test('constructor accepts FavorMemory wrapper (has .db property)', () => {
    const wrapper = { db: sqliteDb };
    const a = new Analytics(wrapper);
    expect(a.db).toBe(sqliteDb);
  });

  test('routeStats returns empty array when no data', () => {
    expect(analytics.routeStats()).toEqual([]);
  });

  test('routeStats aggregates by route', () => {
    const stmt = sqliteDb.prepare('INSERT INTO router_telemetry (route, total_ms, confidence, success) VALUES (?, ?, ?, ?)');
    stmt.run('chat', 100, 0.9, 1);
    stmt.run('chat', 200, 0.8, 1);
    stmt.run('tool', 500, 0.95, 1);
    stmt.run('tool', 300, 0.7, 0);

    const stats = analytics.routeStats('-1 day');
    expect(stats.length).toBe(2);

    const chat = stats.find(s => s.route === 'chat');
    expect(chat.calls).toBe(2);
    expect(chat.successes).toBe(2);

    const tool = stats.find(s => s.route === 'tool');
    expect(tool.calls).toBe(2);
    expect(tool.successes).toBe(1);
  });

  test('costStats aggregates by model', () => {
    const stmt = sqliteDb.prepare('INSERT INTO api_costs (model, provider, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)');
    stmt.run('gpt-4o', 'openai', 1000, 500, 0.025);
    stmt.run('gpt-4o', 'openai', 2000, 1000, 0.05);
    stmt.run('claude-haiku', 'anthropic', 500, 200, 0.001);

    const stats = analytics.costStats('-1 day');
    expect(stats.length).toBe(2);

    const gpt = stats.find(s => s.model === 'gpt-4o');
    expect(gpt.calls).toBe(2);
    expect(gpt.total_cost).toBe(0.075);
    expect(gpt.total_in).toBe(3000);
  });

  test('dailyCostTrend returns day-level aggregation', () => {
    const stmt = sqliteDb.prepare('INSERT INTO api_costs (model, provider, cost_usd) VALUES (?, ?, ?)');
    stmt.run('gpt-4o', 'openai', 0.01);
    stmt.run('gpt-4o', 'openai', 0.02);

    const trend = analytics.dailyCostTrend(7);
    expect(trend.length).toBe(1);
    expect(trend[0].calls).toBe(2);
    expect(trend[0].cost).toBe(0.03);
  });

  test('misrouteCount returns 0 when no misroutes', () => {
    expect(analytics.misrouteCount()).toBe(0);
  });

  test('misrouteCount counts misroute signals', () => {
    sqliteDb.prepare('INSERT INTO signals (type) VALUES (?)').run('misroute');
    sqliteDb.prepare('INSERT INTO signals (type) VALUES (?)').run('misroute');
    sqliteDb.prepare('INSERT INTO signals (type) VALUES (?)').run('other');
    expect(analytics.misrouteCount()).toBe(2);
  });

  test('lessonStats returns stats', () => {
    sqliteDb.prepare('INSERT INTO lessons (lesson, confidence, hit_count) VALUES (?, ?, ?)').run('test lesson', 0.8, 5);
    sqliteDb.prepare('INSERT INTO lessons (lesson, confidence, hit_count) VALUES (?, ?, ?)').run('low conf', 0.3, 1);

    const stats = analytics.lessonStats();
    expect(stats.total).toBe(2);
    expect(stats.active).toBe(1); // only confidence > 0.5
    expect(stats.topHit.length).toBe(2);
    expect(stats.topHit[0].hit_count).toBe(5);
  });

  test('report generates markdown string', () => {
    const stmt = sqliteDb.prepare('INSERT INTO router_telemetry (route, total_ms, confidence, success) VALUES (?, ?, ?, ?)');
    stmt.run('chat', 100, 0.9, 1);
    stmt.run('tool', 500, 0.95, 1);

    const costStmt = sqliteDb.prepare('INSERT INTO api_costs (model, provider, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)');
    costStmt.run('gpt-4o', 'openai', 1000, 500, 0.025);

    const report = analytics.report('day');
    expect(report).toContain('Analytics');
    expect(report).toContain('Overview');
    expect(report).toContain('Routes');
    expect(report).toContain('chat');
    expect(report).toContain('gpt-4o');
  });

  test('report with week period includes daily trend', () => {
    sqliteDb.prepare('INSERT INTO api_costs (model, provider, cost_usd) VALUES (?, ?, ?)').run('gpt-4o', 'openai', 0.01);
    const report = analytics.report('week');
    expect(report).toContain('This Week');
    expect(report).toContain('Daily Trend');
  });
});
