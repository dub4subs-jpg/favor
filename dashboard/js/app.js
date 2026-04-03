// app.js — SPA entry point: hash routing, auth gate, page lifecycle, sidebar nav
import { h, mount, $ } from './lib/dom.js';
import { api } from './api.js';
import { createNav } from './components/nav.js';

const NAV_ITEMS = [
  { icon: '\u25C9', label: 'Overview',  path: '/' },
  { icon: '\u25C6', label: 'Memory',    path: '/memory' },
  { icon: '$',      label: 'Costs',     path: '/costs' },
  { icon: '\u25CE', label: 'Contacts',  path: '/contacts' },
  { icon: '\u26A1', label: 'Tools',     path: '/tools' },
  { icon: '\u2699', label: 'Settings',  path: '/settings' }
];

const PAGE_MAP = {
  '/': './pages/overview.js', '/memory': './pages/memory.js', '/costs': './pages/costs.js',
  '/contacts': './pages/contacts.js', '/tools': './pages/tools.js', '/settings': './pages/settings.js'
};

const cache = {};
async function loadPage(path) {
  if (cache[path]) return cache[path];
  const src = PAGE_MAP[path];
  if (!src) return null;
  try { const m = await import(src); cache[path] = m; return m; }
  catch (e) { console.error('Page load failed:', path, e); return null; }
}

let currentPath = '/', currentPage = null, connected = false;
let cleanupApp = null; // stores teardown function for login/logout cycles

// Login screen
function renderLogin() {
  const root = $('#app');
  const err = h('div', { class: 'login-error' });
  const input = h('input', { type: 'password', placeholder: 'API token', class: 'login-input',
    onKeyDown: e => { if (e.key === 'Enter') submit(); }});

  async function submit() {
    const t = input.value.trim();
    if (!t) { err.textContent = 'Token required'; return; }
    err.textContent = '';
    api.setToken(t);
    const ok = await api.get('/api/health');
    if (ok) renderApp();
    else { api.clearToken(); err.textContent = 'Invalid token or server unreachable'; }
  }

  mount(root, h('div', { class: 'login-screen' },
    h('div', { class: 'login-card' },
      h('div', { class: 'login-logo' },
        h('div', { class: 'login-brand' }, 'favor'),
        h('div', { class: 'login-sub' }, 'command center')),
      h('div', { class: 'login-form' },
        input,
        h('button', { class: 'btn-primary', onClick: submit }, 'Connect'),
        err))));
  requestAnimationFrame(() => input.focus());
}

// Main app shell
function renderApp() {
  // Clean up previous app instance if any (prevents listener leaks on login/logout)
  if (cleanupApp) { cleanupApp(); cleanupApp = null; }

  const root = $('#app');
  const content = h('div', { class: 'content' });

  function renderSidebar() {
    const nav = createNav(NAV_ITEMS, {
      active: currentPath, connected,
      onNavigate: p => { window.location.hash = '#' + p; },
      onLogout: () => { if (currentPage?.unmount) currentPage.unmount(); currentPage = null; api.clearToken(); renderLogin(); }
    });
    const old = $('.sidebar', root);
    if (old) root.replaceChild(nav, old); else root.insertBefore(nav, root.firstChild);
  }

  mount(root, h('div'), content);
  renderSidebar();
  const unsubConnection = api.onConnectionChange(c => { connected = c; renderSidebar(); });

  async function navigate() {
    const hash = window.location.hash.replace(/^#/, '') || '/';
    if (hash === currentPath && currentPage) return;
    if (currentPage?.unmount) currentPage.unmount();
    currentPage = null;
    content.style.opacity = '0';
    currentPath = hash;
    renderSidebar();
    const mod = await loadPage(currentPath);
    await new Promise(r => setTimeout(r, 80));
    if (mod?.mount) { content.innerHTML = ''; mod.mount(content); currentPage = mod; }
    else mount(content, h('div', { class: 'chart-empty' }, 'Page not found'));
    content.style.opacity = '1';
  }

  window.addEventListener('hashchange', navigate);
  cleanupApp = () => { window.removeEventListener('hashchange', navigate); unsubConnection(); };
  navigate();
}

window.addEventListener('auth:logout', () => {
  if (currentPage?.unmount) currentPage.unmount();
  currentPage = null; renderLogin();
});

// Bootstrap: verify existing token or show login
if (api.hasToken()) {
  api.get('/api/health').then(r => { if (r) { connected = true; renderApp(); } else renderLogin(); });
} else renderLogin();
