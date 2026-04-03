// tools.js — Tool audit page with stats, search, and status table
import { h, mount, $ } from '../lib/dom.js';
import { ms, relativeTime, number } from '../lib/format.js';
import { api } from '../api.js';
import { createStatCard } from '../components/stat-card.js';
import { createDataTable } from '../components/data-table.js';

let timers = [];
export function unmount() { timers.forEach(clearInterval); timers = []; }

export function mount_(container) {
  unmount();
  let audit = null, filter = '';

  function render() {
    const execs = audit?.entries || [];
    const suc = execs.filter(e => e.status === 'success').length;
    const rate = execs.length ? ((suc / execs.length) * 100).toFixed(0) + '%' : '\u2014';
    const avg = execs.length ? ms(execs.reduce((s, e) => s + (e.elapsed_ms || 0), 0) / execs.length) : '\u2014';

    const stats = h('div', { class: 'grid-3' },
      createStatCard({ label: 'Executions', value: number(execs.length), color: 'var(--accent)' }),
      createStatCard({ label: 'Success Rate', value: rate, color: rate === '100%' ? 'var(--success)' : 'var(--accent)' }),
      createStatCard({ label: 'Avg Time', value: avg, color: '#8b5cf6' }));

    const search = h('input', { type: 'text', placeholder: 'Filter by tool name...', value: filter, class: 'search-input',
      onInput: (e) => { filter = e.target.value.toLowerCase(); render(); } });

    let rows = execs.map(e => ({
      status: e.status || 'pending',
      tool: e.tool_name || e.tool || 'unknown', contact: e.contact || '\u2014',
      elapsed: e.elapsed_ms || 0, time: e.created_at || ''
    }));
    if (filter) rows = rows.filter(r => r.tool.toLowerCase().includes(filter));

    const dot = (v) => h('span', { class: 'status-cell' },
      h('span', { class: 'dot', style: { background: { success:'var(--success)', error:'var(--danger)', pending:'var(--warning)', running:'var(--accent)' }[v] || 'var(--text-2)' }}), v);

    const table = createDataTable({ rows, columns: [
      { key: 'status', label: 'Status', width: '90px', render: dot },
      { key: 'tool', label: 'Tool', render: v => h('span', { style: { fontWeight: '500' }}, v) },
      { key: 'contact', label: 'Contact' },
      { key: 'elapsed', label: 'Time', width: '80px', align: 'right', render: v => ms(v) },
      { key: 'time', label: 'When', width: '100px', align: 'right', render: v => relativeTime(v) }
    ]});

    mount(container, h('div', { class: 'page' }, stats, h('div', { style: { margin: '12px 0' }}, search), h('div', { class: 'card' }, table)));
    if (filter) { const inp = $('input', container); if (inp) { inp.value = filter; inp.focus(); inp.setSelectionRange(filter.length, filter.length); }}
  }

  render();
  const fn = async () => { audit = await api.get('/api/audit'); render(); };
  fn(); timers.push(setInterval(fn, 5000));
}

export { mount_ as mount };
