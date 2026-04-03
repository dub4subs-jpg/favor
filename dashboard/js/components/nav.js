// nav.js — Sidebar navigation
import { h } from '../lib/dom.js';

export function createNav(items, { active, onNavigate, onLogout, connected = false }) {
  const logo = h('div', { class: 'nav-logo' },
    h('div', { class: 'nav-brand' }, 'favor'),
    h('div', { class: 'nav-subtitle' }, 'command center'));

  const navList = h('div', { class: 'nav-list' },
    ...items.map(item => {
      const act = item.path === active;
      return h('a', {
        href: '#' + item.path,
        class: 'nav-item' + (act ? ' nav-item-active' : ''),
        onClick: (e) => { e.preventDefault(); onNavigate(item.path); }
      },
        h('span', { class: 'nav-icon' }, item.icon),
        h('span', {}, item.label));
    }));

  const footer = h('div', { class: 'nav-footer' },
    h('div', { class: 'conn-status' },
      h('span', { class: 'dot', style: { background: connected ? 'var(--success)' : 'var(--danger)' }}),
      h('span', {}, connected ? 'Connected' : 'Disconnected')),
    h('button', { class: 'btn-logout', onClick: onLogout }, 'Logout'));

  return h('nav', { class: 'sidebar' }, logo, navList, footer);
}
