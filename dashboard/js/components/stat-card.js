// stat-card.js — Metric card with optional delta indicator and sparkline
import { h } from '../lib/dom.js';

export function createStatCard({ label, value, delta, color, sparklineData }) {
  const vc = color || 'var(--accent)';
  let deltaEl = null;
  if (delta) {
    const pos = delta.startsWith('+'), neg = delta.startsWith('-');
    const arrow = pos ? '\u25B2' : neg ? '\u25BC' : '';
    deltaEl = h('span', { class: 'stat-delta', style: {
      color: pos ? 'var(--success)' : neg ? 'var(--danger)' : 'var(--text-2)',
      fontSize: '12px', marginLeft: '8px'
    }}, `${arrow} ${delta}`);
  }
  let spark = null;
  if (sparklineData?.length > 1) {
    const w = 64, ht = 28, p = 2;
    const min = Math.min(...sparklineData), max = Math.max(...sparklineData), rng = max - min || 1;
    const pts = sparklineData.map((v, i) =>
      `${(p + i / (sparklineData.length - 1) * (w - p * 2)).toFixed(1)},${(p + (1 - (v - min) / rng) * (ht - p * 2)).toFixed(1)}`
    ).join(' ');
    spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    spark.setAttribute('viewBox', `0 0 ${w} ${ht}`);
    spark.setAttribute('width', w); spark.setAttribute('height', ht);
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('d', `M ${p},${ht} L ${pts.replace(/ /g, ' L ')} L ${w - p},${ht} Z`);
    area.setAttribute('fill', vc); area.setAttribute('opacity', '0.15');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', pts); line.setAttribute('fill', 'none');
    line.setAttribute('stroke', vc); line.setAttribute('stroke-width', '1.5');
    spark.append(area, line);
  }
  return h('div', { class: 'stat-card' },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }},
      h('div', {},
        h('div', { style: { display: 'flex', alignItems: 'baseline' }},
          h('span', { class: 'stat-value', style: { color: vc }}, String(value ?? '0')),
          deltaEl || h('span')),
        h('div', { class: 'stat-label' }, label)),
      spark || h('span')));
}
