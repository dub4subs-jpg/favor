// chart.js — SVG charts: bar, donut, sparkline
import { h } from '../lib/dom.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, a = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
  return el;
}

// Vertical bar chart with animated bars and optional x-axis labels
export function createBarChart(data, { height = 180, colors, labels } = {}) {
  if (!data?.length) return h('div', { class: 'chart-empty' }, 'No data');
  const max = Math.max(...data, 1), n = data.length, vbW = 400, vbH = height;
  const padT = 10, padB = labels ? 24 : 8, barArea = vbH - padT - padB;
  const gap = Math.max(2, vbW / n * 0.2), barW = (vbW - gap * (n + 1)) / n;
  const defC = ['var(--accent)', '#6366f1', '#8b5cf6', '#a78bfa'];
  const s = svg('svg', { viewBox: `0 0 ${vbW} ${vbH}`, width: '100%', height, class: 'bar-chart' });
  s.style.display = 'block';

  data.forEach((val, i) => {
    const barH = (val / max) * barArea, x = gap + i * (barW + gap), y = padT + barArea - barH;
    const c = colors ? colors[i % colors.length] : defC[i % defC.length];
    const r = svg('rect', { x, y: padT + barArea, width: barW, height: 0, rx: 3, fill: c });
    r.style.transition = 'y 0.4s ease, height 0.4s ease';
    requestAnimationFrame(() => requestAnimationFrame(() => { r.setAttribute('y', y); r.setAttribute('height', barH); }));
    const t = svg('title'); t.textContent = String(val); r.appendChild(t);
    s.appendChild(r);
    if (labels?.[i]) {
      const lbl = svg('text', { x: x + barW / 2, y: vbH - 4, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--text-2)' });
      lbl.textContent = labels[i]; s.appendChild(lbl);
    }
  });
  return h('div', { class: 'chart-container' }, s);
}

// Donut chart with center total and legend
export function createDonutChart(segments, { size = 160, thickness = 20 } = {}) {
  if (!segments?.length) return h('div', { class: 'chart-empty' }, 'No data');
  const total = segments.reduce((s, g) => s + g.value, 0);
  if (!total) return h('div', { class: 'chart-empty' }, 'No data');
  const cx = size / 2, cy = size / 2, r = (size - thickness) / 2;
  const s = svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  s.appendChild(svg('circle', { cx, cy, r, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': thickness }));

  const circ = 2 * Math.PI * r;
  let offset = -circ / 4;
  segments.forEach(seg => {
    const d = (seg.value / total) * circ;
    const c = svg('circle', { cx, cy, r, fill: 'none', stroke: seg.color, 'stroke-width': thickness,
      'stroke-dasharray': `${d} ${circ - d}`, 'stroke-dashoffset': -offset });
    const t = svg('title'); t.textContent = `${seg.label}: ${seg.value}`; c.appendChild(t);
    s.appendChild(c); offset += d;
  });

  const ct = svg('text', { x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-size': 18, 'font-weight': 600, fill: 'var(--text-1)' });
  ct.textContent = total >= 1000 ? (total / 1000).toFixed(1) + 'K' : String(total);
  s.appendChild(ct);

  const legend = h('div', { class: 'donut-legend', style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '12px' }},
    ...segments.map(seg => h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }},
      h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: seg.color, display: 'inline-block' }}),
      h('span', { style: { color: 'var(--text-2)' }}, `${seg.label} ${((seg.value / total) * 100).toFixed(0)}%`)
    )));

  return h('div', { class: 'chart-container', style: { display: 'flex', flexDirection: 'column', alignItems: 'center' }}, s, legend);
}

// Tiny inline sparkline SVG
export function createSparkline(data, { width = 100, height = 30, color = 'var(--accent)' } = {}) {
  if (!data || data.length < 2) return svg('svg', { width, height });
  const p = 2, min = Math.min(...data), max = Math.max(...data), rng = max - min || 1;
  const pts = data.map((v, i) =>
    `${(p + i / (data.length - 1) * (width - p * 2)).toFixed(1)},${(p + (1 - (v - min) / rng) * (height - p * 2)).toFixed(1)}`
  );
  const s = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height });
  s.appendChild(svg('path', { d: `M ${p},${height} L ${pts.join(' L ')} L ${width - p},${height} Z`, fill: color, opacity: '0.12' }));
  s.appendChild(svg('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return s;
}
