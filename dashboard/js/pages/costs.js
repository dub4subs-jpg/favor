// costs.js — Cost analytics with period toggles, trend chart, and breakdowns
import { h, mount } from '../lib/dom.js';
import { currency } from '../lib/format.js';
import { api } from '../api.js';
import { createStatCard } from '../components/stat-card.js';
import { createBarChart } from '../components/chart.js';

let timers = [];
export function unmount() { timers.forEach(clearInterval); timers = []; }

function hBar(items, color) {
  if (!items?.length) return h('div', { class: 'chart-empty' }, 'No data');
  const max = Math.max(...items.map(m => m.cost ?? m.value ?? 0), 1);
  return h('div', {}, ...items.map(m => {
    const val = m.cost ?? m.value ?? 0, pct = (val / max) * 100;
    return h('div', { style: { marginBottom: '10px' }},
      h('div', { class: 'kv-row', style: { fontSize: '12px', marginBottom: '3px' }},
        h('span', {}, m.model || m.route || m.name || 'Unknown'),
        h('span', { class: 'mono', style: { color: 'var(--text-2)' }}, currency(val))),
      h('div', { class: 'bar-track' },
        h('div', { class: 'bar-fill', style: { width: pct + '%', background: color }})));
  }));
}

export function mount_(container) {
  unmount();
  let costs = null, period = 'today';

  function render() {
    const pills = h('div', { class: 'pill-group' },
      ...['today', '7d', '30d'].map(p =>
        h('button', { class: 'pill' + (p === period ? ' pill-active' : ''),
          onClick: () => { period = p; render(); }
        }, p === 'today' ? 'Today' : p === '7d' ? '7 Days' : '30 Days')));

    const statsRow = h('div', { class: 'grid-3' },
      createStatCard({ label: 'Today', value: currency(costs?.totals?.today ?? 0), color: 'var(--accent)' }),
      createStatCard({ label: 'This Week', value: currency(costs?.totals?.week ?? 0), color: '#6366f1' }),
      createStatCard({ label: 'This Month', value: currency(costs?.totals?.month ?? 0), color: '#8b5cf6' }));

    const daily = costs?.daily_trend || [];
    const sliced = period === 'today' ? daily.slice(-1) : period === '7d' ? daily.slice(-7) : daily.slice(-30);
    const vals = sliced.map(d => d.total ?? d.cost ?? d);
    const lbls = sliced.map(d => { const l = d.label || d.date || ''; return l.length > 5 ? l.slice(-5) : l; });

    const trend = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Daily Spend'),
      vals.length ? createBarChart(vals, { height: 220, labels: lbls }) : h('div', { class: 'chart-empty' }, 'No daily data'));

    const breakdown = h('div', { class: 'grid-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Cost by Model'), hBar(costs?.today || [], 'var(--accent)')),
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Cost by Route'), hBar(costs?.by_route || [], '#8b5cf6')));

    mount(container, h('div', { class: 'page' }, pills, statsRow, trend, breakdown));
  }

  render();
  const fn = async () => { costs = await api.get('/api/costs'); render(); };
  fn(); timers.push(setInterval(fn, 30000));
}

export { mount_ as mount };
