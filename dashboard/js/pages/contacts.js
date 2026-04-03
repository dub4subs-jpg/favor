// contacts.js — Contact profiles grid with expandable threads
import { h, mount } from '../lib/dom.js';
import { relativeTime, number } from '../lib/format.js';
import { api } from '../api.js';

let timers = [];
export function unmount() { timers.forEach(clearInterval); timers = []; }

const TC = { high: 'var(--success)', medium: 'var(--warning)', low: 'var(--danger)', operator: '#6366f1', staff: '#8b5cf6' };

export function mount_(container) {
  unmount();
  let contacts = [], expanded = null;

  function render() {
    if (!contacts?.length) {
      mount(container, h('div', { class: 'page' },
        h('div', { class: 'empty-hero' },
          h('div', { class: 'empty-icon' }, '\u25CE'),
          h('div', { class: 'empty-title' }, 'No contacts yet'),
          h('div', { class: 'empty-sub' }, 'Contacts appear when people message the bot'))));
      return;
    }

    const grid = h('div', { class: 'contact-grid' }, ...contacts.map(c => {
      const id = c.id || c.jid || c.number, isExp = expanded === id;
      const name = c.name || c.pushName || c.number || 'Unknown';
      const trust = c.trust || c.role || 'medium', tc = TC[trust.toLowerCase()] || 'var(--text-2)';
      const ls = c.lastSeen || c.lastMessage || c.updated;

      const threads = isExp ? (c.threads || c.recentMessages || []) : [];
      const threadEl = isExp ? h('div', { class: 'contact-threads' },
        threads.length ? threads.slice(0, 8).map(t => h('div', { class: 'thread-row' },
          h('span', { class: 'thread-text' }, t.text || t.content || t.message || '\u2014'),
          h('span', { class: 'thread-time' }, relativeTime(t.time || t.timestamp)))) :
        [h('div', { class: 'feed-empty' }, 'No thread data')]) : null;

      return h('div', { class: 'card contact-card', onClick: () => { expanded = isExp ? null : id; render(); }},
        h('div', { class: 'contact-header' },
          h('div', {},
            h('div', { class: 'contact-name' }, name),
            c.number && c.number !== name ? h('div', { class: 'contact-number mono' }, c.number) : null),
          h('span', { class: 'badge', style: { background: tc + '22', color: tc }}, trust)),
        h('div', { class: 'contact-stats' },
          h('span', {}, h('span', { class: 'label' }, 'Messages '), h('span', { class: 'mono val' }, number(c.messages || c.messageCount || 0))),
          ls ? h('span', {}, h('span', { class: 'label' }, 'Last seen '), h('span', { class: 'val' }, relativeTime(ls))) : null),
        threadEl);
    }));

    mount(container, h('div', { class: 'page' }, grid));
  }

  render();
  const fn = async () => { const r = await api.get('/api/contacts'); if (r) contacts = r.contacts || r || []; render(); };
  fn(); timers.push(setInterval(fn, 60000));
}

export { mount_ as mount };
