import { state } from './state.js';
import { bus } from './events.js';
import { norm, parseDate, fmtNow } from './utils.js';
import { getField } from './utils.js';
import { loadDataFromSupabase } from './supabase.js';

export async function runCalc() {
  document.getElementById('run-btn').disabled = true;
  document.getElementById('run-btn').textContent = '⏳ Calculating...';
  try {
    await _runCalc();
  } catch (e) {
    bus.emit('status', { type: 'err', msg: '❌ Calculation error: ' + e.message });
    console.error('runCalc error:', e);
  } finally {
    document.getElementById('run-btn').disabled = false;
    document.getElementById('run-btn').innerHTML = '<i class="ti ti-player-play"></i> Calculate Metrics';
  }
}

async function _runCalc() {
  if (!state.leadsData || !state.oppData) {
    try {
      bus.emit('status', { type: 'load', msg: '⏳ Loading data from Supabase...' });
      const { leadsData, oppData } = await loadDataFromSupabase({
        onStatus: (t, m) => bus.emit('status', { type: t, msg: m })
      });
      state.leadsData = leadsData;
      state.oppData = oppData;
      if (!state.leadsData || !state.leadsData.length) {
        bus.emit('status', { type: 'err', msg: '❌ No lead data found. Please upload the file first.' });
        return;
      }
    } catch (e) {
      bus.emit('status', { type: 'err', msg: '❌ Error loading data: ' + e.message });
      return;
    }
  }
  bus.emit('status', { type: 'load', msg: '⏳ Processing ' + state.leadsData.length + ' leads and ' + (state.oppData ? state.oppData.length : 0) + ' opportunities...' });

  const cutoffStr = document.getElementById('cutoff-date').value;
  const windowDays = parseInt(document.getElementById('window-days').value) || 60;
  const reactDays = parseInt(document.getElementById('react-days').value) || 150;
  const inactFromStr = document.getElementById('inactive-from').value;
  const allowedOwners = document.getElementById('owners-list').value.split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== '');
  const allowedNorm = new Map(allowedOwners.map(o => [norm(o), o]));
  const cutoff = new Date(cutoffStr + 'T23:59:59Z');
  const floorDate = new Date(cutoff); floorDate.setUTCDate(floorDate.getUTCDate() - windowDays);
  const reactThreshold = new Date(cutoff); reactThreshold.setUTCDate(reactThreshold.getUTCDate() - reactDays);
  const inactFloor = inactFromStr ? new Date(inactFromStr + 'T00:00:00Z') : new Date('2024-01-01');

  const byRef = new Map();
  const leadRowsMap = new Map();
  const oppRowsMap = new Map();
  for (const row of (state.leadsData || [])) {
    const ref = getField(row, 'Referred By', 'referred by'); if (!ref || !String(ref).trim()) continue;
    const key = norm(ref), name = String(ref).trim();
    const cd = parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'));
    const ownerStr = String(getField(row, 'Lead Owner', 'lead owner', 'owner') || '').trim();
    const branchStr = String(getField(row, 'Branch', 'branch') || '').trim();
    if (!byRef.has(key)) byRef.set(key, { name, allDates: [], recentDates: [], owners: new Map(), allOwners: new Map(), branches: new Map(), convertedCount: 0 });
    const rec = byRef.get(key);
    if (cd) {
      rec.allDates.push(cd);
      if (ownerStr) rec.allOwners.set(ownerStr, (rec.allOwners.get(ownerStr) || 0) + 1);
      if (cd >= floorDate && cd <= cutoff) {
        rec.recentDates.push(cd);
        const conv = getField(row, 'Converted', 'converted');
        if (conv === true || String(conv).trim().toLowerCase() === 'true') rec.convertedCount++;
        if (ownerStr) rec.owners.set(ownerStr, (rec.owners.get(ownerStr) || 0) + 1);
        if (branchStr) rec.branches.set(branchStr, (rec.branches.get(branchStr) || 0) + 1);
        if (!leadRowsMap.has(key)) leadRowsMap.set(key, []);
        leadRowsMap.get(key).push(row);
      }
    }
  }

  const cwMap = new Map(), ratMap = new Map(), paMap = new Map(), oppOwnerMap = new Map();
  const curCwMap = new Map(), curRatMap = new Map(), curPaMap = new Map();
  for (const row of (state.oppData || [])) {
    const ref = getField(row, 'Referred By', 'referred by'); if (!ref || !String(ref).trim()) continue;
    const key = norm(ref);
    const stage = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    const paDate = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date'));
    const ratDate = parseDate(getField(row, 'Ratified Date', 'ratified date'));
    const oppOwner = getField(row, 'Opportunity Owner', 'opportunity owner');
    if (oppOwner) oppOwnerMap.set(key, String(oppOwner).trim());
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

  state.activeResults = []; state.inactiveResults = []; state.unassignedResults = [];

  for (const [key, rec] of byRef.entries()) {
    const allSorted = [...rec.allDates].sort((a, b) => a - b);
    const uniqueDays = [], seen = new Set();
    for (const d of allSorted) { const k = d.toISOString().slice(0, 10); if (!seen.has(k)) { seen.add(k); uniqueDays.push(d); } }
    const firstDate = uniqueDays[0] || null, lastDate = uniqueDays[uniqueDays.length - 1] || null, penult = uniqueDays.length >= 2 ? uniqueDays[uniqueDays.length - 2] : null;
    const cnt = rec.recentDates.length, isActive = cnt > 0;
    const hasLeadSince = rec.allDates.some(d => d >= inactFloor);
    const isInactive = !isActive && lastDate && lastDate < floorDate && hasLeadSince;
    if (!isActive && !isInactive) continue;

    let assignedOwner = '', assignedBranch = '', ownerSource = 'auto', confirmed = false;
    const me = state.masterMap.get(key);
    if (me && me.owner && me.source === 'manual') {
      assignedOwner = me.owner; assignedBranch = me.branch || ''; ownerSource = me.source || 'auto'; confirmed = me.confirmed || false;
    } else {
      if (rec.owners.size > 0) { let best = '', bestN = -1; for (const [o, n] of rec.owners.entries()) { const c = allowedNorm.get(norm(o)); if (c && n > bestN) { bestN = n; best = c; } } if (bestN > -1) assignedOwner = best; }
      if (!assignedOwner && oppOwnerMap.has(key)) { const c = allowedNorm.get(norm(oppOwnerMap.get(key))); if (c) assignedOwner = c; }
      if (rec.branches.size > 0) { let best = '', bestN = -1; for (const [b, n] of rec.branches.entries()) if (n > bestN) { bestN = n; best = b; } assignedBranch = best; }
    }

    if (!assignedOwner || assignedOwner.trim() === '') {
      const ownersMap = rec.owners.size > 0 ? rec.owners : rec.allOwners;
      state.unassignedResults.push({
        key, name: rec.name, isActive, firstDate, lastDate,
        allTimeCount: rec.allDates.length,
        leadOwnersSeen: [...ownersMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, n]) => o + ' (' + n + ')')
      });
      continue;
    }

    const cw = cwMap.get(key) || 0, pa = paMap.get(key) || 0, rat = ratMap.get(key) || 0;

    if (isActive) {
      const c1 = true, c2 = firstDate ? firstDate >= floorDate : false, c3 = firstDate ? firstDate < floorDate : false, c4 = penult ? penult <= reactThreshold : false;
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
      state.activeResults.push({ key, name: rec.name, cnt, convertedCount: rec.convertedCount, firstDate, penult, lastDate, c1, c2, c3, c4, cw, pa, rat, curCw, curRat, curPa, med, assignedOwner, assignedBranch, ownerSource, confirmed, leadRows: leadRowsMap.get(key) || [], oppRows: oppRowsMap.get(key) || [] });
    } else {
      const curCw2 = curCwMap.get(key) || 0, curRat2 = curRatMap.get(key) || 0, curPa2 = curPaMap.get(key) || 0;
      state.inactiveResults.push({ key, name: rec.name, cnt: rec.recentDates.length || rec.allDates.length, convertedCount: rec.convertedCount, firstDate, penult, lastDate, cw, pa, rat, curCw: curCw2, curRat: curRat2, curPa: curPa2, med: 'Inactive', assignedOwner, assignedBranch, ownerSource, confirmed, daysSinceLast: lastDate ? Math.floor((cutoff - lastDate) / 86400000) : null, leadRows: leadRowsMap.get(key) || [], oppRows: oppRowsMap.get(key) || [] });
    }
    const existing = state.masterMap.get(key);
    if (!existing || existing.source === 'auto') {
      state.masterMap.set(key, { name: rec.name, owner: assignedOwner, branch: assignedBranch, source: 'auto', updatedAt: fmtNow(), confirmed: false });
    }
  }

  state.currentMode = document.getElementById('mode-selector').value;

  const uBadge = document.getElementById('unassigned-count-badge');
  if (uBadge) uBadge.textContent = state.unassignedResults.length;

  bus.emit('calc:complete', { windowDays, cutoff, floorDate, inactFloor, allowedOwners });
  bus.emit('status', { type: 'ok', msg: '✅ Calculation complete — ' + state.activeResults.length + ' active · ' + state.inactiveResults.length + ' inactive · ' + state.unassignedResults.length + ' unassigned' });
}
