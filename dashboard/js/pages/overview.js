// overview.js — Main command center: stats, charts, guardian, activity, system health
import { h, mount } from '../lib/dom.js';
import { currency, duration, number, relativeTime, ms } from '../lib/format.js';
import { api } from '../api.js';
import { createStatCard } from '../components/stat-card.js';
import { createBarChart, createDonutChart } from '../components/chart.js';
import { createProgressBar } from '../components/progress-bar.js';
import { createActivityFeed } from '../components/activity-feed.js';

let timers = [];
export function unmount() { timers.forEach(clearInterval); timers = []; }

function poll(fn, ms) { fn(); timers.push(setInterval(fn, ms)); }

const empty = (msg) => h('div', { class: 'chart-empty' }, msg);
const routeColors = ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', 'var(--accent)', '#34d399', '#fbbf24', '#f87171'];

export function mount_(container) {
  unmount();
  let health = null, costs = null, audit = null, guardian = null, analytics = null;

  function render() {
    // Row 1: stat cards
    const memTotal = health?.memories ? Object.values(health.memories).reduce((a, b) => a + (b || 0), 0) : 0;
    const queueDepth = health?.queue?.waiting ?? health?.queue?.active ?? 0;
    const todaySpend = costs?.totals?.today ?? 0;
    const statsRow = h('div', { class: 'grid-5' },
      createStatCard({ label: 'Uptime', value: health?.uptime_seconds ? duration(health.uptime_seconds) : '\u2014', color: 'var(--success)' }),
      createStatCard({ label: 'Memories', value: number(memTotal), color: 'var(--accent)' }),
      createStatCard({ label: 'Active Crons', value: String(health?.active_crons ?? 0), color: '#8b5cf6' }),
      createStatCard({ label: 'Queue', value: String(queueDepth), color: queueDepth > 5 ? 'var(--warning)' : 'var(--accent)' }),
      createStatCard({ label: 'Today Spend', value: currency(todaySpend), color: 'var(--accent)' }));

    // Row 2: cost trend + route donut
    const daily = costs?.daily_trend || [];
    const cVals = daily.map(d => d.total ?? d.cost ?? d);
    const cLbls = daily.map(d => d.label || d.date || '');

    const routes = analytics?.routes || costs?.by_route || [];
    const segs = routes.map((r, i) => ({ label: r.route || r.name || `Route ${i+1}`, value: r.count || r.value || 0, color: routeColors[i % routeColors.length] }));

    const row2 = h('div', { class: 'grid-2-1' },
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Cost Trend'),
        cVals.length ? createBarChart(cVals, { height: 160, labels: cLbls }) : empty('No cost data yet')),
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Routes'),
        segs.length ? createDonutChart(segs, { size: 140, thickness: 18 }) : empty('No route data')));

    // Row 3: guardian + activity + system
    const guardianCard = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Guardian Limits'));
    if (guardian?.dailySpend) {
      // Parse "current / max" format from guardian status
      const parse = (s) => { const m = String(s).match(/([\d.]+)\s*\/\s*\$?([\d.]+)/); return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 100]; };
      const [spendCur, spendMax] = parse(guardian.dailySpend.replace(/\$/g, ''));
      const [reqCur, reqMax] = parse(guardian.dailyRequests);
      const [hrCur, hrMax] = parse(guardian.hourlyRequests);
      guardianCard.appendChild(createProgressBar({ label: 'Daily Spend', current: spendCur, max: spendMax, unit: '$' }));
      guardianCard.appendChild(createProgressBar({ label: 'Requests/Day', current: reqCur, max: reqMax }));
      guardianCard.appendChild(createProgressBar({ label: 'Requests/Hour', current: hrCur, max: hrMax }));
    } else {
      guardianCard.appendChild(empty(guardian ? 'No limits configured' : 'Loading...'));
    }

    const auditItems = (audit?.entries || []).slice(0, 12).map(i => ({
      name: i.tool_name || i.tool || 'unknown',
      status: i.status || 'pending',
      detail: i.contact || '', time: relativeTime(i.created_at || i.timestamp),
      elapsed: i.elapsed_ms ? ms(i.elapsed_ms) : ''
    }));

    const sysCard = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'System'));
    if (health) {
      [['Status', health.status || 'unknown'], ['Model', health.model || '\u2014'],
       ['Memory', health.memory_mb ? health.memory_mb + ' MB' : '\u2014'], ['Crons', String(health.active_crons ?? 0)]
      ].forEach(([l, v]) => sysCard.appendChild(h('div', { class: 'kv-row' },
        h('span', { class: 'kv-label' }, l), h('span', { class: 'kv-value mono' }, v))));
    } else sysCard.appendChild(empty('Loading...'));

    const row3 = h('div', { class: 'grid-3' }, guardianCard,
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Recent Tools'), createActivityFeed(auditItems, { maxItems: 12 })),
      sysCard);

    mount(container, h('div', { class: 'page' }, statsRow, row2, row3));
  }

  render();
  poll(async () => { health = await api.get('/api/health'); render(); }, 5000);
  poll(async () => { costs = await api.get('/api/costs'); render(); }, 30000);
  poll(async () => { audit = await api.get('/api/audit'); render(); }, 5000);
  poll(async () => { guardian = await api.get('/api/guardian'); render(); }, 10000);
  poll(async () => { analytics = await api.get('/api/analytics'); render(); }, 30000);
}

export { mount_ as mount };
