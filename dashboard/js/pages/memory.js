// memory.js — Memory browser with search and category filter
import { h, mount, $ } from '../lib/dom.js';
import { relativeTime, truncate } from '../lib/format.js';
import { api } from '../api.js';

let timers = [];
export function unmount() { timers.forEach(clearInterval); timers = []; }

const CATS = ['all', 'facts', 'decisions', 'preferences', 'tasks'];
const COLORS = { facts: '#6366f1', decisions: '#8b5cf6', preferences: '#34d399', tasks: '#fbbf24' };

export function mount_(container) {
  unmount();
  let memories = [], query = '', activeCat = 'all', expanded = null, searchTimer = null;

  async function doSearch(q) {
    if (q?.trim()) {
      const r = await api.get(`/api/memory/search?q=${encodeURIComponent(q.trim())}`);
      if (r) memories = r.results || r.memories || r || [];
    }
    render();
  }

  function render() {
    const search = h('input', { type: 'text', placeholder: 'Search memories...', value: query, class: 'search-input',
      onInput: e => { query = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(query), 400); }});

    const pills = h('div', { class: 'pill-group' },
      ...CATS.map(c => h('button', { class: 'pill' + (c === activeCat ? ' pill-active' : ''),
        onClick: () => { activeCat = c; render(); }}, c)));

    let filtered = memories;
    if (activeCat !== 'all') filtered = memories.filter(m => (m.category || m.type || '').toLowerCase().startsWith(activeCat.slice(0, -1)));

    let grid;
    if (!filtered.length) {
      grid = h('div', { class: 'chart-empty' }, memories.length ? 'No memories in this category' : 'No memories stored');
    } else {
      grid = h('div', { class: 'memory-grid' }, ...filtered.map(mem => {
        const id = mem.id || mem.key || mem.content, isExp = expanded === id;
        const cat = mem.category || mem.type || 'general', cc = COLORS[cat.toLowerCase()] || 'var(--text-2)';
        const txt = mem.content || mem.text || mem.value || '';
        return h('div', { class: 'card memory-card', onClick: () => { expanded = isExp ? null : id; render(); }},
          h('div', { class: 'badge', style: { background: cc + '22', color: cc }}, cat),
          h('div', { class: 'memory-text' }, isExp ? txt : truncate(txt, 120)),
          h('div', { class: 'memory-date' }, relativeTime(mem.date || mem.created || mem.timestamp)));
      }));
    }

    mount(container, h('div', { class: 'page' }, search, pills, grid));
    if (query) { const inp = $('input', container); if (inp) { inp.value = query; inp.focus(); inp.setSelectionRange(query.length, query.length); }}
  }

  render();
  const fn = async () => { const r = await api.get('/api/memories'); if (r) memories = r.memories || r || []; render(); };
  fn(); timers.push(setInterval(fn, 60000));
}

export { mount_ as mount };
