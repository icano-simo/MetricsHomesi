import { state } from './state.js';

export function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 86400000);
  const s = String(v).trim();
  // Formato Salesforce: "M/D/YYYY, H:MM AM/PM"
  if (typeof s === 'string' && s.includes(',')) {
    const withoutComma = s.replace(',', '');
    const d = new Date(withoutComma);
    if (!isNaN(d.getTime())) return d;
  }
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) return new Date(Date.UTC(+m1[3], +m1[1] - 1, +m1[2]));
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(Date.UTC(+m2[1], +m2[2] - 1, +m2[3]));
  return null;
}

export function fmtDate(d) {
  if (!d) return '–';
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
}

export function fmtDB(d) {
  if (!d) return null;
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

export function fmtNow() {
  return new Date().toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
}

export function norm(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function getField(row, ...names) {
  for (const n of names) {
    const k = Object.keys(row).find(k => norm(k) === norm(n));
    if (k !== undefined) return row[k];
  }
  return null;
}

export function initials(name) {
  return name.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
}

export function normalizeLO(name) {
  const n = norm(name);
  if (state.loReferenceMap) {
    const match = state.loReferenceMap.get(n);
    if (match) return match;
  }
  return n;
}
