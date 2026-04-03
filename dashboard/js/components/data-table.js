// data-table.js — Sortable data table
import { h } from '../lib/dom.js';

export function createDataTable({ columns, rows, onSort } = {}) {
  let sortKey = null, sortDir = 'desc';

  function render() {
    let sorted = [...(rows || [])];
    if (sortKey) sorted.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1; if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return sortDir === 'asc' ? va - vb : vb - va;
      return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });

    const hdr = columns.map(col => h('th', {
      class: 'dt-th', style: { width: col.width || 'auto', textAlign: col.align || 'left', cursor: 'pointer' },
      onClick: () => {
        if (sortKey === col.key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = col.key; sortDir = 'desc'; }
        if (onSort) onSort(sortKey, sortDir);
        const p = table.parentElement;
        if (p) { const n = render(); p.replaceChild(n, table); table = n; }
      }
    }, col.label + (sortKey === col.key ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '')));

    let tbody;
    if (!sorted.length) {
      tbody = h('tbody', {}, h('tr', {}, h('td', { colspan: columns.length, class: 'dt-empty' }, 'No data available')));
    } else {
      tbody = h('tbody', {}, ...sorted.map(row =>
        h('tr', {}, ...columns.map(col => {
          const content = col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '\u2014');
          return h('td', { class: 'dt-td', style: { textAlign: col.align || 'left' }}, typeof content === 'string' ? content : content);
        }))
      ));
    }
    return h('table', { class: 'data-table' }, h('thead', {}, h('tr', {}, ...hdr)), tbody);
  }

  let table = render();
  return table;
}
