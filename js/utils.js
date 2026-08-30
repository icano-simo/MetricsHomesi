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

// Regla direct-to-opportunity (compartida por calc.js y trends.js para que no se
// desincronicen). Realtors que nunca mandaron un lead y solo tienen oportunidades
// SÍ cuentan como realtors: cada oportunidad vale 1 lead Y 1 convertido (llegar
// directo a opp = lead muy caliente).
//
// Muta `byRef` agregando los registros sintéticos. DOS condiciones, ambas
// obligatorias:
//   1. El realtor no tiene NINGÚN lead real en toda la data. Esto es lo que
//      significa `leadKeys`: el set de claves construido desde state.leadsData
//      COMPLETO (no filtrado por periodo). Por eso se pasa desde afuera.
//   2. El Created Date de la oportunidad cae dentro de floorDate..cutoff del
//      periodo que se está calculando (para recentDates / "en periodo").
// Una opp sin Created Date no puede producir un lead sintético; sin lead no hay
// conversión, así que solo suma cuando hay fecha. Owner = Opportunity Owner.
//
// El registro se crea con la forma completa que usa calc.js; trends.js solo lee
// allDates/recentDates/owners y los campos extra los ignora.
export function applyOppsOnlyLeads(byRef, oppData, leadKeys, floorDate, cutoff) {
  for (const row of (oppData || [])) {
    const ref = getField(row, 'Referred By', 'referred by'); if (!ref || !String(ref).trim()) continue;
    const key = norm(ref), name = String(ref).trim();
    if (leadKeys.has(key)) continue; // tiene leads reales → intacto
    const cd = parseDate(getField(row, 'Created Date', 'created date'));
    const ownerStr = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    const branchStr = String(getField(row, 'Branch', 'branch') || '').trim();
    if (!byRef.has(key)) byRef.set(key, { name, allDates: [], recentDates: [], owners: new Map(), allOwners: new Map(), branches: new Map(), convertedCount: 0, fromOppsOnly: true });
    const rec = byRef.get(key);
    if (ownerStr) { rec.owners.set(ownerStr, (rec.owners.get(ownerStr) || 0) + 1); rec.allOwners.set(ownerStr, (rec.allOwners.get(ownerStr) || 0) + 1); }
    if (branchStr) rec.branches.set(branchStr, (rec.branches.get(branchStr) || 0) + 1);
    if (cd) {
      rec.allDates.push(cd);
      rec.convertedCount++; // 1 convertido por cada oportunidad con fecha
      if (cd >= floorDate && cd <= cutoff) rec.recentDates.push(cd);
    }
  }
}

export function normalizeLO(name) {
  const n = norm(name);
  if (state.loReferenceMap) {
    const match = state.loReferenceMap.get(n);
    if (match) return match;
  }
  return n;
}
