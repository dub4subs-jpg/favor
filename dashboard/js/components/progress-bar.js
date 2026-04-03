// progress-bar.js — Horizontal progress bar with threshold-based coloring
import { h } from '../lib/dom.js';

export function createProgressBar({ label, current, max, unit = '', thresholds } = {}) {
  const pct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const warn = thresholds?.warn ?? 60, danger = thresholds?.danger ?? 85;
  const color = pct > danger ? 'var(--danger)' : pct > warn ? 'var(--warning)' : 'var(--success)';
  const fmt = v => typeof v === 'number' ? v.toFixed(v % 1 ? 1 : 0) : v;

  const fill = h('div', { style: {
    width: '0%', height: '100%', borderRadius: '3px', background: color, transition: 'width 0.5s ease'
  }});
  requestAnimationFrame(() => { fill.style.width = pct + '%'; });

  return h('div', { class: 'progress-bar-wrap', style: { marginBottom: '12px' }},
    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '12px' }},
      h('span', { style: { color: 'var(--text-2)' }}, label),
      h('span', { class: 'mono', style: { color: 'var(--text-1)' }}, `${fmt(current)} / ${fmt(max)}${unit ? ' ' + unit : ''}`)),
    h('div', { style: { height: '6px', borderRadius: '3px', background: 'var(--surface-2)', overflow: 'hidden' }}, fill));
}
