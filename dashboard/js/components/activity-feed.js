// activity-feed.js — Scrollable list of recent activity items
import { h } from '../lib/dom.js';

const SC = { success: 'var(--success)', error: 'var(--danger)', pending: 'var(--warning)', running: 'var(--accent)' };

export function createActivityFeed(items, { maxItems = 15 } = {}) {
  if (!items?.length) return h('div', { class: 'feed-empty' }, 'No recent activity');

  const rows = items.slice(0, maxItems).map((item, i) => {
    const dot = SC[item.status] || 'var(--text-2)';
    const row = h('div', { class: 'feed-item', style: { opacity: '0', transform: 'translateY(-4px)', transition: 'opacity 0.2s, transform 0.2s' }},
      h('span', { class: 'dot', style: { background: dot }}),
      h('div', { style: { flex: '1', minWidth: '0' }},
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' }},
          h('span', { class: 'mono feed-name' }, item.name || '\u2014'),
          h('span', { class: 'feed-time' }, item.elapsed || item.time || '')),
        item.detail ? h('div', { class: 'feed-detail' }, item.detail) : null));
    requestAnimationFrame(() => setTimeout(() => { row.style.opacity = '1'; row.style.transform = 'translateY(0)'; }, i * 30));
    return row;
  });

  return h('div', { class: 'activity-feed' }, ...rows);
}
