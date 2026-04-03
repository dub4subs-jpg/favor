// format.js — Display formatters (currency, duration, relative time, etc.)

export function currency(n) {
  return n == null ? '$0.00' : '$' + Number(n).toFixed(2);
}

export function duration(seconds) {
  if (!seconds || seconds < 0) return '0s';
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m` : `${Math.floor(seconds)}s`;
}

export function relativeTime(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function number(n) {
  if (n == null) return '0';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(n);
}

export function ms(n) {
  if (n == null) return '\u2014';
  return n < 1000 ? n + 'ms' : (n / 1000).toFixed(1) + 's';
}

export function truncate(s, len = 80) {
  if (!s || s.length <= len) return s || '';
  return s.substring(0, len) + '\u2026';
}
