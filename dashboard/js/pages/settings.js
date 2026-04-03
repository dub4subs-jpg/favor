// settings.js — View identity, model config, features, and guard limits
import { h, mount } from '../lib/dom.js';
import { api } from '../api.js';

let loaded = false;
export function unmount() { loaded = false; }

const kv = (label, value) => h('div', { class: 'kv-row' },
  h('span', { class: 'kv-label' }, label), h('span', { class: 'kv-value mono' }, value));

const fmtName = s => s.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^\w/, c => c.toUpperCase()).trim();

export function mount_(container) {
  loaded = false;
  let settings = null;

  function render() {
    if (!settings) {
      mount(container, h('div', { class: 'page' }, h('div', { class: 'chart-empty' }, loaded ? 'Could not load settings' : 'Loading...')));
      return;
    }

    const id = settings.identity || settings.bot || {};
    const idCard = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Identity'),
      ...['Name', 'Personality', 'Platform', 'Tone', 'Language'].map(f =>
        kv(f, id[f.toLowerCase()] || settings[f.toLowerCase()] || '\u2014')));

    const m = settings.models || settings.model || {};
    const modelCard = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Model Configuration'),
      kv('Primary', m.primary || m.main || m.model || '\u2014'), kv('Fallback', m.fallback || m.backup || '\u2014'),
      kv('CLI Model', m.cli || '\u2014'), kv('Max Tokens', m.maxTokens ? String(m.maxTokens) : '\u2014'));

    const feat = settings.features || settings.capabilities || {};
    const fKeys = Object.keys(feat);
    const featCard = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Features'),
      fKeys.length ? h('div', { class: 'feature-grid' }, ...fKeys.map(k => {
        const on = !!feat[k];
        return h('div', { class: 'feature-item' },
          h('span', { class: 'dot', style: { background: on ? 'var(--success)' : 'var(--surface-2)', border: on ? 'none' : '1px solid var(--text-2)' }}),
          h('span', { style: { color: on ? 'var(--text-1)' : 'var(--text-2)' }}, fmtName(k)));
      })) : h('div', { class: 'chart-empty' }, 'No features data'));

    const g = settings.guard || settings.guardian || settings.limits || {};
    const guardCard = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Guard Limits'),
      kv('Max Daily Spend', g.maxSpend != null ? '$' + g.maxSpend : '\u2014'),
      kv('Max Requests/Day', g.maxRequests != null ? String(g.maxRequests) : '\u2014'),
      kv('Max Tokens/Request', g.maxTokens != null ? String(g.maxTokens) : '\u2014'),
      kv('Rate Limit', g.rateLimit || '\u2014'));

    mount(container, h('div', { class: 'page settings-page' }, idCard, modelCard, featCard, guardCard));
  }

  render();
  api.get('/api/settings').then(r => { settings = r; loaded = true; render(); });
}

export { mount_ as mount };
