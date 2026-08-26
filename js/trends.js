import { state } from './state.js';
import { norm, parseDate, fmtDate, getField } from './utils.js';
import { visibleOwners } from './visibility.js';

function getAllowedOwners() {
  // Display-only: se limita a los BDs visibles del usuario (no cambia el cálculo).
  return visibleOwners(document.getElementById('owners-list').value
    .split(',')
    .map(s => s.trim().replace(/^["']+|["']+$/g, '').trim())
    .filter(s => s !== ''));
}

// Current Window: derived from state.activeResults — guaranteed exact match with Metrics tab
function calcFromActiveResults(allowedOwners) {
  const result = new Map(allowedOwners.map(o => [o, { hunting: 0, farming: 0 }]));
  for (const r of (state.activeResults || [])) {
    const bdData = result.get(r.assignedOwner);
    if (!bdData) continue;
    if (r.med && r.med.startsWith('Hunting')) bdData.hunting++;
    else bdData.farming++;
  }
  return result;
}

// Comparison Windows: replicates _runCalc classification logic exactly
// - checks state.masterMap for manual assignments (same as calc.js line 118)
// - falls back to oppOwnerMap (same as calc.js line 122)
// - includes c4 (Hunting Rescued) in Hunting bucket (same as med.startsWith('Hunting'))
function calcHistoricalWindow(floorDate, cutoffDate, allowedOwners) {
  const allowedNorm = new Map(allowedOwners.map(o => [norm(o), o]));
  const reactDays = parseInt((document.getElementById('react-days') || {}).value) || 150;
  const reactThreshold = new Date(cutoffDate);
  reactThreshold.setUTCDate(reactThreshold.getUTCDate() - reactDays);

  const oppOwnerMap = new Map();
  for (const row of (state.oppData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (!ref || !String(ref).trim()) continue;
    const oppOwner = getField(row, 'Opportunity Owner', 'opportunity owner');
    if (oppOwner) oppOwnerMap.set(norm(ref), String(oppOwner).trim());
  }

  const byRef = new Map();
  for (const row of (state.leadsData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (!ref || !String(ref).trim()) continue;
    const key = norm(ref);
    const cd = parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'));
    const ownerStr = String(getField(row, 'Lead Owner', 'lead owner', 'owner') || '').trim();
    if (!byRef.has(key)) byRef.set(key, { allDates: [], recentDates: [], owners: new Map() });
    const rec = byRef.get(key);
    if (cd) {
      rec.allDates.push(cd);
      if (cd >= floorDate && cd <= cutoffDate) {
        rec.recentDates.push(cd);
        if (ownerStr) rec.owners.set(ownerStr, (rec.owners.get(ownerStr) || 0) + 1);
      }
    }
  }

  const result = new Map(allowedOwners.map(o => [o, { hunting: 0, farming: 0 }]));

  for (const [key, rec] of byRef.entries()) {
    if (!rec.recentDates.length) continue;

    const allSorted = [...rec.allDates].sort((a, b) => a - b);
    const uniqueDays = [], seen = new Set();
    for (const d of allSorted) {
      const k = d.toISOString().slice(0, 10);
      if (!seen.has(k)) { seen.add(k); uniqueDays.push(d); }
    }
    const firstDate = uniqueDays[0] || null;
    const penult = uniqueDays.length >= 2 ? uniqueDays[uniqueDays.length - 2] : null;
    const c2 = firstDate ? firstDate >= floorDate : false;
    const c4 = penult ? penult <= reactThreshold : false;

    let assignedOwner = '';
    const me = state.masterMap.get(key);
    if (me && me.owner && me.source === 'manual') {
      assignedOwner = me.owner;
    } else {
      if (rec.owners.size > 0) {
        let best = '', bestN = -1;
        for (const [o, n] of rec.owners.entries()) {
          const c = allowedNorm.get(norm(o));
          if (c && n > bestN) { bestN = n; best = c; }
        }
        if (bestN > -1) assignedOwner = best;
      }
      if (!assignedOwner && oppOwnerMap.has(key)) {
        const c = allowedNorm.get(norm(oppOwnerMap.get(key)));
        if (c) assignedOwner = c;
      }
    }
    if (!assignedOwner) continue;

    const bdData = result.get(assignedOwner);
    if (!bdData) continue;

    if (c2 || c4) bdData.hunting++;
    else bdData.farming++;
  }

  return result;
}

// Average of values where v >= 1 (only BDs with at least 1 realtor in that column)
function colAvg(vals) {
  const active = vals.filter(v => v >= 1);
  return active.length ? active.reduce((s, v) => s + v, 0) / active.length : 0;
}

// Indicator arrow for a BD value vs. column average
function ind(v, avg) {
  if (avg === null) return '';
  if (v > avg + 1) return '<span style="color:#1A7A50;font-size:9px;font-weight:800;vertical-align:middle;margin-left:3px">▲</span>';
  if (v < avg - 1) return '<span style="color:#B83030;font-size:9px;font-weight:800;vertical-align:middle;margin-left:3px">▼</span>';
  return '';
}

function trendCell(current, compare) {
  if (compare === null) return '<td style="text-align:center;color:#8899BB">—</td>';
  const diff = current - compare;
  if (current === 0 && compare === 0) return '<td style="text-align:center;color:#CCD5E0">—</td>';
  if (current === 0 && compare > 0) return '<td style="text-align:center"><span style="color:#A32D2D;font-weight:700;font-size:11px">⬤ 0</span></td>';
  if (diff > 0) return '<td style="text-align:center"><span style="color:#085041;font-weight:700;font-size:11px">▲ +' + diff + '</span></td>';
  if (diff < 0) return '<td style="text-align:center"><span style="color:#A32D2D;font-weight:700;font-size:11px">▼ ' + diff + '</span></td>';
  return '<td style="text-align:center;color:#8899BB;font-weight:600">↔</td>';
}

function trendCellDark(current, compare) {
  const bg = 'background:var(--hs-navy);';
  if (compare === null) return '<td style="' + bg + 'text-align:center;color:rgba(255,255,255,.35)">—</td>';
  const diff = current - compare;
  if (current === 0 && compare === 0) return '<td style="' + bg + 'text-align:center;color:rgba(255,255,255,.3)">—</td>';
  if (current === 0 && compare > 0) return '<td style="' + bg + 'text-align:center"><span style="color:#FF8080;font-weight:700;font-size:11px">⬤ 0</span></td>';
  if (diff > 0) return '<td style="' + bg + 'text-align:center"><span style="color:#4DE0B0;font-weight:700;font-size:11px">▲ +' + diff + '</span></td>';
  if (diff < 0) return '<td style="' + bg + 'text-align:center"><span style="color:#FF8080;font-weight:700;font-size:11px">▼ ' + diff + '</span></td>';
  return '<td style="' + bg + 'text-align:center;color:rgba(255,255,255,.5);font-weight:600">↔</td>';
}

export function renderTrends() {
  const container = document.getElementById('trends-table-wrap');
  if (!container) return;

  if (!state.leadsData || !state.leadsData.length) {
    container.innerHTML = '<div class="empty-state">Run calculation first to view trends</div>';
    return;
  }

  const allowedOwners = getAllowedOwners();
  if (!allowedOwners.length) {
    container.innerHTML = '<div class="empty-state">No Business Developers configured in Settings → Group Owners</div>';
    return;
  }

  // Current window label — same params as calc.js (no hour reset, matches calc.js floor)
  const cutoffStr = document.getElementById('cutoff-date').value;
  const windowDays = parseInt(document.getElementById('window-days').value) || 60;
  const curCutoff = new Date(cutoffStr + 'T23:59:59Z');
  const curFloor = new Date(curCutoff);
  curFloor.setUTCDate(curFloor.getUTCDate() - windowDays);
  const curLabel = document.getElementById('trends-cur-label');
  if (curLabel) curLabel.textContent = fmtDate(curFloor) + ' – ' + fmtDate(curCutoff) + ' (' + windowDays + 'd)';

  // Comparison 1
  const c1CutoffStr = (document.getElementById('trends-c1-cutoff') || {}).value || '';
  const c1FloorStr = (document.getElementById('trends-c1-floor') || {}).value || '';
  const c1Active = !!(c1CutoffStr && c1FloorStr);
  const c1Cutoff = c1Active ? new Date(c1CutoffStr + 'T23:59:59Z') : null;
  const c1Floor = c1Active ? new Date(c1FloorStr + 'T00:00:00Z') : null;
  const c1Days = c1Active ? Math.round((c1Cutoff - c1Floor) / 86400000) : null;
  const c1Label = document.getElementById('trends-c1-label');
  if (c1Label) c1Label.textContent = c1Active ? fmtDate(c1Floor) + ' – ' + fmtDate(c1Cutoff) + ' (' + c1Days + 'd)' : '—';

  // Comparison 2
  const c2CutoffStr = (document.getElementById('trends-c2-cutoff') || {}).value || '';
  const c2FloorStr = (document.getElementById('trends-c2-floor') || {}).value || '';
  const c2Active = !!(c2CutoffStr && c2FloorStr);
  const c2Cutoff = c2Active ? new Date(c2CutoffStr + 'T23:59:59Z') : null;
  const c2Floor = c2Active ? new Date(c2FloorStr + 'T00:00:00Z') : null;
  const c2Days = c2Active ? Math.round((c2Cutoff - c2Floor) / 86400000) : null;
  const c2Label = document.getElementById('trends-c2-label');
  if (c2Label) c2Label.textContent = c2Active ? fmtDate(c2Floor) + ' – ' + fmtDate(c2Cutoff) + ' (' + c2Days + 'd)' : '—';

  // Calculate windows
  const curData = calcFromActiveResults(allowedOwners);
  const c1Data = c1Active ? calcHistoricalWindow(c1Floor, c1Cutoff, allowedOwners) : null;
  const c2Data = c2Active ? calcHistoricalWindow(c2Floor, c2Cutoff, allowedOwners) : null;

  // AJUSTE 3: dynamic trend header text
  const trendHeader = c2Active ? 'Trend (vs C2)' : c1Active ? 'Trend (vs C1)' : 'Trend';

  const rows = allowedOwners.map(bd => ({
    bd,
    cur: curData.get(bd) || { hunting: 0, farming: 0 },
    c1: c1Data ? (c1Data.get(bd) || { hunting: 0, farming: 0 }) : null,
    c2: c2Data ? (c2Data.get(bd) || { hunting: 0, farming: 0 }) : null
  })).sort((a, b) => b.cur.hunting - a.cur.hunting);

  // Totals
  const totCurH = rows.reduce((s, r) => s + r.cur.hunting, 0);
  const totCurF = rows.reduce((s, r) => s + r.cur.farming, 0);
  const totC1H = c1Data ? rows.reduce((s, r) => s + (r.c1 ? r.c1.hunting : 0), 0) : null;
  const totC1F = c1Data ? rows.reduce((s, r) => s + (r.c1 ? r.c1.farming : 0), 0) : null;
  const totC2H = c2Data ? rows.reduce((s, r) => s + (r.c2 ? r.c2.hunting : 0), 0) : null;
  const totC2F = c2Data ? rows.reduce((s, r) => s + (r.c2 ? r.c2.farming : 0), 0) : null;
  const totTH = c2Data ? totC2H : c1Data ? totC1H : null;
  const totTF = c2Data ? totC2F : c1Data ? totC1F : null;

  // Column averages — only over BDs with >= 1 realtor in that column
  const avgHCur = colAvg(rows.map(r => r.cur.hunting));
  const avgFCur = colAvg(rows.map(r => r.cur.farming));
  const avgHC1 = c1Active ? colAvg(rows.map(r => r.c1 ? r.c1.hunting : 0)) : null;
  const avgFC1 = c1Active ? colAvg(rows.map(r => r.c1 ? r.c1.farming : 0)) : null;
  const avgHC2 = c2Active ? colAvg(rows.map(r => r.c2 ? r.c2.hunting : 0)) : null;
  const avgFC2 = c2Active ? colAvg(rows.map(r => r.c2 ? r.c2.farming : 0)) : null;

  const fmtAvg = v => v === null ? '—' : (v % 1 === 0 ? String(v) : v.toFixed(1));

  // Header styles
  const hBg = 'var(--hs-red)', fBg = 'var(--hs-navy)', navyBg = 'var(--hs-navy)';
  // AJUSTE 2: Current header cells use slightly darker shade + bottom accent border
  const hBgCur = '#D93030', fBgCur = 'var(--hs-navy-light)';
  const thBase = 'font-family:\'Barlow\',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:white;text-align:center;padding:7px 10px;';
  const th = (txt, bg) => '<th style="' + thBase + 'background:' + bg + ';opacity:.9">' + txt + '</th>';
  const thCur = (txt, bg) => '<th style="' + thBase + 'background:' + bg + ';border-bottom:3px solid rgba(255,255,255,.55)">' + txt + '</th>';

  // AJUSTE 1: no emojis in section headers
  const head =
    '<tr>' +
      '<th rowspan="2" style="' + thBase + 'background:' + navyBg + ';text-align:left;padding:7px 14px">Business Developer</th>' +
      '<th colspan="4" style="' + thBase + 'background:' + hBg + ';font-size:11px;opacity:1">Hunting — New Realtors</th>' +
      '<th colspan="4" style="' + thBase + 'background:' + fBg + ';font-size:11px;opacity:1">Farming — Existing Realtors</th>' +
    '</tr>' +
    '<tr>' +
      thCur('Current', hBgCur) + th('Comp. 1', hBg) + th('Comp. 2', hBg) + th(trendHeader, hBg) +
      thCur('Current', fBgCur) + th('Comp. 1', fBg) + th('Comp. 2', fBg) + th(trendHeader, fBg) +
    '</tr>';

  // Team Average row — shown first in tbody, before BD rows
  const aBase = 'font-size:11px;color:#667799;font-style:italic;font-weight:600;text-align:center;padding:5px 8px;background:#EEF1F6;border-top:1px solid #D8DCE8;border-bottom:2px solid #D0D5E2;';
  const aBaseH = 'font-size:11px;color:#667799;font-style:italic;font-weight:600;text-align:center;padding:5px 8px;background:rgba(255,64,64,0.05);border-top:1px solid #D8DCE8;border-bottom:2px solid #D0D5E2;';
  const aBaseF = 'font-size:11px;color:#667799;font-style:italic;font-weight:600;text-align:center;padding:5px 8px;background:rgba(8,80,65,0.05);border-top:1px solid #D8DCE8;border-bottom:2px solid #D0D5E2;';
  const aLbl = 'font-size:11px;color:#667799;font-style:italic;font-weight:700;padding:5px 14px;background:#EEF1F6;border-top:1px solid #D8DCE8;border-bottom:2px solid #D0D5E2;';

  const avgRow =
    '<tr>' +
      '<td style="' + aLbl + '">Team Avg</td>' +
      '<td style="' + aBaseH + '">' + fmtAvg(avgHCur) + '</td>' +
      '<td style="' + aBase + '">' + (c1Active ? fmtAvg(avgHC1) : '—') + '</td>' +
      '<td style="' + aBase + '">' + (c2Active ? fmtAvg(avgHC2) : '—') + '</td>' +
      '<td style="' + aBase + '"></td>' +
      '<td style="' + aBaseF + '">' + fmtAvg(avgFCur) + '</td>' +
      '<td style="' + aBase + '">' + (c1Active ? fmtAvg(avgFC1) : '—') + '</td>' +
      '<td style="' + aBase + '">' + (c2Active ? fmtAvg(avgFC2) : '—') + '</td>' +
      '<td style="' + aBase + '"></td>' +
    '</tr>';

  // Cell renderers with per-BD vs. column-average indicators
  const tdCurH = (v, avg) => '<td style="text-align:center;font-weight:700;font-size:14px;color:var(--hs-navy);background:rgba(255,64,64,0.07)">' + v + ind(v, avg) + '</td>';
  const tdCurF = (v, avg) => '<td style="text-align:center;font-weight:700;font-size:14px;color:var(--hs-navy);background:rgba(8,80,65,0.07)">' + v + ind(v, avg) + '</td>';
  const tdN = (v, active, avg) => active
    ? '<td style="text-align:center;font-weight:600;color:#334466">' + v + ind(v, avg) + '</td>'
    : '<td style="text-align:center;color:#CCD5E0">—</td>';

  const bodyRows = rows.map(r => {
    const tBaseH = r.c2 ? r.c2.hunting : r.c1 ? r.c1.hunting : null;
    const tBaseF = r.c2 ? r.c2.farming : r.c1 ? r.c1.farming : null;
    return '<tr>' +
      '<td style="font-weight:600;padding:8px 14px;font-size:12px;color:var(--hs-navy)">' + r.bd + '</td>' +
      tdCurH(r.cur.hunting, avgHCur) +
      tdN(r.c1 ? r.c1.hunting : 0, c1Active, avgHC1) +
      tdN(r.c2 ? r.c2.hunting : 0, c2Active, avgHC2) +
      trendCell(r.cur.hunting, tBaseH) +
      tdCurF(r.cur.farming, avgFCur) +
      tdN(r.c1 ? r.c1.farming : 0, c1Active, avgFC1) +
      tdN(r.c2 ? r.c2.farming : 0, c2Active, avgFC2) +
      trendCell(r.cur.farming, tBaseF) +
      '</tr>';
  }).join('');

  const tS = 'background:var(--hs-navy);color:white;font-weight:700;font-size:11px;text-align:center;padding:8px 10px;font-family:\'Barlow\',sans-serif';
  const tL = 'background:var(--hs-navy);color:white;font-weight:700;font-size:11px;padding:8px 14px;font-family:\'Barlow\',sans-serif;text-transform:uppercase;letter-spacing:.4px';
  const tDim = (v, isNull) => '<td style="' + tS + (isNull ? ';color:rgba(255,255,255,.35)' : '') + '">' + (isNull ? '—' : v) + '</td>';

  const totRow = '<tr>' +
    '<td style="' + tL + '">Team Total</td>' +
    '<td style="' + tS + '">' + totCurH + '</td>' +
    tDim(totC1H, totC1H === null) +
    tDim(totC2H, totC2H === null) +
    trendCellDark(totCurH, totTH) +
    '<td style="' + tS + '">' + totCurF + '</td>' +
    tDim(totC1F, totC1F === null) +
    tDim(totC2F, totC2F === null) +
    trendCellDark(totCurF, totTF) +
    '</tr>';

  container.innerHTML =
    '<div class="twrap">' +
      '<table class="modal-table trends-table">' +
        '<thead>' + head + '</thead>' +
        '<tbody>' + avgRow + bodyRows + totRow + '</tbody>' +
      '</table>' +
    '</div>';
}

export function initTrends() {
  renderTrends();
}
