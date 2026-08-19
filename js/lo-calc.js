import { state } from './state.js';
import { bus } from './events.js';
import { norm, parseDate, fmtNow, normalizeLO } from './utils.js';
import { loadDataFromSupabase } from './supabase.js';

export async function runLoCalc() {
  const btn = document.getElementById('lo-run-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Calculating...'; }
  try {
    await _runLoCalc();
  } catch (e) {
    bus.emit('status', { type: 'err', msg: '❌ LO Calculation error: ' + e.message });
    console.error('runLoCalc error:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-player-play"></i> Calculate LO Metrics'; }
  }
}

async function _runLoCalc() {
  if (!state.leadsData || !state.oppData) {
    try {
      bus.emit('status', { type: 'load', msg: '⏳ Loading data from Supabase...' });
      const { leadsData, oppData } = await loadDataFromSupabase({
        onStatus: (t, m) => bus.emit('status', { type: t, msg: m })
      });
      state.leadsData = leadsData;
      state.oppData = oppData;
      if (!state.leadsData || !state.leadsData.length) {
        bus.emit('status', { type: 'err', msg: '❌ No lead data found. Upload Leads first.' });
        return;
      }
    } catch (e) {
      bus.emit('status', { type: 'err', msg: '❌ Error loading data: ' + e.message });
      return;
    }
  }

  bus.emit('status', { type: 'load', msg: '⏳ Processing LO metrics from ' + state.leadsData.length + ' leads...' });

  const cutoffStr = document.getElementById('lo-cutoff-date').value;
  const windowDays = parseInt(document.getElementById('lo-window-days').value) || 60;
  const reactDays = parseInt(document.getElementById('lo-react-days').value) || 150;
  const inactFromStr = document.getElementById('lo-inactive-from').value;

  const rawLoList = document.getElementById('lo-list').value;
  const allowedLOs = rawLoList.split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== '');

  const cutoff = new Date(cutoffStr + 'T23:59:59Z');
  const floorDate = new Date(cutoff); floorDate.setUTCDate(floorDate.getUTCDate() - windowDays);
  const reactThreshold = new Date(cutoff); reactThreshold.setUTCDate(reactThreshold.getUTCDate() - reactDays);
  const inactFloor = inactFromStr ? new Date(inactFromStr + 'T00:00:00Z') : new Date('2024-01-01');

  // Build map of realtor → LO data (keyed by Referred By norm)
  const byRef = new Map();
  const leadRowsMap = new Map();

  // Pre-index lead column names once (evita el Object.keys().find() de getField por fila)
  const leadFirstRow = (state.leadsData && state.leadsData[0]) || {};
  const refByField = Object.keys(leadFirstRow).find(k => norm(k) === 'referred by') || 'Referred By';
  const createdField = Object.keys(leadFirstRow).find(k => norm(k) === 'created date' || norm(k) === 'create date') || 'Created Date';
  const loField = Object.keys(leadFirstRow).find(k => norm(k) === 'loan officer') || 'Loan Officer';
  const branchField = Object.keys(leadFirstRow).find(k => norm(k) === 'branch') || 'Branch';
  const convertedField = Object.keys(leadFirstRow).find(k => norm(k) === 'converted') || 'Converted';

  // Cache de normalizeLO: pocos LOs únicos pero decenas de miles de filas
  const loNormCache = new Map();
  const getNormLO = (raw) => {
    if (!raw) return '';
    if (loNormCache.has(raw)) return loNormCache.get(raw);
    const result = normalizeLO(raw);
    loNormCache.set(raw, result);
    return result;
  };

  for (const row of (state.leadsData || [])) {
    const ref = row[refByField];
    if (!ref || !String(ref).trim()) continue;
    const key = norm(ref), name = String(ref).trim();
    const cd = parseDate(row[createdField]);
    const loRaw = String(row[loField] || '').trim();
    const loStr = loRaw ? getNormLO(loRaw) : '';
    const branchStr = String(row[branchField] || '').trim();

    if (!byRef.has(key)) byRef.set(key, { name, allDates: [], recentDates: [], los: new Map(), allLos: new Map(), branches: new Map(), lastBranch: '', lastBranchDate: null, convertedCount: 0 });
    const rec = byRef.get(key);
    if (cd) {
      rec.allDates.push(cd);
      if (loStr) rec.allLos.set(loStr, (rec.allLos.get(loStr) || 0) + 1);
      if (branchStr && (!rec.lastBranchDate || cd > rec.lastBranchDate ||
          (cd.getTime() === rec.lastBranchDate.getTime() && branchStr < rec.lastBranch))) {
        rec.lastBranch = branchStr; rec.lastBranchDate = cd;
      }
      if (cd >= floorDate && cd <= cutoff) {
        rec.recentDates.push(cd);
        const conv = row[convertedField];
        if (conv === true || String(conv).trim().toLowerCase() === 'true') rec.convertedCount++;
        if (loStr) rec.los.set(loStr, (rec.los.get(loStr) || 0) + 1);
        if (branchStr) rec.branches.set(branchStr, (rec.branches.get(branchStr) || 0) + 1);
        if (!leadRowsMap.has(key)) leadRowsMap.set(key, []);
        leadRowsMap.get(key).push(row);
      }
    }
  }

  // Discover all LOs if lo-list is empty
  let allowedNorm;
  if (!allowedLOs.length) {
    const found = new Set();
    for (const rec of byRef.values()) {
      for (const lo of rec.allLos.keys()) found.add(lo);
    }
    const discovered = [...found].sort();
    allowedNorm = new Map(discovered.map(lo => [norm(lo), lo]));
  } else {
    allowedNorm = new Map(allowedLOs.map(lo => [norm(lo), lo]));
  }

  // Opp-level LO map (realtor → best LO from opps, for fallback)
  const oppLoMap = new Map();
  const cwMap = new Map(), ratMap = new Map(), paMap = new Map();
  const curCwMap = new Map(), curRatMap = new Map(), curPaMap = new Map();
  const oppRowsMap = new Map();

  // Pre-index opp column names once
  const oppFirstRow = (state.oppData && state.oppData[0]) || {};
  const oppRefField = Object.keys(oppFirstRow).find(k => norm(k) === 'referred by') || 'Referred By';
  const oppLoField = Object.keys(oppFirstRow).find(k => norm(k) === 'loan officers' || norm(k) === 'loan officer') || 'Loan Officers';
  const oppStageField = Object.keys(oppFirstRow).find(k => norm(k) === 'stage') || 'Stage';
  const oppDisbField = Object.keys(oppFirstRow).find(k => norm(k) === 'disbursement date') || 'Disbursement Date';
  const oppPaField = Object.keys(oppFirstRow).find(k => norm(k) === 'pre-approved date') || 'Pre-Approved Date';
  const oppRatField = Object.keys(oppFirstRow).find(k => norm(k) === 'ratified date') || 'Ratified Date';

  for (const row of (state.oppData || [])) {
    const ref = row[oppRefField];
    if (!ref || !String(ref).trim()) continue;
    const key = norm(ref);
    const loRaw = String(row[oppLoField] || '').trim();
    if (loRaw) oppLoMap.set(key, getNormLO(loRaw));

    const stage = String(row[oppStageField] || '').trim().toLowerCase();
    const disbDate = parseDate(row[oppDisbField]);
    const paDate = parseDate(row[oppPaField]);
    const ratDate = parseDate(row[oppRatField]);

    if (!oppRowsMap.has(key)) oppRowsMap.set(key, []);
    oppRowsMap.get(key).push(row);

    if (stage !== 'closed lost') {
      if (stage === 'closed won' && disbDate && disbDate >= floorDate && disbDate <= cutoff) cwMap.set(key, (cwMap.get(key) || 0) + 1);
    }
    if (paDate && paDate >= floorDate && paDate <= cutoff) paMap.set(key, (paMap.get(key) || 0) + 1);
    if (ratDate && ratDate >= floorDate && ratDate <= cutoff) ratMap.set(key, (ratMap.get(key) || 0) + 1);
    if (stage === 'closed lost') continue;
    const isCW = stage === 'closed won' && disbDate && disbDate >= floorDate && disbDate <= cutoff;
    const isRat = !isCW && ratDate && ratDate >= floorDate && ratDate <= cutoff;
    const isPA = !isCW && !isRat && paDate && paDate >= floorDate && paDate <= cutoff;
    if (isCW) curCwMap.set(key, (curCwMap.get(key) || 0) + 1);
    else if (isRat) curRatMap.set(key, (curRatMap.get(key) || 0) + 1);
    else if (isPA) curPaMap.set(key, (curPaMap.get(key) || 0) + 1);
  }

  state.loActiveResults = [];
  state.loInactiveResults = [];
  state.loUnassignedResults = [];

  for (const [key, rec] of byRef.entries()) {
    const allSorted = [...rec.allDates].sort((a, b) => a - b);
    const uniqueDays = [], seen = new Set();
    for (const d of allSorted) { const k = d.toISOString().slice(0, 10); if (!seen.has(k)) { seen.add(k); uniqueDays.push(d); } }
    const firstDate = uniqueDays[0] || null, lastDate = uniqueDays[uniqueDays.length - 1] || null;
    const penult = uniqueDays.length >= 2 ? uniqueDays[uniqueDays.length - 2] : null;
    const cnt = rec.recentDates.length, isActive = cnt > 0;
    const hasLeadSince = rec.allDates.some(d => d >= inactFloor);
    const isInactive = !isActive && lastDate && lastDate < floorDate && hasLeadSince;
    if (!isActive && !isInactive) continue;

    // Determine assigned LO
    let assignedOwner = '', assignedBranch = '', ownerSource = 'auto', confirmed = false;
    const me = state.loMasterMap.get(key);
    if (me && me.loan_officer && me.source === 'manual') {
      assignedOwner = me.loan_officer; assignedBranch = me.branch || ''; ownerSource = 'manual'; confirmed = me.confirmed || false;
    } else {
      if (rec.los.size > 0) {
        let best = '', bestN = -1;
        for (const [lo, n] of rec.los.entries()) {
          const canonical = allowedNorm.get(norm(lo));
          if (canonical && n > bestN) { bestN = n; best = canonical; }
        }
        if (bestN > -1) assignedOwner = best;
      }
      if (!assignedOwner && oppLoMap.has(key)) {
        const canonical = allowedNorm.get(norm(oppLoMap.get(key)));
        if (canonical) assignedOwner = canonical;
      }
      if (rec.branches.size > 0) {
        let best = '', bestN = -1;
        for (const [b, n] of rec.branches.entries()) {
          if (n > bestN || (n === bestN && b < best)) { bestN = n; best = b; }
        }
        assignedBranch = best;
      } else if (rec.lastBranch) {
        assignedBranch = rec.lastBranch;
      }
    }

    if (!assignedOwner || assignedOwner.trim() === '') {
      const losMap = rec.los.size > 0 ? rec.los : rec.allLos;
      state.loUnassignedResults.push({
        key, name: rec.name, isActive, firstDate, lastDate,
        allTimeCount: rec.allDates.length,
        leadOwnersSeen: [...losMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([lo, n]) => lo + ' (' + n + ')')
      });
      continue;
    }

    const cw = cwMap.get(key) || 0, pa = paMap.get(key) || 0, rat = ratMap.get(key) || 0;

    if (isActive) {
      const c1 = true;
      const c2 = firstDate ? firstDate >= floorDate : false;
      const c3 = firstDate ? firstDate < floorDate : false;
      const c4 = penult ? penult <= reactThreshold : false;
      const c5 = cw > 0, c6 = pa > 0, c7 = rat > 0;
      let med;
      if      (c1 && c2 && c5)  med = 'Hunting New - Closing';
      else if (c1 && c2 && c7)  med = 'Hunting New - Ratified';
      else if (c1 && c2 && c6)  med = 'Hunting New - Pre Approval';
      else if (c1 && c2)        med = 'Hunting New';
      else if (c1 && c4 && c5)  med = 'Hunting Rescued - Closing';
      else if (c1 && c4 && c7)  med = 'Hunting Rescued - Ratified';
      else if (c1 && c4 && c6)  med = 'Hunting Rescued - Pre Approval';
      else if (c1 && c4)        med = 'Hunting Rescued';
      else if (c1 && c3 && c5)  med = 'Farming Closing';
      else if (c1 && c3 && c7)  med = 'Farming Ratified';
      else if (c1 && c3 && c6)  med = 'Farming Pre Approval';
      else if (c1 && c3)        med = 'Farming Lead';
      else                      med = 'Sin medición';
      const curCw = curCwMap.get(key) || 0, curRat = curRatMap.get(key) || 0, curPa = curPaMap.get(key) || 0;
      state.loActiveResults.push({ key, name: rec.name, cnt, convertedCount: rec.convertedCount, firstDate, penult, lastDate, c1, c2, c3, c4, cw, pa, rat, curCw, curRat, curPa, med, assignedOwner, assignedBranch, ownerSource, confirmed, leadRows: leadRowsMap.get(key) || [], oppRows: oppRowsMap.get(key) || [] });
    } else {
      const curCw2 = curCwMap.get(key) || 0, curRat2 = curRatMap.get(key) || 0, curPa2 = curPaMap.get(key) || 0;
      state.loInactiveResults.push({ key, name: rec.name, cnt: rec.recentDates.length || rec.allDates.length, convertedCount: rec.convertedCount, firstDate, penult, lastDate, cw, pa, rat, curCw: curCw2, curRat: curRat2, curPa: curPa2, med: 'Inactive', assignedOwner, assignedBranch, ownerSource, confirmed, daysSinceLast: lastDate ? Math.floor((cutoff - lastDate) / 86400000) : null, leadRows: leadRowsMap.get(key) || [], oppRows: oppRowsMap.get(key) || [] });
    }

    const existing = state.loMasterMap.get(key);
    if (!existing || existing.source === 'auto') {
      state.loMasterMap.set(key, { name: rec.name, loan_officer: assignedOwner, branch: assignedBranch, source: 'auto', updatedAt: fmtNow(), confirmed: false });
    }
  }

  state.loCurrentMode = document.getElementById('lo-mode-selector').value;

  const uBadge = document.getElementById('lo-unassigned-count-badge');
  if (uBadge) uBadge.textContent = state.loUnassignedResults.length;

  const effectiveLOs = allowedLOs.length ? allowedLOs : [...allowedNorm.values()];
  bus.emit('lo-calc:complete', { windowDays, cutoff, floorDate, inactFloor, allowedOwners: effectiveLOs });
  bus.emit('status', { type: 'ok', msg: 'LO Calculation complete — ' + state.loActiveResults.length + ' active · ' + state.loInactiveResults.length + ' inactive · ' + state.loUnassignedResults.length + ' unassigned' });
}
