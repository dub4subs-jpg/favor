// nav.js — Sidebar navigation
import { h } from '../lib/dom.js';

export function createNav(items, { active, onNavigate, onLogout, connected = false }) {
  const logo = h('div', { class: 'logo' },
    h('span', { class: 'logo-icon' }, '\u26A1'),
    h('span', { class: 'logo-text' }, 'favor'));

  const navList = h('div', { class: 'nav-section' },
    ...items.map(item => {
      const act = item.path === active;
      return h('a', {
        href: '#' + item.path,
        class: 'nav-item' + (act ? ' active' : ''),
        onClick: (e) => { e.preventDefault(); onNavigate(item.path); }
      },
        h('span', { class: 'nav-icon' }, item.icon),
        h('span', { class: 'nav-label' }, item.label));
    }));

  const footer = h('div', { class: 'sidebar-footer' },
    h('div', { class: 'nav-item', style: { cursor: 'default', opacity: '0.7', padding: '8px 16px', fontSize: '0.75rem' }},
      h('span', { class: 'dot', style: { background: connected ? 'var(--success)' : 'var(--danger)', width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block', marginRight: '8px' }}),
      h('span', {}, connected ? 'Online' : 'Offline')),
    h('a', { href: '#', class: 'nav-item', onClick: (e) => { e.preventDefault(); onLogout(); }},
      h('span', { class: 'nav-icon' }, '\u2192'),
      h('span', { class: 'nav-label' }, 'Logout')));

  return h('nav', { class: 'sidebar' }, logo, navList, footer);
}
