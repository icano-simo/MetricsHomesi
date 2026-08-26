import { state } from './state.js';
import { norm, parseDate, fmtDate, getField } from './utils.js';
import { sbFetch } from './supabase.js';
import { openModal, pushModalView } from './modal.js';
import { renderModalFilters } from './modal-filters.js';
import { visibleOwners } from './visibility.js';
import { findRealtorMatch } from './meetings-review.js';
import { buildHealthBreakdown, openHealthModal, healthChipHtml } from './pipeline.js';

export const kpiGoals = { loanAmount: 700000, pipelineOpps: 10, loanCountGoal: 2 };
const _healthCachePerf = new Map();
const _perfDrill = new Map();
// Delegación: celdas con data-drill-perf abren un drill-down dentro del modal (← Back)
document.addEventListener('click', e => {
  const cell = e.target.closest('[data-drill-perf]');
  if (!cell || !cell.closest('#detail-modal')) return;
  const d = _perfDrill.get(cell.getAttribute('data-drill-perf'));
  if (d) pushModalView({ title: d.title, subtitle: d.subtitle, content: d.build() });
});

export async function loadKpiSettings() {
  try {
    const rows = await sbFetch('kpi_settings?select=key,value,text_value');
    for (const r of (rows || [])) {
      if (r.key === 'loan_amount_goal') kpiGoals.loanAmount = Number(r.value) || 700000;
      if (r.key === 'loan_count_goal') kpiGoals.loanCountGoal = Number(r.value) || 2;
      if (r.key === 'pipeline_opps_goal') kpiGoals.pipelineOpps = Number(r.value) || 10;
      if (r.key === 'owners_list' && r.text_value) {
        const el = document.getElementById('owners-list');
        if (el) el.value = r.text_value;
      }
      if (r.key === 'lo_list' && r.text_value) {
        const el = document.getElementById('lo-list');
        const el2 = document.getElementById('lo-list-settings');
        if (el) el.value = r.text_value;
        if (el2) el2.value = r.text_value;
      }
    }
  } catch (_) { /* table may not exist yet — use defaults */ }
  const lcgEl = document.getElementById('kpi-loan-count-goal');
  const oEl   = document.getElementById('kpi-opps-goal');
  if (lcgEl) lcgEl.value = kpiGoals.loanCountGoal;
  if (oEl)   oEl.value   = kpiGoals.pipelineOpps;
}

export async function saveKpiSettings() {
  const lcgEl = document.getElementById('kpi-loan-count-goal');
  const oEl   = document.getElementById('kpi-opps-goal');
  if (lcgEl) kpiGoals.loanCountGoal = Math.max(0, Number(lcgEl.value) || 2);
  if (oEl)   kpiGoals.pipelineOpps  = Math.max(0, Number(oEl.value)   || 10);
  try {
    await sbFetch('kpi_settings?on_conflict=key', {
      method: 'POST',
      prefer: 'return=minimal,resolution=merge-duplicates',
      headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify([
        { key: 'loan_count_goal',   value: kpiGoals.loanCountGoal },
        { key: 'pipeline_opps_goal', value: kpiGoals.pipelineOpps }
      ])
    });
  } catch (_) { /* silent */ }
  renderPerformance();
}

export async function saveOwnersList() {
  const el = document.getElementById('owners-list');
  const val = el ? el.value : '';
  const statusEl = document.getElementById('owners-save-status');
  if (statusEl) statusEl.textContent = 'Saving…';
  try {
    await sbFetch('kpi_settings?on_conflict=key', {
      method: 'POST',
      prefer: 'return=minimal,resolution=merge-duplicates',
      headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify([{ key: 'owners_list', text_value: val }])
    });
    if (statusEl) { statusEl.textContent = 'Saved'; setTimeout(() => { statusEl.textContent = ''; }, 3000); }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}

function getAllowedOwners() {
  // Display-only: se limita a los BDs visibles del usuario (no cambia el cálculo).
  return visibleOwners(document.getElementById('owners-list').value
    .split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== ''));
}

const MS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MS_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmtMoney(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v < 0 ? '-' : '') + '$' + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v < 0 ? '-' : '') + '$' + Math.round(a / 1e3) + 'K';
  return (v < 0 ? '-' : '') + '$' + Math.round(a);
}

function fmtMoneyFull(v) {
  return (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
}

function fmtShortDate(d) {
  if (!d) return '?';
  return MS_SHORT[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

function getPeriodBounds(year, months0, today, isCompare) {
  const sorted = [...months0].sort((a, b) => a - b);
  const start = new Date(Date.UTC(year, sorted[0], 1));
  const lastM = sorted[sorted.length - 1];
  const isCurrent = !isCompare && year === today.getUTCFullYear() && sorted.includes(today.getUTCMonth());
  const end = isCurrent
    ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999))
    : new Date(Date.UTC(year, lastM + 1, 0, 23, 59, 59, 999));
  return { start, end };
}

function calcLoanClosings(owner, start, end) {
  let count = 0, totalAmount = 0;
  for (const row of (state.oppData || [])) {
    const stage = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    if (stage !== 'closed won') continue;
    const oppOwner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    if (norm(oppOwner) !== norm(owner)) continue;
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    if (!disbDate || disbDate < start || disbDate > end) continue;
    const lender = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
    if (lender.includes('city lending inc')) continue;
    const raw = String(getField(row, 'Loan Amount', 'loan amount', 'Amount', 'amount') || '').replace(/[$,]/g, '');
    count++;
    totalAmount += parseFloat(raw) || 0;
  }
  return { count, totalAmount };
}

function calcClosingGoal(months0) {
  const mults = [1, 1.25, 1.25 * 1.25, 1.25 * 1.25 * 1.25];
  return months0.reduce((sum, m) => sum + kpiGoals.loanCountGoal * mults[Math.floor(m / 3)], 0);
}

function calcLeadsCreated(owner, start, end) {
  const nOwner = norm(owner);
  const rows = [];
  const realtorSet = new Set();
  for (const row of (state.leadsData || [])) {
    const leadOwner = String(getField(row, 'Lead Owner', 'lead owner', 'Owner', 'owner') || '').trim();
    if (norm(leadOwner) !== nOwner) continue;
    const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
    if (!ref) continue;
    const refKey = norm(ref);
    const me = state.masterMap.get(refKey);
    if (!me || norm(me.owner || '') !== nOwner) continue;
    const cd = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (!cd || cd < start || cd > end) continue;
    rows.push(row);
    realtorSet.add(refKey);
  }
  return { count: rows.length, uniqueRealtors: realtorSet.size, rows };
}

function calcPipelineActivity(owner, start, end) {
  let created = 0, stillActive = 0;
  for (const row of (state.oppData || [])) {
    const oppOwner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    if (norm(oppOwner) !== norm(owner)) continue;
    const cd = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (!cd || cd < start || cd > end) continue;
    created++;
    const stage = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    if (stage !== 'closed lost') stillActive++;
  }
  return { created, stillActive };
}

// H/F window: replicates calc.js assignment logic for a specific owner and window
function calcHuntingFarmingForWindow(owner, floorDate, cutoffDate, byRef, oppOwnerMap, getNormOwner, allowedNorm) {
  const reactDays = parseInt((document.getElementById('react-days') || {}).value) || 150;
  const reactThreshold = new Date(cutoffDate);
  reactThreshold.setUTCDate(reactThreshold.getUTCDate() - reactDays);

  const huntingRealtors = [], farmingRealtors = [];

  for (const [key, rec] of byRef.entries()) {
    // Deriva datos de la ventana desde los leads pre-indexados (sin re-escanear leadsData)
    let windowCnt = 0;
    const windowOwners = new Map(), windowBranches = new Map();
    for (const l of rec.leads) {
      if (l.date >= floorDate && l.date <= cutoffDate) {
        windowCnt++;
        if (l.owner) windowOwners.set(l.owner, (windowOwners.get(l.owner) || 0) + 1);
        if (l.branch) windowBranches.set(l.branch, (windowBranches.get(l.branch) || 0) + 1);
      }
    }
    if (!windowCnt) continue;

    const allSorted = [...rec.allDates].sort((a, b) => a - b);
    const uniqueDays = [];
    const seen = new Set();
    for (const d of allSorted) {
      const dk = d.toISOString().slice(0, 10);
      if (!seen.has(dk)) { seen.add(dk); uniqueDays.push(d); }
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
      let best = '', bestN = -1;
      for (const [o, n] of windowOwners.entries()) {
        const canonical = allowedNorm.get(getNormOwner(o));
        if (canonical && n > bestN) { bestN = n; best = canonical; }
      }
      if (bestN > -1) assignedOwner = best;
      if (!assignedOwner && oppOwnerMap.has(key)) {
        const canonical = allowedNorm.get(oppOwnerMap.get(key));
        if (canonical) assignedOwner = canonical;
      }
    }
    if (!assignedOwner || assignedOwner !== owner) continue;

    let branch = '—';
    if (windowBranches.size > 0) {
      let bestB = '', bestN = -1;
      for (const [b, n] of windowBranches.entries()) if (n > bestN) { bestN = n; bestB = b; }
      if (bestB) branch = bestB;
    }

    const med = c2 ? 'Hunting New' : c4 ? 'Hunting Rescued' : 'Farming Lead';
    const detail = { name: rec.name, branch, firstDate, cnt: windowCnt, med };
    if (c2 || c4) huntingRealtors.push(detail);
    else farmingRealtors.push(detail);
  }

  return {
    hunting: huntingRealtors.length, farming: farmingRealtors.length,
    total: huntingRealtors.length + farmingRealtors.length,
    huntingRealtors, farmingRealtors
  };
}

function calcTeamAvgHF(cutoff, baseDate, byRef, oppOwnerMap, getNormOwner, allowedNorm) {
  const owners = getAllowedOwners();
  const hVals = [], fVals = [];
  for (const o of owners) {
    const hf = calcHuntingFarmingForWindow(o, baseDate, cutoff, byRef, oppOwnerMap, getNormOwner, allowedNorm);
    if (hf.hunting >= 1) hVals.push(hf.hunting);
    if (hf.farming >= 1) fVals.push(hf.farming);
  }
  return {
    avgH: hVals.length ? hVals.reduce((s, v) => s + v, 0) / hVals.length : 0,
    avgF: fVals.length ? fVals.reduce((s, v) => s + v, 0) / fVals.length : 0
  };
}

function goalBar(pct) {
  const w = Math.min(pct, 100);
  const col = pct >= 100 ? '#085041' : pct >= 70 ? '#D4A000' : 'var(--hs-red)';
  return '<div class="perf-goal-track"><div class="perf-goal-fill" style="width:' + w + '%;background:' + col + '"></div></div>';
}

function dChipMoney(main, cmp) {
  if (cmp === null || cmp === undefined) return '';
  const diff = main - cmp;
  if (Math.abs(diff) < 1) return '<span class="perf-delta perf-delta-neutral">&#8596; no change</span>';
  const up = diff > 0;
  const pct = cmp !== 0 ? Math.round((diff / cmp) * 100) : null;
  const pctStr = pct !== null ? ' (' + (up ? '+' : '') + pct + '%)' : '';
  return '<span class="perf-delta ' + (up ? 'perf-delta-up' : 'perf-delta-dn') + '">' + (up ? '&#9650; +' : '&#9660; ') + fmtMoney(Math.abs(diff)) + pctStr + '</span>';
}

function dChipInt(main, cmp) {
  if (cmp === null || cmp === undefined) return '';
  const diff = main - cmp;
  if (diff === 0) return '<span class="perf-delta perf-delta-neutral">&#8596; no change</span>';
  const up = diff > 0;
  const pct = cmp !== 0 ? Math.round((diff / cmp) * 100) : null;
  const pctStr = pct !== null ? ' (' + (up ? '+' : '') + pct + '%)' : '';
  return '<span class="perf-delta ' + (up ? 'perf-delta-up' : 'perf-delta-dn') + '">' + (up ? '&#9650; +' : '&#9660; ') + Math.abs(diff) + pctStr + '</span>';
}

function hfChip(val, avg) {
  if (!avg) return '';
  if (val > avg + 1) return '<span class="perf-hf-chip perf-hf-above">&#9650; above avg</span>';
  if (val < avg - 1) return '<span class="perf-hf-chip perf-hf-below">&#9660; below avg</span>';
  return '<span class="perf-hf-chip perf-hf-avg">&#8776; avg</span>';
}

function goalChip(pct) {
  if (pct >= 100) return '<span class="perf-goal-chip perf-goal-chip-above">&#9650; above goal</span>';
  if (pct >= 70)  return '<span class="perf-goal-chip perf-goal-chip-near">&#8776; near goal</span>';
  return '<span class="perf-goal-chip perf-goal-chip-below">&#9660; below goal</span>';
}

function pLabel(year, months0, today, isCompare) {
  const s = [...months0].sort((a, b) => a - b);
  const mStr = s.length === 1 ? MS_SHORT[s[0]] : MS_SHORT[s[0]] + '–' + MS_SHORT[s[s.length - 1]];
  if (isCompare) return mStr + ' ' + year + ' (full month)';
  const isCurrent = year === today.getUTCFullYear() && s.includes(today.getUTCMonth());
  return mStr + ' ' + year + (isCurrent ? ' (thru today)' : ' (full month)');
}

function parseZoomTime(s) {
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  return null;
}

function fmtZoomDT(d) {
  if (!d) return '—';
  const h = d.getHours(), mi = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  return MS_SHORT[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' · ' + (h % 12 || 12) + ':' + mi + ' ' + ampm;
}

function calcCalls(ownerName, startDate, endDate) {
  const nOwner = norm(ownerName);
  const filtered = (state.callsData || []).filter(r => {
    if (norm(r.assigned_to || '') !== nOwner) return false;
    const d = parseDate(r.call_date);
    return d && d >= startDate && d <= endDate;
  });
  const totalCalls = filtered.reduce((s, r) => s + (r.total_calls || 0), 0);
  const effectiveCalls = filtered.reduce((s, r) => s + (r.effective_calls || 0), 0);
  const effectivenessRate = totalCalls > 0 ? Math.round((effectiveCalls / totalCalls * 100) * 10) / 10 : 0;
  const realtorFiltered = filtered.filter(r => norm(r.record_type || '') === 'realtor');
  const realtorCalls = realtorFiltered.reduce((s, r) => s + (r.total_calls || 0), 0);
  const realtorEffective = realtorFiltered.reduce((s, r) => s + (r.effective_calls || 0), 0);
  const byType = new Map();
  for (const row of filtered) {
    const rt = String(row.record_type || '').trim() || 'Unknown';
    byType.set(rt, (byType.get(rt) || 0) + (row.total_calls || 0));
  }
  return { totalCalls, effectiveCalls, effectivenessRate, realtorCalls, realtorEffective, byType };
}

function calcMeetingInvites(ownerName, startDate, endDate) {
  const nOwner = norm(ownerName);
  const rom = state.realtorOwnerMap || new Map();
  const inRange = d => d && d >= startDate && d <= endDate;

  const recs = [];
  for (const [key, entry] of rom.entries()) {
    const e = (entry && typeof entry === 'object') ? entry : {};
    const owner = (entry && typeof entry === 'object') ? (entry.owner || '') : (entry || '');
    if (norm(owner) !== nOwner) continue;
    const recordType = String(e.opportunity_record_type || 'Realtor').trim();
    if (recordType !== 'Realtor') continue;
    const inviteD = parseDate(e.invite_sent_date);
    const attendD = parseDate(e.meeting_attended_date);
    if (!inRange(inviteD) && !inRange(attendD)) continue;
    const leads = (state.leadsData || []).filter(lr => norm(String(getField(lr, 'Referred By', 'referred by') || '')) === key);
    const leadDates = leads.map(lr => parseDate(getField(lr, 'Created Date', 'created date', 'Create Date', 'create date'))).filter(Boolean).sort((a, b) => a - b);
    const me = state.masterMap.get(key) || {};
    const name = e.name || me.name || (leads[0] ? String(getField(leads[0], 'Referred By', 'referred by') || '').trim() : key);
    recs.push({
      key, name, leads,
      entryBranch: String(e.branch || '').trim(),
      entryLo: String(e.loan_officers || '').trim(),
      inviteD, attendD,
      nppm: e.nppm === true,
      lastReferralD: parseDate(e.last_referral_date),
      leadCount: leads.length,
      firstLeadDate: leadDates[0] || null,
      lastLeadDate: leadDates[leadDates.length - 1] || null,
      hasLeadAfterMeeting: attendD ? leadDates.some(d => d > attendD) : false
    });
  }

  const relevantKeys = new Set(recs.map(r => r.key));
  const oppInfoByKey = new Map();
  for (const row of (state.oppData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (!ref) continue;
    const k = norm(String(ref));
    if (!relevantKeys.has(k)) continue;
    let info = oppInfoByKey.get(k);
    if (!info) { info = { loMap: new Map(), branch: '' }; oppInfoByKey.set(k, info); }
    const lo = String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '').trim();
    if (lo) info.loMap.set(lo, (info.loMap.get(lo) || 0) + 1);
    if (!info.branch) { const b = String(getField(row, 'Branch', 'branch') || '').trim(); if (b) info.branch = b; }
  }
  for (const r of recs) {
    const info = oppInfoByKey.get(r.key);
    r.branch = r.entryBranch || (info && info.branch) || '—';
    r.loanOfficer = r.entryLo || (info && info.loMap.size ? [...info.loMap.entries()].sort((a, b) => b[1] - a[1])[0][0] : '') || '—';
  }

  const invitesList = recs.filter(r => inRange(r.inviteD));
  const attendedList = recs.filter(r => inRange(r.attendD));
  const invitesSent = invitesList.length;
  const meetingAttended = attendedList.length;
  const nppmCount = attendedList.filter(r => r.nppm).length;
  const leadsReferred = attendedList.reduce((s, r) => s + r.leadCount, 0);
  const realtorsWithLeads = attendedList.filter(r => r.hasLeadAfterMeeting).length;
  const conversionRate = meetingAttended > 0 ? (realtorsWithLeads / meetingAttended * 100).toFixed(1) : '0.0';

  return { invitesSent, meetingAttended, nppmCount, leadsReferred, realtorsWithLeads, conversionRate, invitesList, attendedList };
}

function calcZoom(ownerName, startDate, endDate) {
  const nOwner = norm(ownerName);

  // Build the set of YYYY-MM month keys that fall within [startDate, endDate]
  const monthKeys = new Set();
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const last   = new Date(Date.UTC(endDate.getUTCFullYear(),   endDate.getUTCMonth(),   1));
  while (cursor <= last) {
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    monthKeys.add(cursor.getUTCFullYear() + '-' + mm);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const meetingMap = new Map();
  for (const r of (state.zoomData || [])) {
    if (norm(r.host_name || '') !== nOwner) continue;
    if (!monthKeys.has(r.month_key)) continue;
    if ((state.doNotCountMeetings || new Set()).has(r.meeting_id || '')) continue;
    const d = parseZoomTime(r.start_time);
    const key = (r.meeting_id || '') + '|' + (r.month_key || '') + '|' + (r.start_time || '');
    if (!meetingMap.has(key)) meetingMap.set(key, { rows: [], startTime: d || null, rawTime: r.start_time, duration: r.duration_minutes });
    meetingMap.get(key).rows.push(r);
  }

  const meetingsWithGuest = [];
  for (const m of meetingMap.values()) {
    const guests = m.rows.filter(r => r.is_guest === 'Yes');
    if (guests.length) meetingsWithGuest.push({ ...m, guests });
  }

  const externalMap = new Map();
  for (const m of meetingsWithGuest) {
    for (const g of m.guests) {
      const nn = norm(g.participant_name || '');
      if (!nn) continue;
      if (!externalMap.has(nn)) externalMap.set(nn, { name: g.participant_name || '', email: g.participant_email || '', meetingDate: m.startTime });
    }
  }
  const externalsList = [...externalMap.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const meetingsDetail = meetingsWithGuest.map(m => ({
    startTime: m.startTime,
    duration: m.duration,
    meetingId: (m.rows[0] || {}).meeting_id || '',
    externals: [...new Map(m.guests.map(g => [norm(g.participant_name || ''), g.participant_name || ''])).values()].filter(Boolean),
    internalRows: m.rows.filter(r => r.is_guest !== 'Yes')
  })).sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  return { meetingsWithExternal: meetingsWithGuest.length, uniqueExternals: externalMap.size, externalsList, meetingsDetail };
}

// ── Modal builders ──────────────────────────────────────────────────────────

const _perfModalCache = new Map();

function buildLoanModal(owner, start, end, label) {
  const rows = (state.oppData || []).filter(row => {
    if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed won') return false;
    if (norm(String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim()) !== norm(owner)) return false;
    const d = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    if (!d || d < start || d > end) return false;
    if (String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase().includes('city lending inc')) return false;
    return true;
  });
  const enriched = rows.map(row => ({
    lnNum: String(getField(row, 'Loan #', 'loan #') || '—').trim(),
    oppName: String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim(),
    realtor: String(getField(row, 'Referred By', 'referred by') || '—').trim(),
    branch: String(getField(row, 'Branch', 'branch') || '').trim() || '—',
    disbDate: parseDate(getField(row, 'Disbursement Date', 'disbursement date')),
    amt: parseFloat(String(getField(row, 'Loan Amount', 'loan amount', 'Amount', 'amount') || '').replace(/[$,]/g, '')) || 0
  }));
  enriched.sort((a, b) => (a.disbDate || 0) - (b.disbDate || 0));
  const total = enriched.reduce((s, e) => s + e.amt, 0);
  const head = '<tr><th>Loan #</th><th>Opportunity Name</th><th>Realtor</th><th>Branch</th><th>Disbursement Date</th><th>Loan Amount</th></tr>';
  const body = enriched.map(e =>
    '<tr>' +
    '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
    '<td style="font-weight:600">' + e.oppName + '</td>' +
    '<td>' + e.realtor + '</td>' +
    '<td style="font-size:11px">' + e.branch + '</td>' +
    '<td class="dt">' + fmtDate(e.disbDate) + '</td>' +
    '<td class="modal-amount">$' + Math.round(e.amt).toLocaleString('en-US') + '</td>' +
    '</tr>'
  ).join('') +
  '<tr style="background:#EEF1F8;font-weight:700"><td colspan="5" style="text-align:right;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.3px">Total</td><td class="modal-amount">$' + Math.round(total).toLocaleString('en-US') + '</td></tr>';
  return {
    title: owner + ' — Closed Won',
    sub: label + ' · ' + enriched.length + ' loan' + (enriched.length !== 1 ? 's' : '') + ' · $' + Math.round(total).toLocaleString('en-US'),
    head, body,
    csvData: [
      ['Loan #', 'Opportunity Name', 'Realtor', 'Branch', 'Disbursement Date', 'Loan Amount'],
      ...enriched.map(e => [e.lnNum, e.oppName, e.realtor, e.branch === '—' ? '' : e.branch, fmtDate(e.disbDate), e.amt])
    ]
  };
}

function buildOppTable(rows, title, sub) {
  const enriched = rows.map(row => {
    const stage = String(getField(row, 'Stage', 'stage') || '—').trim();
    return {
      lnNum: String(getField(row, 'Loan #', 'loan #') || '—').trim(),
      oppName: String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim(),
      realtor: String(getField(row, 'Referred By', 'referred by') || '—').trim(),
      loanOfficer: String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '').trim() || '—',
      stage,
      branch: String(getField(row, 'Branch', 'branch') || '').trim() || '—',
      health: String(getField(row, 'Healthiness', 'healthiness') || '').trim(),
      healthiness: String(getField(row, 'Healthiness', 'healthiness') || '').trim(),
      preApproval: parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date', 'Pre-Approval Date', 'pre-approval date')),
      ratified: parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date')),
      estClosing: parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'estimated closing date', 'Estimated Closing Date', 'Close Date', 'close date')),
      disbursement: parseDate(getField(row, 'Disbursement Date', 'disbursement date', 'disbursement_date')),
      loanAmt: parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0,
      createdDate: parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'))
    };
  });
  enriched.sort((a, b) => (a.createdDate || 0) - (b.createdDate || 0));
  const head = '<tr><th>Loan #</th><th>Opportunity Name</th><th>Realtor</th><th>Loan Officer</th><th>Stage</th><th>Health Status</th><th>Pre-Approval Date</th><th>Ratified Date</th><th>Est. Closing Date</th><th>Disbursement Date</th><th>Created Date</th><th>Loan Amount</th></tr>';
  const renderRow = e =>
    '<tr>' +
    '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
    '<td style="font-weight:600">' + e.oppName + '</td>' +
    '<td>' + e.realtor + '</td>' +
    '<td style="font-size:11px">' + e.loanOfficer + '</td>' +
    '<td style="font-size:11px">' + e.stage + '</td>' +
    '<td>' + healthChipHtml(e.health) + '</td>' +
    '<td class="dt">' + (e.preApproval ? fmtDate(e.preApproval) : '—') + '</td>' +
    '<td class="dt">' + (e.ratified ? fmtDate(e.ratified) : '—') + '</td>' +
    '<td class="dt">' + (e.estClosing ? fmtDate(e.estClosing) : '—') + '</td>' +
    '<td class="dt">' + (e.disbursement ? fmtDate(e.disbursement) : '—') + '</td>' +
    '<td class="dt">' + fmtDate(e.createdDate) + '</td>' +
    '<td class="modal-amount">' + (e.loanAmt ? fmtMoney(e.loanAmt) : '—') + '</td>' +
    '</tr>';
  const body = enriched.map(renderRow).join('');
  return {
    title, sub,
    head, body, rows: enriched, renderRow,
    csvData: [
      ['Loan #', 'Opportunity Name', 'Realtor', 'Loan Officer', 'Stage', 'Health Status', 'Pre-Approval Date', 'Ratified Date', 'Est. Closing Date', 'Disbursement Date', 'Created Date', 'Loan Amount'],
      ...enriched.map(e => [e.lnNum, e.oppName, e.realtor, e.loanOfficer, e.stage, e.health, e.preApproval ? fmtDate(e.preApproval) : '', e.ratified ? fmtDate(e.ratified) : '', e.estClosing ? fmtDate(e.estClosing) : '', e.disbursement ? fmtDate(e.disbursement) : '', fmtDate(e.createdDate), e.loanAmt || ''])
    ]
  };
}

function buildPipelineModal(owner, start, end, label) {
  const rows = (state.oppData || []).filter(row => {
    if (norm(String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim()) !== norm(owner)) return false;
    const cd = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    return cd && cd >= start && cd <= end;
  });
  const activeCount = rows.filter(r => String(getField(r, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed lost').length;
  return buildOppTable(rows, owner + ' — Opportunities Created', label + ' · ' + rows.length + ' opp' + (rows.length !== 1 ? 's' : '') + ' · ' + activeCount + ' still active');
}

function buildHFModal(isHunting, realtors, owner, label) {
  const type = isHunting ? 'Hunting' : 'Farming';
  const sorted = [...realtors].sort((a, b) => (b.cnt || 0) - (a.cnt || 0));
  const keySet = new Set(sorted.map(r => norm(r.name || '')));
  const loByKey = new Map();
  for (const row of (state.oppData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (!ref) continue;
    const k = norm(String(ref));
    if (!keySet.has(k)) continue;
    const lo = String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '').trim();
    if (!lo) continue;
    let m = loByKey.get(k); if (!m) { m = new Map(); loByKey.set(k, m); }
    m.set(lo, (m.get(lo) || 0) + 1);
  }
  const loFor = name => {
    const m = loByKey.get(norm(name || ''));
    if (!m || !m.size) return '—';
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const head = '<tr><th>Realtor</th><th>Branch</th><th>Loan Officer</th><th>1st Lead Date</th><th>Period Leads</th><th>Rating</th></tr>';
  const body = sorted.map(r => {
    const isH = r.med && r.med.startsWith('Hunting');
    const badgeStyle = isH
      ? 'background:#FDE8E8;color:#A32D2D;padding:2px 6px;border-radius:4px;font-size:9px;font-weight:700;white-space:nowrap'
      : 'background:#E8F5F0;color:#085041;padding:2px 6px;border-radius:4px;font-size:9px;font-weight:700;white-space:nowrap';
    return '<tr>' +
      '<td style="font-weight:600">' + (r.name || '—') + '</td>' +
      '<td style="font-size:11px">' + (r.branch || '—') + '</td>' +
      '<td style="font-size:11px">' + loFor(r.name) + '</td>' +
      '<td class="dt">' + fmtDate(r.firstDate) + '</td>' +
      '<td style="text-align:center;font-weight:700;color:var(--hs-navy)">' + (r.cnt || 0) + '</td>' +
      '<td><span style="' + badgeStyle + '">' + (r.med || type) + '</span></td>' +
      '</tr>';
  }).join('');
  return {
    title: owner + ' — ' + type + ' Realtors',
    sub: label + ' · ' + realtors.length + ' realtor' + (realtors.length !== 1 ? 's' : ''),
    head, body,
    csvData: [
      ['Realtor', 'Branch', 'Loan Officer', '1st Lead Date', 'Period Leads', 'Rating'],
      ...sorted.map(r => [r.name || '', r.branch || '', loFor(r.name), fmtDate(r.firstDate), r.cnt || 0, r.med || type])
    ]
  };
}

function getMeetingLOs(internalRows) {
  const seen = new Set();
  const names = [];
  for (const r of (internalRows || [])) {
    const name = (r.participant_name || '').trim();
    if (!name || name.includes('(Host)')) continue;
    const canonical = state.loReferenceMap.get(norm(name));
    if (canonical && !seen.has(canonical)) { seen.add(canonical); names.push(canonical); }
  }
  return names.length ? names.join(', ') : '—';
}

// Match participantName against state.leadsData — levels: 'exact', 'partial', 'none'
function _perfMatchLeads(participantName) {
  const SKIP = new Set(['de','la','el','the','del','las','los','y','e','a','of','en']);
  const sigWords = n => norm(n).split(/\s+/).filter(w => w.length >= 3 && !SKIP.has(w));
  const nPart = norm(participantName);
  const leads = state.leadsData || [];

  const exactLeads = leads.filter(row =>
    norm(String(getField(row, 'Referred By', 'referred by') || '').trim()) === nPart
  );
  if (exactLeads.length) return { level: 'exact', leads: exactLeads };

  const partWords = sigWords(participantName);
  if (partWords.length >= 2) {
    const refGroups = new Map();
    for (const row of leads) {
      const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
      if (!ref) continue;
      const nRef = norm(ref);
      if (!refGroups.has(nRef)) refGroups.set(nRef, { leads: [], originalName: ref });
      refGroups.get(nRef).leads.push(row);
    }
    for (const { leads: rLeads, originalName } of refGroups.values()) {
      const refWords = sigWords(originalName);
      if (partWords.filter(w => refWords.includes(w)).length >= 2) {
        return { level: 'partial', leads: rLeads, matchedName: originalName };
      }
    }
  }

  return { level: 'none' };
}

function buildZoomMeetingsModal(meetingsDetail, owner, label) {
  // Build meeting_id → topic lookup from raw zoomData
  const topicMap = new Map();
  for (const r of (state.zoomData || [])) {
    if (r.meeting_id && !topicMap.has(r.meeting_id)) topicMap.set(r.meeting_id, (r.topic || '').trim() || null);
  }
  // Helper: date range across leads
  const _leadDates = leads => {
    let mn = null, mx = null;
    for (const row of leads) {
      const d = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
      if (d) { if (!mn || d < mn) mn = d; if (!mx || d > mx) mx = d; }
    }
    return { first: mn, last: mx };
  };

  // Helper: render one external name + pipeline chip using findRealtorMatch
  // Returns null for lo/not_realtor participants (filtered out by caller)
  const _renderExt = (name, hostName) => {
    const pKey = norm(name);
    const savedLabel = (state.zoomParticipantLabels || new Map()).get(pKey);

    // Skip LO and not-realtor — they appear in the internal column or are irrelevant
    if (savedLabel && (savedLabel.label === 'lo' || savedLabel.label === 'not_realtor')) return null;

    // Display name: canonical if saved, original otherwise
    const displayName = (savedLabel && savedLabel.canonical_name) ? savedLabel.canonical_name : name;
    const nameHtml = '<span style="font-weight:700">' + displayName + '</span>' +
      (displayName !== name ? '<br><span style="color:#94A3B8;font-size:9px">' + name + '</span>' : '');

    const match = findRealtorMatch(name, hostName);
    let chipHtml;
    if (match.level === 'found') {
      const countStr = match.count + ' lead' + (match.count !== 1 ? 's' : '');
      const dateInfo = (match.firstDate || match.lastDate)
        ? ' · first: ' + fmtDate(match.firstDate) + (match.lastDate ? ' · last: ' + fmtDate(match.lastDate) : '')
        : '';
      chipHtml = '<div style="display:inline-block;background:#D1FAE5;color:#065F46;font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;margin-left:4px">&#10003; ' + match.canonicalName + ' · ' + countStr + dateInfo + '</div>';
    } else if (match.level === 'salesforce') {
      chipHtml = '<div style="display:inline-block;background:#EBF4FF;color:#1E4D7B;font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;margin-left:4px">In Salesforce · no leads yet</div>';
    } else {
      chipHtml = '<div style="display:inline-block;background:#F1F5F9;color:#64748B;font-size:9px;font-weight:600;padding:1px 6px;border-radius:10px;margin-left:4px">Not in pipeline</div>';
    }

    return '<div style="margin-bottom:5px">' + nameHtml + chipHtml + '</div>';
  };

  const head = '<tr><th>Meeting Topic</th><th>Date &amp; Time</th><th>Duration (min)</th><th>Loan Officer</th><th>External Participants</th></tr>';
  const body = meetingsDetail.map(m => {
    const topic = topicMap.get(m.meetingId) || '—';
    const loStr = getMeetingLOs(m.internalRows);
    const extHtml = m.externals.length
      ? m.externals.map(name => _renderExt(name, owner)).filter(Boolean).join('') || '—'
      : '—';
    return '<tr>' +
      '<td style="font-size:11px;font-weight:600;color:var(--hs-navy);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + topic + '">' + topic + '</td>' +
      '<td class="dt">' + fmtZoomDT(m.startTime) + '</td>' +
      '<td style="text-align:center">' + (m.duration || '—') + '</td>' +
      '<td style="font-size:11px;font-weight:600;color:var(--hs-navy)">' + loStr + '</td>' +
      '<td style="font-size:11px;vertical-align:top">' + extHtml + '</td>' +
      '</tr>';
  }).join('');
  return {
    title: owner + ' — Meetings with External',
    sub: label + ' · ' + meetingsDetail.length + ' meeting' + (meetingsDetail.length !== 1 ? 's' : ''),
    head, body,
    csvData: [
      ['Meeting Topic', 'Date & Time', 'Duration (min)', 'Loan Officer', 'External Participants'],
      ...meetingsDetail.map(m => [topicMap.get(m.meetingId) || '—', fmtZoomDT(m.startTime), m.duration || '', getMeetingLOs(m.internalRows), m.externals.join('; ')])
    ]
  };
}

function buildZoomExternalsModal(externalsList, owner, label) {
  const head = '<tr><th>Name</th><th>Email</th><th>Meeting Date</th></tr>';
  const body = externalsList.map(e => {
    return '<tr>' +
      '<td style="font-weight:600">' + (e.name || '—') + '</td>' +
      '<td style="font-size:11px;color:#667799">' + (e.email || '—') + '</td>' +
      '<td class="dt">' + fmtZoomDT(e.meetingDate) + '</td>' +
      '</tr>';
  }).join('');
  return {
    title: owner + ' — Unique External Contacts',
    sub: label + ' · ' + externalsList.length + ' contact' + (externalsList.length !== 1 ? 's' : ''),
    head, body,
    csvData: [
      ['Name', 'Email', 'Meeting Date'],
      ...externalsList.map(e => [e.name || '', e.email || '', fmtZoomDT(e.meetingDate)])
    ]
  };
}

function buildLeadsModal(rows, owner, label) {
  const enriched = rows.map(row => ({
    realtor:     String(getField(row, 'Referred By', 'referred by') || '—').trim(),
    borrower:    (() => { const fn = String(getField(row, 'First Name', 'first name', 'first_name') || '').trim(); const ln = String(getField(row, 'Last Name', 'last name', 'last_name') || '').trim(); return (fn + ' ' + ln).trim() || '—'; })(),
    leadOwner:   String(getField(row, 'Lead Owner', 'lead owner', 'Owner', 'owner') || '—').trim(),
    createdDate: parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date')),
    status:      String(getField(row, 'Lead Status', 'lead status') || '—').trim(),
    leadStatus:  String(getField(row, 'Lead Status', 'lead status') || '—').trim(),
    loanOfficer: String(getField(row, 'Loan Officer', 'loan officer', 'loan_officer') || '').trim() || '—',
    converted:   getField(row, 'Converted', 'converted')
  })).sort((a, b) => (a.createdDate || 0) - (b.createdDate || 0));
  const head = '<tr><th>Realtor</th><th>Borrower</th><th>Lead Owner</th><th>Created Date</th><th>Lead Status</th><th>Loan Officer</th><th>Converted</th></tr>';
  const renderRow = e =>
    '<tr>' +
    '<td style="font-weight:600">' + e.realtor + '</td>' +
    '<td style="font-size:11px">' + e.borrower + '</td>' +
    '<td style="font-size:11px">' + e.leadOwner + '</td>' +
    '<td class="dt">' + fmtDate(e.createdDate) + '</td>' +
    '<td style="font-size:11px">' + e.status + '</td>' +
    '<td style="font-size:11px">' + e.loanOfficer + '</td>' +
    '<td style="text-align:center">' + (e.converted ? '<span style="color:#085041;font-weight:700">Yes</span>' : '<span style="color:#8899BB">No</span>') + '</td>' +
    '</tr>';
  const body = enriched.map(renderRow).join('');
  return {
    title: owner + ' — Leads Created',
    sub: label + ' · ' + enriched.length + ' lead' + (enriched.length !== 1 ? 's' : ''),
    head, body, rows: enriched, renderRow,
    csvData: [
      ['Realtor', 'Borrower', 'Lead Owner', 'Created Date', 'Lead Status', 'Loan Officer', 'Converted'],
      ...enriched.map(e => [e.realtor, e.borrower, e.leadOwner, fmtDate(e.createdDate), e.status, e.loanOfficer, e.converted ? 'Yes' : 'No'])
    ]
  };
}

function buildLeadsRealtorsModal(rows, owner, label) {
  const byRealtor = new Map();
  for (const row of rows) {
    const ref = String(getField(row, 'Referred By', 'referred by') || '—').trim();
    const key = norm(ref) || '—';
    let r = byRealtor.get(key);
    if (!r) { r = { name: ref, total: 0, New: 0, Working: 0, 'On Hold': 0, Discarded: 0, Converted: 0 }; byRealtor.set(key, r); }
    r.total++;
    const st = String(getField(row, 'Lead Status', 'lead status') || '').toLowerCase();
    const conv = getField(row, 'Converted', 'converted');
    const isConv = conv === true || String(conv).toLowerCase() === 'true' || st.includes('qualified') || st.includes('converted');
    if (st.includes('new')) r.New++;
    if (st.includes('working')) r.Working++;
    if (st.includes('hold')) r['On Hold']++;
    if (st.includes('discard') || st.includes('unqualified') || st.includes('dead')) r.Discarded++;
    if (isConv) r.Converted++;
  }
  const rowsArr = [...byRealtor.values()].sort((a, b) => b.total - a.total);
  const convColor = p => p > 30 ? '#065F46' : p >= 15 ? '#B45309' : '#BE123C';
  const head = '<tr><th>Realtor</th><th style="text-align:center">Total Leads</th><th style="text-align:center">New</th><th style="text-align:center">Working</th><th style="text-align:center">On Hold</th><th style="text-align:center">Discarded</th><th style="text-align:center">Converted</th><th style="text-align:center">Conversion Rate</th></tr>';
  const body = rowsArr.map(r => {
    const rate = r.total ? (r.Converted / r.total * 100) : 0;
    return '<tr>' +
      '<td style="font-weight:600">' + r.name + '</td>' +
      '<td style="text-align:center;font-weight:700">' + r.total + '</td>' +
      '<td style="text-align:center">' + (r.New || '—') + '</td>' +
      '<td style="text-align:center">' + (r.Working || '—') + '</td>' +
      '<td style="text-align:center">' + (r['On Hold'] || '—') + '</td>' +
      '<td style="text-align:center">' + (r.Discarded || '—') + '</td>' +
      '<td style="text-align:center">' + (r.Converted || '—') + '</td>' +
      '<td style="text-align:center;font-weight:700;color:' + convColor(rate) + '">' + rate.toFixed(1) + '%</td>' +
    '</tr>';
  }).join('');
  const sum = k => rowsArr.reduce((s, r) => s + r[k], 0);
  const totTotal = sum('total'), totConv = sum('Converted');
  const avgRate = totTotal ? (totConv / totTotal * 100) : 0;
  const totals = '<tr style="background:#0B192C;font-family:\'Barlow\',sans-serif;font-weight:700;color:white">' +
    '<td>TOTAL</td>' +
    '<td style="text-align:center">' + totTotal + '</td>' +
    '<td style="text-align:center">' + sum('New') + '</td>' +
    '<td style="text-align:center">' + sum('Working') + '</td>' +
    '<td style="text-align:center">' + sum('On Hold') + '</td>' +
    '<td style="text-align:center">' + sum('Discarded') + '</td>' +
    '<td style="text-align:center">' + totConv + '</td>' +
    '<td style="text-align:center">' + avgRate.toFixed(1) + '%</td>' +
  '</tr>';
  return {
    title: owner + ' — Realtors Lead Breakdown',
    sub: label + ' · ' + rowsArr.length + ' realtor' + (rowsArr.length !== 1 ? 's' : ''),
    head, body: body + totals,
    csvData: [
      ['Realtor', 'Total Leads', 'New', 'Working', 'On Hold', 'Discarded', 'Converted', 'Conversion Rate'],
      ...rowsArr.map(r => { const rate = r.total ? (r.Converted / r.total * 100) : 0; return [r.name, r.total, r.New, r.Working, r['On Hold'], r.Discarded, r.Converted, rate.toFixed(1) + '%']; }),
      ['TOTAL', totTotal, sum('New'), sum('Working'), sum('On Hold'), sum('Discarded'), totConv, avgRate.toFixed(1) + '%']
    ]
  };
}

// ── Main render ─────────────────────────────────────────────────────────────

export function renderPerformance() {
  const content = document.getElementById('perf-content');
  if (!content) return;

  if (!state.oppData || !state.oppData.length) {
    content.innerHTML = '<div class="empty-state">Run calculation first to view performance metrics</div>';
    return;
  }

  const owner = (document.getElementById('perf-owner') || {}).value || '';
  if (!owner) {
    content.innerHTML = '<div class="perf-empty-bd"><i class="ti ti-user-circle" style="font-size:32px;color:#CCD5E0"></i><div>Select a Business Developer above</div></div>';
    return;
  }

  const yearEl = document.getElementById('perf-year');
  const monthsEl = document.getElementById('perf-months');
  const cmpYearEl = document.getElementById('perf-cmp-year');
  const cmpMonthsEl = document.getElementById('perf-cmp-months');

  const year = parseInt((yearEl || {}).value) || new Date().getUTCFullYear();
  const months0 = monthsEl ? Array.from(monthsEl.selectedOptions).map(o => parseInt(o.value)) : [];
  const cmpYear = parseInt((cmpYearEl || {}).value) || year;
  const cmpMonths0 = cmpMonthsEl ? Array.from(cmpMonthsEl.selectedOptions).map(o => parseInt(o.value)) : [];

  if (!months0.length) {
    content.innerHTML = '<div class="empty-state">Select at least one month for the main period</div>';
    return;
  }

  const today = new Date();
  const { start, end } = getPeriodBounds(year, months0, today, false);
  const hasCmp = cmpMonths0.length > 0;
  const cmpBounds = hasCmp ? getPeriodBounds(cmpYear, cmpMonths0, today, true) : null;

  const windowDays = parseInt((document.getElementById('window-days') || {}).value) || 60;

  // Main H/F window derived from Performance period selection
  const mainSorted = [...months0].sort((a, b) => a - b);
  const mainLastM  = mainSorted[mainSorted.length - 1];
  const isMainCurrent = year === today.getUTCFullYear() && months0.includes(today.getUTCMonth());
  const mainHFCutoff = isMainCurrent
    ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999))
    : new Date(Date.UTC(year, mainLastM + 1, 0, 23, 59, 59, 999));
  const mainHFBase = new Date(mainHFCutoff);
  mainHFBase.setUTCDate(mainHFBase.getUTCDate() - windowDays);

  // ── Pre-indexado O(1): byRef y oppOwnerMap UNA sola vez (elimina el O(BDs × filas)) ──
  const firstLead = (state.leadsData || [])[0] || {};
  const refByField = Object.keys(firstLead).find(k => norm(k) === 'referred by') || 'Referred By';
  const ownerLeadField = Object.keys(firstLead).find(k => norm(k) === 'lead owner' || norm(k) === 'owner') || 'Lead Owner';
  const dateField = Object.keys(firstLead).find(k => norm(k) === 'created date' || norm(k) === 'create date') || 'Created Date';
  const branchLeadField = Object.keys(firstLead).find(k => norm(k) === 'branch') || 'Branch';

  const firstOpp = (state.oppData || [])[0] || {};
  const ownerOppField = Object.keys(firstOpp).find(k => norm(k) === 'opportunity owner') || 'Opportunity Owner';
  const refByOppField = Object.keys(firstOpp).find(k => norm(k) === 'referred by') || 'Referred By';

  const ownerNormCache = new Map();
  const getNormOwner = (raw) => {
    if (!raw) return '';
    if (ownerNormCache.has(raw)) return ownerNormCache.get(raw);
    const r = norm(raw);
    ownerNormCache.set(raw, r);
    return r;
  };

  const hfByRef = new Map();
  for (const row of (state.leadsData || [])) {
    const refRaw = String(row[refByField] || '').trim();
    if (!refRaw) continue;
    const key = norm(refRaw);
    const dateVal = parseDate(row[dateField]);
    const ownerStr = String(row[ownerLeadField] || '').trim();
    const branchStr = String(row[branchLeadField] || '').trim();
    if (!hfByRef.has(key)) hfByRef.set(key, { name: refRaw, allDates: [], leads: [] });
    const rec = hfByRef.get(key);
    if (dateVal) {
      rec.allDates.push(dateVal);
      rec.leads.push({ date: dateVal, owner: ownerStr, branch: branchStr });
    }
  }

  const hfOppOwnerMap = new Map();
  for (const row of (state.oppData || [])) {
    const refRaw = String(row[refByOppField] || '').trim();
    if (!refRaw) continue;
    const ownerRaw = String(row[ownerOppField] || '').trim();
    if (ownerRaw) hfOppOwnerMap.set(norm(refRaw), getNormOwner(ownerRaw));
  }

  const hfAllowedNorm = new Map(getAllowedOwners().map(o => [norm(o), o]));

  const mainClosings = calcLoanClosings(owner, start, end);
  const mainPipe     = calcPipelineActivity(owner, start, end);
  const mainHF       = calcHuntingFarmingForWindow(owner, mainHFBase, mainHFCutoff, hfByRef, hfOppOwnerMap, getNormOwner, hfAllowedNorm);
  const teamAvg      = calcTeamAvgHF(mainHFCutoff, mainHFBase, hfByRef, hfOppOwnerMap, getNormOwner, hfAllowedNorm);
  const mainCalls    = calcCalls(owner, start, end);
  const mainZoom     = calcZoom(owner, start, end);
  const mainLeads    = calcLeadsCreated(owner, start, end);

  const cmpClosings = hasCmp ? calcLoanClosings(owner, cmpBounds.start, cmpBounds.end) : null;
  const cmpPipe     = hasCmp ? calcPipelineActivity(owner, cmpBounds.start, cmpBounds.end) : null;
  const cmpCalls    = hasCmp ? calcCalls(owner, cmpBounds.start, cmpBounds.end) : null;
  const cmpZoom     = hasCmp ? calcZoom(owner, cmpBounds.start, cmpBounds.end) : null;
  const cmpLeads    = hasCmp ? calcLeadsCreated(owner, cmpBounds.start, cmpBounds.end) : null;
  const mainInvites = calcMeetingInvites(owner, start, end);
  const cmpInvites  = hasCmp ? calcMeetingInvites(owner, cmpBounds.start, cmpBounds.end) : null;

  // Comparison H/F window: fully-past month uses last day; current month uses same day as main cutoff
  let cmpHF = null, cmpHFCutoff = null, cmpHFBase = null, cmpHFLbl = '';
  if (hasCmp && state.leadsData && state.leadsData.length) {
    const cmpSorted = [...cmpMonths0].sort((a, b) => a - b);
    const lastCmpM = cmpSorted[cmpSorted.length - 1];
    const isCmpCurrent = cmpYear === today.getUTCFullYear() && cmpMonths0.includes(today.getUTCMonth());
    if (isCmpCurrent) {
      const dayOfMonth = mainHFCutoff.getUTCDate();
      const lastDayOfCmpMonth = new Date(Date.UTC(cmpYear, lastCmpM + 1, 0)).getUTCDate();
      cmpHFCutoff = new Date(Date.UTC(cmpYear, lastCmpM, Math.min(dayOfMonth, lastDayOfCmpMonth), 23, 59, 59, 999));
    } else {
      cmpHFCutoff = new Date(Date.UTC(cmpYear, lastCmpM + 1, 0, 23, 59, 59, 999));
    }
    cmpHFBase = new Date(cmpHFCutoff);
    cmpHFBase.setUTCDate(cmpHFBase.getUTCDate() - windowDays);
    cmpHF = calcHuntingFarmingForWindow(owner, cmpHFBase, cmpHFCutoff, hfByRef, hfOppOwnerMap, getNormOwner, hfAllowedNorm);
    cmpHFLbl = ('VS ' + MS_SHORT[lastCmpM] + ' ' + cmpYear + ' · ' + fmtShortDate(cmpHFBase) + ' → ' + fmtShortDate(cmpHFCutoff)).toUpperCase();
  }

  const closingGoal    = calcClosingGoal(months0);
  const closingGoalStr = closingGoal % 1 === 0 ? String(closingGoal) : closingGoal.toFixed(2);
  const closingPct     = closingGoal > 0 ? Math.round((mainClosings.count / closingGoal) * 100) : 0;
  const closingCol     = closingPct >= 100 ? '#085041' : closingPct >= 70 ? '#D4A000' : '#CC3030';
  const oppsGoal       = kpiGoals.pipelineOpps;
  const oppsPct        = oppsGoal > 0 ? Math.round((mainPipe.created / oppsGoal) * 100) : 0;
  const oppsCol        = oppsPct >= 100 ? '#085041' : oppsPct >= 70 ? '#D4A000' : '#CC3030';
  const cmpClosingPct  = hasCmp && closingGoal > 0 ? Math.round((cmpClosings.count / closingGoal) * 100) : null;
  const cmpOppsPct     = hasCmp && oppsGoal > 0 ? Math.round((cmpPipe.created / oppsGoal) * 100) : null;

  const total = mainHF.total || 1;
  const hPct = Math.round((mainHF.hunting / total) * 100);
  const fPct = Math.round((mainHF.farming / total) * 100);

  const mainLbl = pLabel(year, months0, today, false);
  const cmpLbl  = hasCmp ? pLabel(cmpYear, cmpMonths0, today, true) : '';

  // Populate modal cache
  _perfModalCache.clear();
  // Config de filtros reutilizables por tipo de modal
  const OPP_FILTERS = [
    { id: 'f-opp-stage', label: 'Stage', field: 'stage', allLabel: 'All Stages' },
    { id: 'f-opp-branch', label: 'Branch', field: 'branch', allLabel: 'All Branches' },
    { id: 'f-opp-lo', label: 'Loan Officer', field: 'loanOfficer', allLabel: 'All LOs' }
  ];
  const LEAD_FILTERS = [
    { id: 'f-lead-status', label: 'Lead Status', field: 'leadStatus', allLabel: 'All Status' },
    { id: 'f-lead-lo', label: 'Loan Officer', field: 'loanOfficer', allLabel: 'All LOs' }
  ];
  const PIPE_FILTERS = [
    { id: 'f-pipe-stage', label: 'Stage', field: 'stage', allLabel: 'All Stages' },
    { id: 'f-pipe-branch', label: 'Branch', field: 'branch', allLabel: 'All Branches' },
    { id: 'f-pipe-health', label: 'Health', field: 'healthiness', allLabel: 'All Health' }
  ];
  const withFilters = (m, containerId, filters, countLabel) => { if (m) { m.containerId = containerId; m.filters = filters; m.countLabel = countLabel; } return m; };
  const oppCount = n => n + ' opportunities';
  const leadCount = n => n + ' leads';
  _perfModalCache.set('mainLoan',          buildLoanModal(owner, start, end, mainLbl));
  _perfModalCache.set('mainPipe',          withFilters(buildPipelineModal(owner, start, end, mainLbl), 'perf-oppb2c-filters', OPP_FILTERS, oppCount));
  _perfModalCache.set('mainHunting',       buildHFModal(true,  mainHF.huntingRealtors, owner, mainLbl));
  _perfModalCache.set('mainFarming',       buildHFModal(false, mainHF.farmingRealtors, owner, mainLbl));
  _perfModalCache.set('mainZoomMeetings',  buildZoomMeetingsModal(mainZoom.meetingsDetail, owner, mainLbl));
  _perfModalCache.set('mainZoomExternals', buildZoomExternalsModal(mainZoom.externalsList, owner, mainLbl));
  _perfModalCache.set('mainLeads',         withFilters(buildLeadsModal(mainLeads.rows, owner, mainLbl), 'perf-leadsb2c-filters', LEAD_FILTERS, leadCount));
  _perfModalCache.set('leadRealtors',      buildLeadsRealtorsModal(mainLeads.rows, owner, mainLbl));
  if (hasCmp) {
    _perfModalCache.set('cmpLoan',          buildLoanModal(owner, cmpBounds.start, cmpBounds.end, cmpLbl));
    _perfModalCache.set('cmpPipe',          withFilters(buildPipelineModal(owner, cmpBounds.start, cmpBounds.end, cmpLbl), 'perf-oppb2c-filters', OPP_FILTERS, oppCount));
    _perfModalCache.set('cmpZoomMeetings',  buildZoomMeetingsModal(cmpZoom.meetingsDetail, owner, cmpLbl));
    _perfModalCache.set('cmpZoomExternals', buildZoomExternalsModal(cmpZoom.externalsList, owner, cmpLbl));
    _perfModalCache.set('cmpLeads',         withFilters(buildLeadsModal(cmpLeads.rows, owner, cmpLbl), 'perf-leadsb2c-filters', LEAD_FILTERS, leadCount));
    if (cmpHF) {
      _perfModalCache.set('cmpHunting', buildHFModal(true,  cmpHF.huntingRealtors, owner, cmpLbl));
      _perfModalCache.set('cmpFarming', buildHFModal(false, cmpHF.farmingRealtors, owner, cmpLbl));
    }
  }

  const callsRateColor = mainCalls.effectivenessRate > 20 ? 'green' : mainCalls.effectivenessRate >= 10 ? 'yellow' : 'red';
  const cmpCallsRateColor = cmpCalls ? (cmpCalls.effectivenessRate > 20 ? 'green' : cmpCalls.effectivenessRate >= 10 ? 'yellow' : 'red') : 'red';

  // ── Open Pipeline (snapshot: sin filtro de fechas) ──
  const openStageOrder = ['Need Analysis', 'Qualification', 'Proposal', 'Negotiation'];
  const openStageCat = raw => {
    const s = String(raw || '').toLowerCase();
    if (s.includes('need analysis') || s.includes('needs analysis')) return 'Need Analysis';
    if (s.includes('qualification')) return 'Qualification';
    if (s.includes('proposal')) return 'Proposal';
    if (s.includes('negotiation')) return 'Negotiation';
    return null;
  };
  const openStageRows = { 'Need Analysis': [], 'Qualification': [], 'Proposal': [], 'Negotiation': [] };
  const openPipeRealtorKeys = new Set();
  const openAllRows = [];
  let openPipeCount = 0, openPipeAmt = 0;
  for (const row of (state.oppData || [])) {
    if (norm(String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim()) !== norm(owner)) continue;
    const st = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    if (!st || st === 'closed won' || st === 'closed lost') continue;
    const cs = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (cs.includes('archive loan')) continue;
    const ld = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
    if (ld.includes('city lending inc')) continue;
    openPipeCount++;
    openPipeAmt += parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0;
    openAllRows.push(row);
    const cat = openStageCat(st);
    if (cat) openStageRows[cat].push(row);
    const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
    if (ref) openPipeRealtorKeys.add(norm(ref));
  }
  _healthCachePerf.clear();
  _healthCachePerf.set(owner, openAllRows);

  // ── Lost Opportunities: Closed Lost with a milestone date within the period ──
  const lostInRange = (d, s, e) => d && d >= s && d <= e;
  const lostActiveSet = new Set((state.activeResults || []).map(r => r.key));
  const lostInactiveSet = new Set((state.inactiveResults || []).map(r => r.key));
  const calcLost = (s, e) => {
    const byLO = new Map();
    const opps = [];
    let total = 0, volume = 0;
    const reached = { 'Reached Ratified': 0, 'Reached Pre-Approval': 0, 'Reached Pre-Qualification': 0 };
    for (const row of (state.oppData || [])) {
      if (norm(String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim()) !== norm(owner)) continue;
      if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed lost') continue;
      const ratifD = parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'));
      const preApprD = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre approved date', 'pre_approved_date'));
      const preQualD = parseDate(getField(row, 'Pre-Qualified Doc requested Date', 'pre-qualified doc requested date', 'pre_qualified_date'));
      const inRA = lostInRange(ratifD, s, e), inPA = lostInRange(preApprD, s, e), inPQ = lostInRange(preQualD, s, e);
      if (!inRA && !inPA && !inPQ) continue;
      reached[inRA ? 'Reached Ratified' : inPA ? 'Reached Pre-Approval' : 'Reached Pre-Qualification']++;
      const lo = String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer', 'loan officer') || '').trim() || '—';
      const amt = parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0;
      const g = byLO.get(lo) || { count: 0, volume: 0 };
      g.count++; g.volume += amt; byLO.set(lo, g);
      total++; volume += amt;
      const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
      const rkey = ref ? norm(ref) : '';
      opps.push({
        lnNum: String(getField(row, 'Loan #', 'loan #') || '—').trim(),
        oppName: String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim(),
        realtor: ref || 'Unknown Realtor', hasRef: !!ref,
        status: ref ? (lostActiveSet.has(rkey) ? 'active' : lostInactiveSet.has(rkey) ? 'inactive' : 'unknown') : 'unknown',
        branch: String(getField(row, 'Branch', 'branch') || '').trim() || '—',
        lo, preQualD, preApprD, ratifD,
        reached: inRA ? 'Ratified' : inPA ? 'Pre-Approval' : 'Pre-Qual',
        amt
      });
    }
    const rows = [...byLO.entries()].map(([lo, v]) => ({ lo, count: v.count, volume: v.volume })).sort((a, b) => b.count - a.count);
    return { total, volume, reached, rows, opps };
  };
  const mainLost = calcLost(start, end);
  const cmpLost = hasCmp ? calcLost(cmpBounds.start, cmpBounds.end) : null;
  const lostTotal = mainLost.total, lostVolume = mainLost.volume, lostRows = mainLost.rows, lostReached = mainLost.reached;
  const lostReachedHtml = '<div>' +
    [['Reached Ratified', lostReached['Reached Ratified'], 'pls-ratified'],
     ['Reached Pre-Approval', lostReached['Reached Pre-Approval'], 'pls-preappr'],
     ['Reached Pre-Qual', lostReached['Reached Pre-Qualification'], 'pls-prequal']]
      .filter(d => d[1] > 0)
      .map(d => '<div class="perf-lost-stage ' + d[2] + '"><span>' + d[0] + '</span><span class="pls-count">' + d[1] + '</span></div>')
      .join('') +
  '</div>';

  const lostStatusChip = st => st === 'active'
    ? '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#E1F5EE;color:#085041">Active</span>'
    : st === 'inactive'
      ? '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#FEF3C7;color:#B45309">Inactive</span>'
      : '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#F1F5F9;color:#94A3B8">Unknown</span>';
  const lostStageChip = st => st === 'Ratified'
    ? '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#FEE2E2;color:#991B1B">Ratified</span>'
    : st === 'Pre-Approval'
      ? '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#FFF1F2;color:#BE123C">Pre-Approval</span>'
      : '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#FEF9C3;color:#854D0E">Pre-Qual</span>';
  const lostStageOrder = { 'Ratified': 2, 'Pre-Approval': 1, 'Pre-Qual': 0 };
  const lostModalRows = [...mainLost.opps].sort((a, b) => {
    const so = lostStageOrder[b.reached] - lostStageOrder[a.reached];
    return so !== 0 ? so : b.amt - a.amt;
  });
  const lostRenderRow = e =>
    '<tr>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
      '<td style="font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis" title="' + e.oppName + '">' + e.oppName + '</td>' +
      '<td style="font-weight:600' + (e.hasRef ? '' : ';color:#B45309') + '">' + e.realtor + '</td>' +
      '<td>' + lostStatusChip(e.status) + '</td>' +
      '<td style="font-size:11px">' + e.branch + '</td>' +
      '<td style="font-size:11px">' + e.lo + '</td>' +
      '<td class="dt">' + (e.preQualD ? fmtDate(e.preQualD) : '—') + '</td>' +
      '<td class="dt">' + (e.preApprD ? fmtDate(e.preApprD) : '—') + '</td>' +
      '<td class="dt">' + (e.ratifD ? fmtDate(e.ratifD) : '—') + '</td>' +
      '<td>' + lostStageChip(e.reached) + '</td>' +
    '</tr>';
  _perfModalCache.set('lostOpps', {
    title: owner + ' — Lost Opportunities',
    sub: lostTotal + ' opportunit' + (lostTotal !== 1 ? 'ies' : 'y') + ' · ' + mainLbl,
    head: '<tr><th>Loan #</th><th>Opportunity Name</th><th>Realtor</th><th>Realtor Status</th><th>Branch</th><th>Loan Officer</th><th>Pre-Qual Date</th><th>Pre-Approval Date</th><th>Ratified Date</th><th>Stage Reached</th></tr>',
    body: lostModalRows.map(lostRenderRow).join(''),
    rows: lostModalRows,
    renderRow: lostRenderRow,
    containerId: 'perf-lost-filters',
    filters: [
      { id: 'f-lost-stage', label: 'Stage Reached', field: e => e.reached, allLabel: 'All Stages' },
      { id: 'f-lost-lo', label: 'Loan Officer', field: e => e.lo, allLabel: 'All LOs' }
    ],
    countLabel: n => n + ' lost opportunities',
    csvData: [
      ['Loan #', 'Opportunity Name', 'Realtor', 'Realtor Status', 'Branch', 'Loan Officer', 'Pre-Qual Date', 'Pre-Approval Date', 'Ratified Date', 'Stage Reached'],
      ...lostModalRows.map(e => [e.lnNum, e.oppName, e.realtor, e.status, e.branch === '—' ? '' : e.branch, e.lo === '—' ? '' : e.lo, e.preQualD ? fmtDate(e.preQualD) : '', e.preApprD ? fmtDate(e.preApprD) : '', e.ratifD ? fmtDate(e.ratifD) : '', e.reached]),
      ['TOTAL', '', '', '', '', '', '', '', '', lostTotal + ' opps']
    ]
  });

  // ── Local view helpers (solo HTML) ──
  const rangeStr = (s, e) => MS_SHORT[s.getUTCMonth()] + ' ' + s.getUTCDate() + ' – ' + MS_SHORT[e.getUTCMonth()] + ' ' + e.getUTCDate() + ', ' + e.getUTCFullYear();
  const mainRange = rangeStr(start, end);
  const cmpSorted = [...cmpMonths0].sort((a, b) => a - b);
  const cmpShort = hasCmp ? ((cmpSorted.length === 1 ? MS_SHORT[cmpSorted[0]] : MS_SHORT[cmpSorted[0]] + '–' + MS_SHORT[cmpSorted[cmpSorted.length - 1]]) + ' ' + cmpYear) : '';
  const mainMSorted = [...months0].sort((a, b) => a - b);
  const mainShort = (mainMSorted.length === 1 ? MS_SHORT[mainMSorted[0]] : MS_SHORT[mainMSorted[0]] + '–' + MS_SHORT[mainMSorted[mainMSorted.length - 1]]) + ' ' + year;

  const trendBadge = (main, cmp, fmt) => {
    if (!hasCmp || cmp === null || cmp === undefined) return '';
    const f = fmt || (v => String(v));
    const diff = main - cmp;
    if (diff === 0) {
      return '<span class="perf-trend-badge perf-trend-neutral">&#8594; no change vs ' + cmpShort + ' <span style="opacity:0.75">(' + f(cmp) + ')</span></span>';
    }
    const up = diff > 0;
    const delta = (up ? '+' : '-') + f(Math.abs(diff));
    return '<span class="perf-trend-badge ' + (up ? 'perf-trend-up' : 'perf-trend-down') + '">' +
      (up ? '&#8593; ' : '&#8595; ') + delta + ' vs ' + cmpShort + ' <span style="opacity:0.75">(was ' + f(cmp) + ')</span></span>';
  };

  const valBtn = (modalKey, val, color) =>
    '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left' + (color ? ';color:' + color : '') + '" data-perf-modal="' + modalKey + '" title="Click to view detailed breakdown">' + val + '</button>';

  const lostTableHtml = () => {
    const rowHtml = r => '<tr><td>' + r.lo + '</td><td style="text-align:center;font-weight:700">' + r.count + '</td></tr>';
    const head = '<thead><tr><th>Loan Officer</th><th style="text-align:center"># Lost</th></tr></thead>';
    const top = lostRows.slice(0, 3).map(rowHtml).join('');
    const rest = lostRows.slice(3);
    let html = '<table class="perf-lost-table">' + head + '<tbody>' + top + '</tbody></table>';
    if (rest.length) {
      html += '<details style="margin-top:4px">' +
        '<summary style="cursor:pointer;font-size:11px;color:#1D6FA4;font-weight:600;padding:4px 0" onclick="this.style.display=\'none\'">Show all (' + lostRows.length + ' LOs)</summary>' +
        '<table class="perf-lost-table"><tbody>' + rest.map(rowHtml).join('') + '</tbody></table>' +
      '</details>';
    }
    return html;
  };

  // ── Leads Received: breakdown por Lead Status ──
  const leadCatOf = row => {
    const s = String(getField(row, 'Lead Status', 'lead status') || '').toLowerCase();
    const cv = getField(row, 'Converted', 'converted');
    if (cv === true || String(cv).toLowerCase() === 'true') return 'Converted';
    if (/discard|unqualified|dead|lost/.test(s)) return 'Discarded';
    if (/qualified|converted/.test(s)) return 'Converted';
    if (s.includes('new')) return 'New';
    if (s.includes('working')) return 'Working';
    if (s.includes('hold')) return 'On Hold';
    return 'Other';
  };
  const leadCats = { New: 0, Working: 0, 'On Hold': 0, Discarded: 0, Converted: 0, Other: 0 };
  for (const row of (mainLeads.rows || [])) leadCats[leadCatOf(row)]++;
  const leadCatOrder = [['New', 'plb-new'], ['Working', 'plb-working'], ['On Hold', 'plb-onhold'], ['Discarded', 'plb-discarded'], ['Converted', 'plb-converted'], ['Other', 'plb-other']];
  const leadsBreakdownHtml = '<div class="perf-leads-breakdown">' +
    leadCatOrder.filter(([k]) => leadCats[k] > 0).map(([k, cls]) =>
      '<div class="perf-leads-breakdown-row ' + cls + '"><span class="plb-label">' + k + '</span><span class="plb-count">' + leadCats[k] + '</span></div>'
    ).join('') + '</div>';
  const convRate = mainLeads.count ? (leadCats.Converted / mainLeads.count * 100) : 0;
  const convRateHtml = '<div class="perf-conversion-rate"><span class="pcr-label">Conversion rate</span><span class="pcr-value">' + convRate.toFixed(1) + '%</span></div>';

  // ── Calls: breakdown por RecordType ──
  const callsTypeStyle = rt => {
    const n = norm(rt);
    if (n === 'realtor') return { label: 'To Realtors', cls: ' plb-working', bg: '' };
    if (n === 'borrower') return { label: 'To Borrowers', cls: ' plb-new', bg: '' };
    if (n === 'loan officer' || n === 'lo') return { label: 'To LOs', cls: '', bg: '#F5F3FF' };
    if (n === 'unknown' || n === '') return { label: 'Unknown', cls: ' plb-other', bg: '' };
    return { label: rt, cls: ' plb-other', bg: '' };
  };
  const callsBreakdownHtml = '<div class="perf-leads-breakdown">' +
    [...mainCalls.byType.entries()].sort((a, b) => b[1] - a[1]).map(([rt, cnt]) => {
      const st = callsTypeStyle(rt);
      return '<div class="perf-leads-breakdown-row' + st.cls + '"' + (st.bg ? ' style="background:' + st.bg + '"' : '') + '><span class="plb-label">' + st.label + '</span><span class="plb-count">' + cnt + '</span></div>';
    }).join('') +
    '</div>';

  // ── Zoom & Meetings Activity: breakdown + modals ──
  const invitePct = mainInvites.invitesSent > 0 ? Math.round(mainInvites.meetingAttended / mainInvites.invitesSent * 100) : 0;
  const meetBreakdownHtml = '<div class="perf-leads-breakdown">' +
    '<div class="perf-leads-breakdown-row plb-new" style="cursor:pointer" data-perf-modal="meetingInvites" title="Click to view detailed breakdown"><span class="plb-label">Invites Sent</span><span class="plb-count">' + mainInvites.invitesSent + '</span></div>' +
    '<div class="perf-leads-breakdown-row plb-working" style="cursor:pointer" data-perf-modal="meetingAttended" title="Click to view detailed breakdown"><span class="plb-label">Attended <span style="font-size:9px;color:#94A3B8;font-weight:400">(' + invitePct + '% of invites)</span></span><span class="plb-count">' + mainInvites.meetingAttended + '</span></div>' +
    '<div class="perf-leads-breakdown-row plb-converted" style="cursor:pointer" data-perf-modal="meetingLeads" title="Click to view detailed breakdown"><span class="plb-label">Leads Referred</span><span class="plb-count">' + mainInvites.leadsReferred + '</span></div>' +
  '</div>';
  const mcRate = parseFloat(mainInvites.conversionRate);
  const mcColor = mcRate > 30 ? '#065F46' : mcRate >= 15 ? '#B45309' : '#BE123C';
  const mcBg = mcRate > 30 ? '#F0FDF4' : mcRate >= 15 ? '#FFFBEB' : '#FFF1F2';
  const meetConvHtml = '<div class="perf-conversion-rate" style="background:' + mcBg + ';border-left-color:' + mcColor + ';justify-content:flex-start"><span class="pcr-label" style="color:' + mcColor + '">' + mainInvites.conversionRate + '% realtors referred leads after meeting</span></div>';

  const meetCols = ['Realtor Name', 'Branch', 'Loan Officers', 'Meeting Attended Date', 'Invite Sent Date', 'NPPM', '# Leads', 'First Lead'];
  const leadActivityHtml = r => r.leadCount > 0
    ? '<td style="font-size:11px"><div>' + fmtDate(r.firstLeadDate) + ' → ' + fmtDate(r.lastLeadDate) + '</div><div style="font-size:9px;color:#94A3B8">' + r.leadCount + ' leads total</div></td>'
    : '<td style="color:#94A3B8;font-size:11px">No leads yet</td>';
  const leadActivityCsv = r => r.leadCount > 0 ? fmtDate(r.firstLeadDate) + ' → ' + fmtDate(r.lastLeadDate) + ' (' + r.leadCount + ')' : 'No leads yet';
  const meetRowHtml = r =>
    '<tr>' +
      '<td style="font-weight:600">' + r.name + '</td>' +
      '<td style="font-size:11px">' + r.branch + '</td>' +
      '<td style="font-size:11px">' + r.loanOfficer + '</td>' +
      '<td class="dt">' + (r.attendD ? fmtDate(r.attendD) : '—') + '</td>' +
      '<td class="dt">' + (r.inviteD ? fmtDate(r.inviteD) : '—') + '</td>' +
      '<td style="text-align:center">' + (r.nppm ? '<span style="color:#6D28D9;font-weight:700">Yes</span>' : '<span style="color:#8899BB">—</span>') + '</td>' +
      '<td style="text-align:center;font-weight:700">' + (r.leadCount > 0 ? r.leadCount : '—') + '</td>' +
      '<td class="dt">' + (r.firstLeadDate ? fmtDate(r.firstLeadDate) : '—') + '</td>' +
    '</tr>';
  const meetCsvRow = r => [r.name, r.branch, r.loanOfficer, r.attendD ? fmtDate(r.attendD) : '', r.inviteD ? fmtDate(r.inviteD) : '', r.nppm ? 'Yes' : '', r.leadCount > 0 ? r.leadCount : '', r.firstLeadDate ? fmtDate(r.firstLeadDate) : ''];
  const meetHead = '<tr>' + meetCols.map(c => '<th>' + c + '</th>').join('') + '</tr>';

  const invitesSorted = [...mainInvites.invitesList].sort((a, b) => {
    const aa = a.attendD ? 1 : 0, ba = b.attendD ? 1 : 0;
    if (ba !== aa) return ba - aa;
    return (b.inviteD || 0) - (a.inviteD || 0);
  });
  _perfModalCache.set('meetingInvites', {
    title: owner + ' — Meeting Invites Sent',
    sub: mainInvites.invitesSent + ' realtor' + (mainInvites.invitesSent !== 1 ? 's' : '') + ' · ' + mainLbl,
    head: meetHead, body: invitesSorted.map(meetRowHtml).join(''),
    csvData: [meetCols, ...invitesSorted.map(meetCsvRow)]
  });

  const attendedSorted = [...mainInvites.attendedList].sort((a, b) => {
    if (b.leadCount !== a.leadCount) return b.leadCount - a.leadCount;
    return (b.attendD || 0) - (a.attendD || 0);
  });
  _perfModalCache.set('meetingAttended', {
    title: owner + ' — Meetings Attended',
    sub: mainInvites.meetingAttended + ' realtor' + (mainInvites.meetingAttended !== 1 ? 's' : '') + ' · ' + mainLbl,
    head: meetHead, body: attendedSorted.map(meetRowHtml).join(''),
    csvData: [meetCols, ...attendedSorted.map(meetCsvRow)]
  });

  const nppmList = attendedSorted.filter(r => r.nppm);
  const nppmCols = ['Realtor', 'Branch', 'Loan Officer', 'Meeting Attended Date', 'Lead Activity'];
  _perfModalCache.set('meetingNPPM', {
    title: owner + ' — NPPM Realtors',
    sub: nppmList.length + ' realtor' + (nppmList.length !== 1 ? 's' : '') + ' · ' + mainLbl,
    head: '<tr>' + nppmCols.map(c => '<th>' + c + '</th>').join('') + '</tr>',
    body: nppmList.map(r => '<tr><td style="font-weight:600">' + r.name + '</td><td style="font-size:11px">' + r.branch + '</td><td style="font-size:11px">' + r.loanOfficer + '</td><td class="dt">' + (r.attendD ? fmtDate(r.attendD) : '—') + '</td>' + leadActivityHtml(r) + '</tr>').join(''),
    csvData: [nppmCols, ...nppmList.map(r => [r.name, r.branch, r.loanOfficer, r.attendD ? fmtDate(r.attendD) : '', leadActivityCsv(r)])]
  });

  const meetLeadRows = [];
  for (const r of mainInvites.attendedList) {
    for (const lr of r.leads) {
      meetLeadRows.push({
        realtor: r.name, branch: r.branch, lo: r.loanOfficer, attendD: r.attendD,
        leadName: (String(getField(lr, 'First Name', 'first name') || '').trim() + ' ' + String(getField(lr, 'Last Name', 'last name') || '').trim()).trim() || '—',
        status: String(getField(lr, 'Lead Status', 'lead status') || '—').trim(),
        created: parseDate(getField(lr, 'Created Date', 'created date', 'Create Date', 'create date')),
        converted: (() => { const v = getField(lr, 'Converted', 'converted'); return v === true || String(v).toLowerCase() === 'true'; })()
      });
    }
  }
  meetLeadRows.sort((a, b) => { const n = a.realtor.localeCompare(b.realtor); if (n !== 0) return n; return (b.created || 0) - (a.created || 0); });
  const meetLeadCols = ['Realtor Name', 'Branch', 'Loan Officer', 'Meeting Attended Date', 'Lead Name', 'Lead Status', 'Created Date', 'Converted'];
  _perfModalCache.set('meetingLeads', {
    title: owner + ' — Leads Referred After Meeting',
    sub: meetLeadRows.length + ' lead' + (meetLeadRows.length !== 1 ? 's' : '') + ' · ' + mainLbl,
    head: '<tr>' + meetLeadCols.map(c => '<th>' + c + '</th>').join('') + '</tr>',
    body: meetLeadRows.map(e => '<tr><td style="font-weight:600">' + e.realtor + '</td><td style="font-size:11px">' + e.branch + '</td><td style="font-size:11px">' + e.lo + '</td><td class="dt">' + (e.attendD ? fmtDate(e.attendD) : '—') + '</td><td>' + e.leadName + '</td><td style="font-size:11px">' + e.status + '</td><td class="dt">' + fmtDate(e.created) + '</td><td style="text-align:center">' + (e.converted ? '<span style="color:#085041;font-weight:700">Yes</span>' : '<span style="color:#8899BB">No</span>') + '</td></tr>').join(''),
    csvData: [meetLeadCols, ...meetLeadRows.map(e => [e.realtor, e.branch, e.lo, e.attendD ? fmtDate(e.attendD) : '', e.leadName, e.status, fmtDate(e.created), e.converted ? 'Yes' : 'No'])]
  });

  // ── Opportunities Created: breakdown por stage + modal de realtors ──
  const oppCreatedRows = (state.oppData || []).filter(row => {
    if (norm(String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim()) !== norm(owner)) return false;
    const cd = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    return cd && cd >= start && cd <= end;
  });
  const oppStageCat = raw => {
    const s = String(raw || '').toLowerCase();
    if (s.includes('need analysis') || s.includes('needs analysis')) return 'Need Analysis';
    if (s.includes('qualification')) return 'Qualification';
    if (s.includes('proposal')) return 'Proposal';
    if (s.includes('negotiation')) return 'Negotiation';
    if (s.includes('closed won')) return 'Closed Won';
    if (s.includes('closed lost')) return 'Closed Lost';
    return 'Others';
  };
  const oppStageOrder = ['Need Analysis', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost', 'Others'];
  const oppStageStyle = {
    'Need Analysis': { cls: ' plb-new', bg: '' },
    'Qualification': { cls: ' plb-working', bg: '' },
    'Proposal': { cls: ' plb-proposal', bg: '' },
    'Negotiation': { cls: ' plb-negotiation', bg: '' },
    'Closed Won': { cls: '', bg: '#F0FDF4' },
    'Closed Lost': { cls: ' plb-discarded', bg: '' },
    'Others': { cls: ' plb-other', bg: '' }
  };
  const oppStageCounts = {};
  oppStageOrder.forEach(k => oppStageCounts[k] = 0);
  const oppRealtorMap = new Map();
  let oppUnknown = null;
  const oppLoOf = row => String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '').trim();
  for (const row of oppCreatedRows) {
    const cat = oppStageCat(getField(row, 'Stage', 'stage'));
    oppStageCounts[cat]++;
    const lo = oppLoOf(row);
    const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
    let r;
    if (!ref) {
      if (!oppUnknown) { oppUnknown = { name: 'Unknown Realtor', total: 0, cats: {}, loMap: new Map(), unknown: true }; oppStageOrder.forEach(k => oppUnknown.cats[k] = 0); }
      r = oppUnknown;
    } else {
      const key = norm(ref);
      r = oppRealtorMap.get(key);
      if (!r) { r = { name: ref, key, total: 0, cats: {}, loMap: new Map() }; oppStageOrder.forEach(k => r.cats[k] = 0); oppRealtorMap.set(key, r); }
    }
    r.total++;
    r.cats[cat]++;
    if (lo) r.loMap.set(lo, (r.loMap.get(lo) || 0) + 1);
  }
  const totalOpps = oppCreatedRows.length;
  const oppRealtorRows = [...oppRealtorMap.values()].sort((a, b) => b.total - a.total);
  const oppUniqueRealtors = oppRealtorRows.length;
  const oppUnknownCount = oppUnknown ? oppUnknown.total : 0;
  const oppPctLost = totalOpps ? (oppStageCounts['Closed Lost'] / totalOpps * 100) : 0;

  const oppBreakdownHtml = '<div class="perf-leads-breakdown">' +
    oppStageOrder.filter(k => oppStageCounts[k] > 0).map(k => {
      const st = oppStageStyle[k];
      return '<div class="perf-leads-breakdown-row' + st.cls + '"' + (st.bg ? ' style="background:' + st.bg + '"' : '') + '>' +
        '<span class="plb-label">' + k + '</span><span class="plb-count">' + oppStageCounts[k] + '</span></div>';
    }).join('') +
    '<div class="perf-leads-breakdown-row plb-pct-lost">' +
      '<span class="plb-label">% Lost</span>' +
      '<span class="plb-count">' + oppPctLost.toFixed(1) + '%</span>' +
    '</div>' +
  '</div>';

  const oppStageCols = ['Need Analysis', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
  const lostColorOf = p => p > 30 ? '#BE123C' : p >= 15 ? '#B45309' : '#065F46';
  const loSorted = loMap => (loMap && loMap.size) ? [...loMap.entries()].sort((a, b) => b[1] - a[1]) : [];
  const loDisplay = loMap => {
    const s = loSorted(loMap);
    if (!s.length) return '—';
    return s.length > 1 ? s[0][0] + ' <span style="color:#94A3B8">(+' + (s.length - 1) + ' more)</span>' : s[0][0];
  };
  const loPlain = loMap => {
    const s = loSorted(loMap);
    if (!s.length) return '—';
    return s.length > 1 ? s[0][0] + ' (+' + (s.length - 1) + ' more)' : s[0][0];
  };
  // ─── Drill-down helpers (celda clickeable → tabla filtrada dentro del modal, botón ← Back) ───
  _perfDrill.clear();
  const _gf = (row, ...a) => String(getField(row, ...a) || '—').trim();
  const _amt = row => parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0;
  const _fmtAmt = a => a ? '$' + a.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
  const _dcell = v => '<td class="dt">' + fmtDate(parseDate(v)) + '</td>';
  // 2A — Opportunities B2C: detalle de opps por realtor
  const drillOppsCreatedTable = rows => {
    const cols = ['Loan #', 'Opportunity Name', 'Realtor', 'Loan Officer', 'BD Owner', 'Stage', 'Pre-Approval Date', 'Ratified Date', 'Est. Closing Date', 'Disbursement Date', 'Created Date', 'Loan Amount'];
    const head = '<tr>' + cols.map(c => '<th' + (c === 'Loan Amount' ? ' style="text-align:right"' : '') + '>' + c + '</th>').join('') + '</tr>';
    const body = rows.map(row => '<tr>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + _gf(row, 'Loan #', 'loan #') + '</td>' +
      '<td style="font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis">' + _gf(row, 'Opportunity Name', 'opportunity name') + '</td>' +
      '<td>' + _gf(row, 'Referred By', 'referred by') + '</td>' +
      '<td style="font-size:11px">' + _gf(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') + '</td>' +
      '<td style="font-size:11px">' + _gf(row, 'Opportunity Owner', 'opportunity owner') + '</td>' +
      '<td style="font-size:11px">' + _gf(row, 'Stage', 'stage') + '</td>' +
      _dcell(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date')) +
      _dcell(getField(row, 'Ratified Date', 'ratified date', 'ratified_date')) +
      _dcell(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'Close Date', 'close date')) +
      _dcell(getField(row, 'Disbursement Date', 'disbursement date')) +
      _dcell(getField(row, 'Created Date', 'created date', 'Create Date', 'create date')) +
      '<td class="modal-amount" style="text-align:right">' + _fmtAmt(_amt(row)) + '</td>' +
    '</tr>').join('');
    return '<table class="modal-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  };
  // Registrar drill por realtor (2A)
  for (const r of oppRealtorRows) {
    _perfDrill.set('oppReal:' + r.key, {
      title: r.name + ' — Opportunities Detail',
      subtitle: r.total + ' opportunit' + (r.total !== 1 ? 'ies' : 'y'),
      build: () => drillOppsCreatedTable(oppCreatedRows.filter(row => norm(String(getField(row, 'Referred By', 'referred by') || '')) === r.key))
    });
  }
  const oppModalRows = oppUnknown ? [...oppRealtorRows, oppUnknown] : oppRealtorRows;
  const oppRealtorHead = '<tr><th>Realtor</th><th>Loan Officer</th><th style="text-align:center">Total</th>' +
    oppStageCols.map(c => '<th style="text-align:center">' + c + '</th>').join('') +
    '<th style="text-align:center">% of Total</th><th style="text-align:center">% Lost</th></tr>';
  const oppRealtorBody = oppModalRows.map(r => {
    const pot = totalOpps ? (r.total / totalOpps * 100) : 0;
    const rl = r.total ? (r.cats['Closed Lost'] / r.total * 100) : 0;
    return '<tr' + (r.unknown ? ' style="background:#FFFBE6"' : '') + '>' +
      '<td style="font-weight:600' + (r.unknown ? ';color:#B45309' : '') + '">' + r.name + '</td>' +
      '<td style="font-size:11px">' + loDisplay(r.loMap) + '</td>' +
      '<td style="text-align:center;font-weight:700' + (r.key ? ';cursor:pointer;text-decoration:underline;color:#1D4ED8' : '') + '"' + (r.key ? ' data-drill-perf="oppReal:' + r.key + '"' : '') + '>' + r.total + '</td>' +
      oppStageCols.map(c => '<td style="text-align:center">' + r.cats[c] + '</td>').join('') +
      '<td style="text-align:center">' + pot.toFixed(1) + '%</td>' +
      '<td style="text-align:center;font-weight:700;color:' + lostColorOf(rl) + '">' + rl.toFixed(1) + '%</td>' +
    '</tr>';
  }).join('');
  const oppSumTotal = oppModalRows.reduce((s, r) => s + r.total, 0);
  const oppSumStage = {};
  oppStageCols.forEach(c => oppSumStage[c] = oppModalRows.reduce((s, r) => s + r.cats[c], 0));
  const oppTotalPctLost = oppSumTotal ? (oppSumStage['Closed Lost'] / oppSumTotal * 100) : 0;
  const oppRealtorTotals = '<tr style="background:#0B192C;font-family:\'Barlow\',sans-serif;font-weight:700">' +
    '<td style="color:white">TOTAL</td>' +
    '<td style="color:white"></td>' +
    '<td style="text-align:center;color:white">' + oppSumTotal + '</td>' +
    oppStageCols.map(c => '<td style="text-align:center;color:white">' + oppSumStage[c] + '</td>').join('') +
    '<td style="text-align:center;color:white">100%</td>' +
    '<td style="text-align:center;color:white">' + oppTotalPctLost.toFixed(1) + '%</td>' +
  '</tr>';
  _perfModalCache.set('oppRealtors', {
    title: 'Realtors — Opportunities Breakdown',
    sub: oppUniqueRealtors + ' realtor' + (oppUniqueRealtors !== 1 ? 's' : '') + (oppUnknownCount ? ' · ' + oppUnknownCount + ' unknown' : '') + ' · ' + owner + ' · ' + mainLbl,
    head: oppRealtorHead,
    body: oppRealtorBody + oppRealtorTotals,
    csvData: [
      ['Realtor', 'Loan Officer', 'Total', ...oppStageCols, '% of Total', '% Lost'],
      ...oppModalRows.map(r => {
        const pot = totalOpps ? (r.total / totalOpps * 100) : 0;
        const rl = r.total ? (r.cats['Closed Lost'] / r.total * 100) : 0;
        return [r.name, loPlain(r.loMap), r.total, ...oppStageCols.map(c => r.cats[c]), pot.toFixed(1) + '%', rl.toFixed(1) + '%'];
      }),
      ['TOTAL', '', oppSumTotal, ...oppStageCols.map(c => oppSumStage[c]), '100%', oppTotalPctLost.toFixed(1) + '%']
    ]
  });

  // ── Open Pipeline: realtors (active/inactive), loan officers, stage breakdown ──
  const pipeActiveSet = new Set((state.activeResults || []).map(r => r.key));
  const pipeInactiveSet = new Set((state.inactiveResults || []).map(r => r.key));
  const pipeStageCols = ['Need Analysis', 'Qualification', 'Proposal', 'Negotiation'];
  const emptyStageObj = () => ({ 'Need Analysis': 0, 'Qualification': 0, 'Proposal': 0, 'Negotiation': 0 });
  // Drill-down de Open Pipeline B2C (2B loan officers / 2C realtors): tabla de opps abiertas
  const pipeStatusOf = ref => {
    const k = norm(String(ref || ''));
    return pipeActiveSet.has(k)
      ? '<span style="font-weight:700;font-size:11px;color:#085041">Active</span>'
      : pipeInactiveSet.has(k)
        ? '<span style="font-weight:700;font-size:11px;color:#B45309">Inactive</span>'
        : '<span style="font-weight:700;font-size:11px;color:#8899BB">Unknown</span>';
  };
  const drillOpenPipeTable = rows => {
    const cols = ['Loan #', 'Realtor', 'Realtor Status', 'Branch', 'BD Owner', 'Stage', 'Health Status', 'Created Date', 'Pre-Approval Date', 'Ratified Date', 'Est. Closing Date', 'Loan Amount'];
    const head = '<tr>' + cols.map(c => '<th' + (c === 'Loan Amount' ? ' style="text-align:right"' : '') + '>' + c + '</th>').join('') + '</tr>';
    const body = rows.map(row => '<tr>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + _gf(row, 'Loan #', 'loan #') + '</td>' +
      '<td style="font-weight:600">' + _gf(row, 'Referred By', 'referred by') + '</td>' +
      '<td>' + pipeStatusOf(getField(row, 'Referred By', 'referred by')) + '</td>' +
      '<td style="font-size:11px">' + _gf(row, 'Branch', 'branch') + '</td>' +
      '<td style="font-size:11px">' + _gf(row, 'Opportunity Owner', 'opportunity owner') + '</td>' +
      '<td style="font-size:11px">' + _gf(row, 'Stage', 'stage') + '</td>' +
      '<td>' + healthChipHtml(getField(row, 'Healthiness', 'healthiness')) + '</td>' +
      _dcell(getField(row, 'Created Date', 'created date', 'Create Date', 'create date')) +
      _dcell(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date')) +
      _dcell(getField(row, 'Ratified Date', 'ratified date', 'ratified_date')) +
      _dcell(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'Close Date', 'close date')) +
      '<td class="modal-amount" style="text-align:right">' + _fmtAmt(_amt(row)) + '</td>' +
    '</tr>').join('');
    return '<table class="modal-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  };

  const pipeRealtorMap = new Map();
  const pipeLoMap = new Map();
  let pipeNoLo = null;
  for (const row of openAllRows) {
    const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
    const lo = String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '').trim();
    const cat = openStageCat(getField(row, 'Stage', 'stage'));
    if (ref) {
      const key = norm(ref);
      let r = pipeRealtorMap.get(key);
      if (!r) { r = { name: ref, key, total: 0, cats: emptyStageObj(), loMap: new Map() }; pipeRealtorMap.set(key, r); }
      r.total++;
      if (cat) r.cats[cat]++;
      if (lo) r.loMap.set(lo, (r.loMap.get(lo) || 0) + 1);
    }
    let g;
    if (!lo) { if (!pipeNoLo) pipeNoLo = { name: 'No LO Assigned', total: 0, cats: emptyStageObj(), realtorKeys: new Set(), noLo: true }; g = pipeNoLo; }
    else { const lk = norm(lo); g = pipeLoMap.get(lk); if (!g) { g = { name: lo, total: 0, cats: emptyStageObj(), realtorKeys: new Set() }; pipeLoMap.set(lk, g); } }
    g.total++;
    if (cat) g.cats[cat]++;
    if (ref) g.realtorKeys.add(norm(ref));
  }

  // Registrar drill por realtor (2C) y por loan officer (2B) en la caché de drill-down
  for (const r of pipeRealtorMap.values()) {
    _perfDrill.set('pipeReal:' + r.key, {
      title: r.name + ' — Open Pipeline Detail',
      subtitle: r.total + ' open opportunit' + (r.total !== 1 ? 'ies' : 'y'),
      build: () => drillOpenPipeTable(openAllRows.filter(row => norm(String(getField(row, 'Referred By', 'referred by') || '')) === r.key))
    });
  }
  const _loDrillId = g => g.noLo ? 'noLo' : norm(g.name);
  for (const g of [...pipeLoMap.values(), ...(pipeNoLo ? [pipeNoLo] : [])]) {
    _perfDrill.set('pipeLo:' + _loDrillId(g), {
      title: g.name + ' — Open Pipeline Detail',
      subtitle: g.total + ' open opportunit' + (g.total !== 1 ? 'ies' : 'y'),
      build: () => drillOpenPipeTable(openAllRows.filter(row => {
        const l = String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '').trim();
        return g.noLo ? !l : norm(l) === norm(g.name);
      }))
    });
  }

  const lastLeadByKey = new Map();
  for (const lr of (state.leadsData || [])) {
    const ref = getField(lr, 'Referred By', 'referred by');
    if (!ref) continue;
    const k = norm(String(ref));
    if (!pipeRealtorMap.has(k)) continue;
    const cd = parseDate(getField(lr, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (cd) { const cur = lastLeadByKey.get(k); if (!cur || cd > cur) lastLeadByKey.set(k, cd); }
  }

  let pipeActive = 0, pipeInactive = 0;
  for (const k of pipeRealtorMap.keys()) {
    if (pipeActiveSet.has(k)) pipeActive++;
    else if (pipeInactiveSet.has(k)) pipeInactive++;
  }
  const pipeLoCount = pipeLoMap.size;

  const pipeDaysColor = d => d == null ? '#64748B' : d < 30 ? '#065F46' : d <= 60 ? '#B45309' : '#BE123C';
  const buildPipeRealtorModal = (keySet, word) => {
    const rows = [...pipeRealtorMap.values()].filter(r => keySet.has(r.key)).sort((a, b) => b.total - a.total);
    const head = '<tr><th>Realtor</th><th style="text-align:center">Days Since Last Lead</th><th>Loan Officer</th><th style="text-align:center"># Opps</th>' +
      pipeStageCols.map(c => '<th style="text-align:center">' + c + '</th>').join('') + '</tr>';
    const body = rows.map(r => {
      const last = lastLeadByKey.get(r.key);
      const days = last ? Math.floor((today - last) / 86400000) : null;
      return '<tr>' +
        '<td style="font-weight:600">' + r.name + '</td>' +
        '<td style="text-align:center;font-weight:700;color:' + pipeDaysColor(days) + '">' + (days == null ? '—' : days + ' days ago') + '</td>' +
        '<td style="font-size:11px">' + loDisplay(r.loMap) + '</td>' +
        '<td style="text-align:center;font-weight:700;cursor:pointer;text-decoration:underline;color:#1D4ED8" data-drill-perf="pipeReal:' + r.key + '">' + r.total + '</td>' +
        pipeStageCols.map(c => '<td style="text-align:center">' + (r.cats[c] || '—') + '</td>').join('') +
      '</tr>';
    }).join('');
    const sumOpps = rows.reduce((s, r) => s + r.total, 0);
    const sumStage = {}; pipeStageCols.forEach(c => sumStage[c] = rows.reduce((s, r) => s + r.cats[c], 0));
    const totals = '<tr style="background:#0B192C;font-family:\'Barlow\',sans-serif;font-weight:700">' +
      '<td style="color:white">TOTAL</td><td style="color:white"></td><td style="color:white"></td>' +
      '<td style="text-align:center;color:white">' + sumOpps + '</td>' +
      pipeStageCols.map(c => '<td style="text-align:center;color:white">' + sumStage[c] + '</td>').join('') +
      '</tr>';
    return {
      title: owner + ' — ' + word + ' Realtors in Pipeline',
      sub: rows.length + ' realtor' + (rows.length !== 1 ? 's' : '') + ' · open pipeline today',
      head, body: body + totals,
      csvData: [
        ['Realtor', 'Days Since Last Lead', 'Loan Officer', '# Opps', ...pipeStageCols],
        ...rows.map(r => {
          const last = lastLeadByKey.get(r.key);
          const days = last ? Math.floor((today - last) / 86400000) : null;
          return [r.name, days == null ? '' : days + ' days ago', loPlain(r.loMap), r.total, ...pipeStageCols.map(c => r.cats[c] || 0)];
        }),
        ['TOTAL', '', '', sumOpps, ...pipeStageCols.map(c => sumStage[c])]
      ]
    };
  };
  _perfModalCache.set('openPipelineActive', buildPipeRealtorModal(pipeActiveSet, 'Active'));
  _perfModalCache.set('openPipelineInactive', buildPipeRealtorModal(pipeInactiveSet, 'Inactive'));

  const pipeLoAll = [...pipeLoMap.values()].sort((a, b) => b.total - a.total).concat(pipeNoLo ? [pipeNoLo] : []);
  const loHead = '<tr><th>Loan Officer</th><th style="text-align:center">Active Realtors</th><th style="text-align:center"># Opps</th>' +
    pipeStageCols.map(c => '<th style="text-align:center">' + c + '</th>').join('') + '<th style="text-align:center">% of Pipeline</th></tr>';
  const fmtActInact = (a, i) => (a > 0 ? a + ' active' : '—') + (i > 0 ? ' · ' + i + ' inactive' : '');
  const loBody = pipeLoAll.map(g => {
    const activeR = [...g.realtorKeys].filter(k => pipeActiveSet.has(k)).length;
    const inactiveR = [...g.realtorKeys].filter(k => pipeInactiveSet.has(k)).length;
    const pot = openPipeCount ? (g.total / openPipeCount * 100) : 0;
    return '<tr' + (g.noLo ? ' style="background:#FFFBE6"' : '') + '>' +
      '<td style="font-weight:600' + (g.noLo ? ';color:#B45309' : '') + '">' + g.name + '</td>' +
      '<td style="text-align:center">' + fmtActInact(activeR, inactiveR) + '</td>' +
      '<td style="text-align:center;font-weight:700;cursor:pointer;text-decoration:underline;color:#1D4ED8" data-drill-perf="pipeLo:' + _loDrillId(g) + '">' + g.total + '</td>' +
      pipeStageCols.map(c => '<td style="text-align:center">' + (g.cats[c] || '—') + '</td>').join('') +
      '<td style="text-align:center">' + pot.toFixed(1) + '%</td>' +
    '</tr>';
  }).join('');
  const loSumOpps = pipeLoAll.reduce((s, g) => s + g.total, 0);
  const loSumStage = {}; pipeStageCols.forEach(c => loSumStage[c] = pipeLoAll.reduce((s, g) => s + g.cats[c], 0));
  const loTotals = '<tr style="background:#0B192C;font-family:\'Barlow\',sans-serif;font-weight:700">' +
    '<td style="color:white">TOTAL</td><td style="color:white"></td>' +
    '<td style="text-align:center;color:white">' + loSumOpps + '</td>' +
    pipeStageCols.map(c => '<td style="text-align:center;color:white">' + loSumStage[c] + '</td>').join('') +
    '<td style="text-align:center;color:white">100%</td></tr>';
  _perfModalCache.set('openPipelineLO', {
    title: owner + ' — Loan Officers in Pipeline',
    sub: pipeLoCount + ' LO' + (pipeLoCount !== 1 ? 's' : '') + ' · ' + openPipeCount + ' total open opps',
    head: loHead, body: loBody + loTotals,
    csvData: [
      ['Loan Officer', 'Active Realtors', '# Opps', ...pipeStageCols, '% of Pipeline'],
      ...pipeLoAll.map(g => {
        const activeR = [...g.realtorKeys].filter(k => pipeActiveSet.has(k)).length;
        const inactiveR = [...g.realtorKeys].filter(k => pipeInactiveSet.has(k)).length;
        const pot = openPipeCount ? (g.total / openPipeCount * 100) : 0;
        return [g.name, fmtActInact(activeR, inactiveR), g.total, ...pipeStageCols.map(c => g.cats[c] || 0), pot.toFixed(1) + '%'];
      }),
      ['TOTAL', '', loSumOpps, ...pipeStageCols.map(c => loSumStage[c]), '100%']
    ]
  });

  const briefcaseSm = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>';
  const pipeRealtorsHtml = '<div style="display:flex;flex-direction:column;gap:4px;margin:8px 0">' +
    '<span class="kpi-clickable" style="font-size:12px;font-weight:600;color:#065F46;cursor:pointer" data-perf-modal="openPipelineActive" title="Click to view detailed breakdown"><span class="pip-dot active"></span> ' + pipeActive + ' active realtors</span>' +
    '<span class="kpi-clickable" style="font-size:12px;font-weight:600;color:#B45309;cursor:pointer" data-perf-modal="openPipelineInactive" title="Click to view detailed breakdown"><span class="pip-dot inactive"></span> ' + pipeInactive + ' inactive realtors</span>' +
    '<span class="kpi-clickable" style="font-size:12px;font-weight:600;color:#1D4ED8;cursor:pointer;text-decoration:underline;margin-top:2px" data-perf-modal="openPipelineLO" title="Click to view detailed breakdown">' + briefcaseSm + ' ' + pipeLoCount + ' loan officers</span>' +
  '</div>';

  const openPipeAsOf = 'as of ' + MS_SHORT[today.getUTCMonth()] + ' ' + today.getUTCDate() + ', ' + today.getUTCFullYear();
  _perfModalCache.set('openPipelineAll', withFilters(buildOppTable(openAllRows, owner + ' — Open Pipeline', openPipeCount + ' opportunit' + (openPipeCount !== 1 ? 'ies' : 'y') + ' · open today'), 'perf-pipe-filters', PIPE_FILTERS, oppCount));
  const openBreakdownHtml = '<div class="perf-leads-breakdown">' +
    openStageOrder.filter(k => openStageRows[k].length > 0).map(k => {
      const cnt = openStageRows[k].length;
      _perfModalCache.set('oppStage:' + k, withFilters(buildOppTable(openStageRows[k], owner + ' — ' + k, cnt + ' opportunit' + (cnt !== 1 ? 'ies' : 'y') + ' · open today'), 'perf-pipe-filters', PIPE_FILTERS, oppCount));
      return '<div class="perf-leads-breakdown-row" style="cursor:pointer" data-perf-modal="oppStage:' + k + '" title="Click to view detailed breakdown"><span class="plb-label">' + k + '</span><span class="plb-count">' + cnt + '</span></div>';
    }).join('') +
  '</div>';

  const b2bWindowHtml = '<div class="perf-b2b-window-compact">Based on Metrics window: ' + fmtDate(mainHFBase) + ' → ' + fmtDate(mainHFCutoff) + '</div>';

  const svgWrap = inner => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  const ICON = {
    users: svgWrap('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    briefcase: svgWrap('<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'),
    trendingUp: svgWrap('<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'),
    phone: svgWrap('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'),
    calendar: svgWrap('<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
    target: svgWrap('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
    checkCircle: svgWrap('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
    alertCircle: svgWrap('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>')
  };
  const cardTop = (iconClass, icon, title) =>
    '<div class="perf-card-top"><div class="perf-card-icon ' + iconClass + '">' + icon + '</div><span class="perf-card-title">' + title + '</span></div>';

  // ── Closings vs Goal ──
  const closingRows = (state.oppData || []).filter(row => {
    if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed won') return false;
    if (norm(String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim()) !== norm(owner)) return false;
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    if (!disbDate || disbDate < start || disbDate > end) return false;
    const lender = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
    if (lender.includes('city lending inc')) return false;
    return true;
  });
  const closingActiveSet = new Set((state.activeResults || []).map(r => r.key));
  const closingInactiveSet = new Set((state.inactiveResults || []).map(r => r.key));
  const closingChip = st => st === 'active'
    ? '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#E1F5EE;color:#085041">Active</span>'
    : st === 'inactive'
      ? '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#FEF3C7;color:#B45309">Inactive</span>'
      : '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#F1F5F9;color:#94A3B8">Unknown</span>';
  const closingEnriched = closingRows.map(row => {
    const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
    const key = ref ? norm(ref) : '';
    const status = ref ? (closingActiveSet.has(key) ? 'active' : closingInactiveSet.has(key) ? 'inactive' : 'unknown') : 'unknown';
    return {
      realtor: ref || 'Unknown Realtor', hasRef: !!ref, key, status,
      branch: String(getField(row, 'Branch', 'branch') || '').trim() || '—',
      lo: String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '').trim() || '—',
      lnNum: String(getField(row, 'Loan #', 'loan #') || '—').trim(),
      disbDate: parseDate(getField(row, 'Disbursement Date', 'disbursement date')),
      createdDate: parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date')),
      amt: parseFloat(String(getField(row, 'Loan Amount', 'loan amount', 'Amount', 'amount') || '').replace(/[$,]/g, '')) || 0
    };
  });

  const loanAmtGoal = kpiGoals.loanAmount || 700000;
  const closingAmtPct = loanAmtGoal > 0 ? Math.round(mainClosings.totalAmount / loanAmtGoal * 100) : 0;
  const closingAmtCol = closingAmtPct >= 100 ? '#085041' : closingAmtPct >= 50 ? '#D4A000' : '#CC3030';
  const closingBar = '<div class="perf-goal-track" style="margin-top:8px"><div class="perf-goal-fill" style="width:' + Math.min(closingAmtPct, 100) + '%;background:' + closingAmtCol + '"></div></div>';

  const closingBadge = (main, cmp) => {
    if (!hasCmp || cmp === null || cmp === undefined) return '';
    const diff = main - cmp;
    if (diff === 0) return '<span class="perf-trend-badge perf-trend-neutral">&#8594; no change (' + fmtMoney(cmp) + ')</span>';
    const up = diff > 0;
    const pct = cmp !== 0 ? Math.round(diff / cmp * 100) : null;
    const pctStr = pct !== null ? ' (' + (up ? '+' : '') + pct + '%)' : '';
    return '<span class="perf-trend-badge ' + (up ? 'perf-trend-up' : 'perf-trend-down') + '">' + (up ? '&#8593; +' : '&#8595; -') + fmtMoney(Math.abs(diff)) + pctStr + '</span>';
  };

  const closingRowHtml = e =>
    '<div class="perf-closing-deal">' +
      '<span class="pcd-realtor"' + (e.hasRef ? '' : ' style="color:#B45309"') + ' title="' + e.realtor + '">' + e.realtor + '</span>' +
      '<span class="pcd-status">' + closingChip(e.status) + '</span>' +
      '<span class="pcd-branch">' + e.branch + '</span>' +
      '<span class="pcd-lo">' + e.lo + '</span>' +
      '<span class="pcd-amount">' + fmtMoney(e.amt) + '</span>' +
    '</div>';
  const closingSorted = [...closingEnriched].sort((a, b) => b.amt - a.amt);
  const closingRest = closingSorted.slice(5);
  const closingBreakdownHtml = closingSorted.length
    ? '<div style="margin-top:8px">' + closingSorted.slice(0, 5).map(closingRowHtml).join('') +
      (closingRest.length ? '<details style="margin-top:2px"><summary style="cursor:pointer;font-size:10px;color:#1D6FA4;font-weight:600;padding:2px 0" onclick="this.style.display=\'none\'">Show more (' + closingRest.length + ')</summary>' + closingRest.map(closingRowHtml).join('') + '</details>' : '') +
      '</div>'
    : '';

  const closingUniqueKeys = new Set(closingEnriched.filter(e => e.hasRef).map(e => e.key));
  const closingActiveCnt = [...closingUniqueKeys].filter(k => closingActiveSet.has(k)).length;
  const closingInactiveCnt = [...closingUniqueKeys].filter(k => closingInactiveSet.has(k)).length;
  const closingUnknownRef = closingEnriched.filter(e => !e.hasRef).length;
  const closingFooterHtml = closingEnriched.length
    ? '<div class="perf-kpi-sub" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<span>' + (closingUniqueKeys.size === 1 ? '1 unique realtor' : closingUniqueKeys.size + ' unique realtors') + '</span>' +
        '<span>· ' + closingActiveCnt + ' active</span>' +
        '<span>· ' + closingInactiveCnt + ' inactive</span>' +
        (closingUnknownRef > 0 ? '<span style="color:#B45309;font-weight:600">· ' + closingUnknownRef + ' unknown referred by <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>' : '') +
      '</div>'
    : '';

  const closingDtcColor = d => d == null ? '#64748B' : d < 90 ? '#065F46' : d <= 180 ? '#B45309' : '#BE123C';
  const closingModalRows = [...closingEnriched].sort((a, b) => (b.disbDate || 0) - (a.disbDate || 0));
  const closingSumAmt = closingEnriched.reduce((s, e) => s + e.amt, 0);
  _perfModalCache.set('closingsDetail', {
    title: owner + ' — Closings (Closed Won)',
    sub: closingEnriched.length + ' closing' + (closingEnriched.length !== 1 ? 's' : '') + ' · ' + fmtMoney(closingSumAmt) + ' · ' + mainLbl,
    head: '<tr><th>Loan #</th><th>Realtor</th><th>Realtor Status</th><th>Branch</th><th>Loan Officer</th><th>Disbursement Date</th><th>Created Date</th><th style="text-align:center">Days to Close</th><th>Loan Amount</th></tr>',
    body: closingModalRows.map(e => {
      const dtc = (e.disbDate && e.createdDate) ? Math.floor((e.disbDate - e.createdDate) / 86400000) : null;
      return '<tr>' +
        '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
        '<td style="font-weight:600' + (e.hasRef ? '' : ';color:#B45309') + '">' + e.realtor + '</td>' +
        '<td>' + closingChip(e.status) + '</td>' +
        '<td style="font-size:11px">' + e.branch + '</td>' +
        '<td style="font-size:11px">' + e.lo + '</td>' +
        '<td class="dt">' + fmtDate(e.disbDate) + '</td>' +
        '<td class="dt">' + fmtDate(e.createdDate) + '</td>' +
        '<td style="text-align:center;font-weight:700;color:' + closingDtcColor(dtc) + '">' + (dtc != null ? dtc + 'd' : '—') + '</td>' +
        '<td class="modal-amount">' + fmtMoney(e.amt) + '</td>' +
      '</tr>';
    }).join('') +
    '<tr style="background:#0B192C;font-family:\'Barlow\',sans-serif;font-weight:700"><td style="color:white" colspan="8">TOTAL</td><td class="modal-amount" style="color:white">' + fmtMoney(closingSumAmt) + '</td></tr>',
    csvData: [
      ['Loan #', 'Realtor', 'Realtor Status', 'Branch', 'Loan Officer', 'Disbursement Date', 'Created Date', 'Days to Close', 'Loan Amount'],
      ...closingModalRows.map(e => {
        const dtc = (e.disbDate && e.createdDate) ? Math.floor((e.disbDate - e.createdDate) / 86400000) : '';
        return [e.lnNum, e.realtor, e.status, e.branch === '—' ? '' : e.branch, e.lo === '—' ? '' : e.lo, fmtDate(e.disbDate), fmtDate(e.createdDate), dtc, e.amt || ''];
      }),
      ['TOTAL', '', '', '', '', '', '', '', closingSumAmt]
    ]
  });

  // ══ SECCIÓN 04: Mission 20 (LO Outreach + NPPM Realtors) — desde realtorOwnerMap ══
  const m20StageOrder = ['Need Analysis', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost', 'Others'];
  const m20StageStyle = {
    'Need Analysis': { cls: ' plb-new', bg: '' }, 'Qualification': { cls: ' plb-working', bg: '' },
    'Proposal': { cls: ' plb-proposal', bg: '' }, 'Negotiation': { cls: ' plb-negotiation', bg: '' },
    'Closed Won': { cls: ' plb-converted', bg: '' }, 'Closed Lost': { cls: ' plb-discarded', bg: '' }, 'Others': { cls: ' plb-other', bg: '' }
  };
  const m20StageCat = raw => {
    const s = String(raw || '').toLowerCase();
    if (s.includes('need analysis') || s.includes('needs analysis')) return 'Need Analysis';
    if (s.includes('qualification')) return 'Qualification';
    if (s.includes('proposal')) return 'Proposal';
    if (s.includes('negotiation')) return 'Negotiation';
    if (s.includes('closed won')) return 'Closed Won';
    if (s.includes('closed lost')) return 'Closed Lost';
    return 'Others';
  };
  const m20List = (predicate, s, e) => {
    const out = [];
    for (const [key, entry] of (state.realtorOwnerMap || new Map()).entries()) {
      if (!entry || typeof entry !== 'object') continue;
      if (norm(entry.owner || '') !== norm(owner)) continue;
      if (!predicate(entry)) continue;
      const cd = parseDate(entry.created_date);
      if (!cd || cd < s || cd > e) continue;
      out.push({ key, name: entry.name || key, stage: entry.stage || '', branch: entry.branch || '', loanOfficers: entry.loan_officers || '', inviteD: parseDate(entry.invite_sent_date), attendD: parseDate(entry.meeting_attended_date), createdDate: cd });
    }
    return out;
  };
  const m20LoPred = e => String(e.opportunity_record_type || '').trim() === 'Loan Officer';
  const m20NppmPred = e => e.nppm === true && String(e.opportunity_record_type || 'Realtor').trim() === 'Realtor';
  const m20BuildBreakdown = list => {
    const counts = {}; m20StageOrder.forEach(k => counts[k] = 0);
    for (const x of list) counts[m20StageCat(x.stage)]++;
    return '<div class="perf-leads-breakdown">' +
      m20StageOrder.filter(k => counts[k] > 0).map(k => {
        const st = m20StageStyle[k];
        return '<div class="perf-leads-breakdown-row' + st.cls + '"' + (st.bg ? ' style="background:' + st.bg + '"' : '') + '><span class="plb-label">' + k + '</span><span class="plb-count">' + counts[k] + '</span></div>';
      }).join('') +
    '</div>';
  };
  const m20SubMetrics = list => '<div class="perf-kpi-sub" style="display:flex;gap:8px;flex-wrap:wrap"><span>' + list.filter(x => x.inviteD).length + ' invite sent</span><span>·</span><span>' + list.filter(x => x.attendD).length + ' attended</span></div>';
  const m20Rank = { 'Need Analysis': 0, 'Qualification': 1, 'Proposal': 2, 'Negotiation': 3, 'Closed Won': 4, 'Closed Lost': 5, 'Others': 6 };
  const m20Sort = list => [...list].sort((a, b) => { const sa = m20Rank[m20StageCat(a.stage)] ?? 9, sb = m20Rank[m20StageCat(b.stage)] ?? 9; return sa !== sb ? sa - sb : (b.createdDate || 0) - (a.createdDate || 0); });
  const m20LeadCount = new Map();
  const m20FirstLead = new Map();
  for (const lr of (state.leadsData || [])) {
    const ref = getField(lr, 'Referred By', 'referred by');
    if (!ref) continue;
    const k = norm(String(ref));
    m20LeadCount.set(k, (m20LeadCount.get(k) || 0) + 1);
    const cd = parseDate(getField(lr, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (cd) { const cur = m20FirstLead.get(k); if (!cur || cd < cur) m20FirstLead.set(k, cd); }
  }
  // Builders compartidos del detalle NPPM (m20Nppm + nppmInvites + nppmAttended)
  const nppmHead = '<tr><th>Realtor</th><th>Stage</th><th>Branch</th><th>LO Asignado</th><th>Created Date</th><th>Invite Sent</th><th>Meeting Attended</th><th style="text-align:center">Total Leads</th><th>First Lead</th></tr>';
  const nppmCsvHead = ['Realtor', 'Stage', 'Branch', 'LO Asignado', 'Created Date', 'Invite Sent', 'Meeting Attended', 'Total Leads', 'First Lead'];
  const nppmRowHtml = x => {
    const lc = m20LeadCount.get(x.key) || 0;
    const fl = m20FirstLead.get(x.key);
    return '<tr><td style="font-weight:600">' + x.name + '</td><td style="font-size:11px">' + (x.stage || '—') + '</td><td style="font-size:11px">' + (x.branch || '—') + '</td><td style="font-size:11px">' + (x.loanOfficers || '—') + '</td><td class="dt">' + fmtDate(x.createdDate) + '</td><td class="dt">' + (x.inviteD ? fmtDate(x.inviteD) : '—') + '</td><td class="dt">' + (x.attendD ? fmtDate(x.attendD) : '—') + '</td><td style="text-align:center">' + (lc > 0 ? '<span style="font-weight:700">' + lc + '</span>' : '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:#FFFBEB;color:#B45309">New</span>') + '</td><td class="dt">' + (fl ? fmtDate(fl) : '—') + '</td></tr>';
  };
  const nppmCsvRow = x => { const lc = m20LeadCount.get(x.key) || 0; const fl = m20FirstLead.get(x.key); return [x.name, x.stage || '', x.branch || '', x.loanOfficers || '', fmtDate(x.createdDate), x.inviteD ? fmtDate(x.inviteD) : '', x.attendD ? fmtDate(x.attendD) : '', lc > 0 ? lc : 'New', fl ? fmtDate(fl) : '']; };
  const m20SubMetricsNppm = list => '<div class="perf-kpi-sub" style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<span class="kpi-clickable" style="cursor:pointer;font-weight:600" data-perf-modal="nppmInvites" title="Click to view detailed breakdown">' + list.filter(x => x.inviteD).length + ' invite sent</span>' +
    '<span>·</span>' +
    '<span class="kpi-clickable" style="cursor:pointer;font-weight:600" data-perf-modal="nppmAttended" title="Click to view detailed breakdown">' + list.filter(x => x.attendD).length + ' attended</span>' +
  '</div>';

  const loOutMain = m20List(m20LoPred, start, end);
  const loOutCmp = hasCmp ? m20List(m20LoPred, cmpBounds.start, cmpBounds.end) : null;
  const loOutSorted = m20Sort(loOutMain);
  _perfModalCache.set('m20LoOutreach', {
    title: owner + ' — LO Outreach',
    sub: loOutMain.length + ' loan officer' + (loOutMain.length !== 1 ? 's' : '') + ' · ' + mainLbl,
    head: '<tr><th>LO Name</th><th>Stage</th><th>Branch</th><th>Created Date</th><th>Invite Sent</th><th>Meeting Attended</th></tr>',
    body: loOutSorted.map(x => '<tr><td style="font-weight:600">' + x.name + '</td><td style="font-size:11px">' + (x.stage || '—') + '</td><td style="font-size:11px">' + (x.branch || '—') + '</td><td class="dt">' + fmtDate(x.createdDate) + '</td><td class="dt">' + (x.inviteD ? fmtDate(x.inviteD) : '—') + '</td><td class="dt">' + (x.attendD ? fmtDate(x.attendD) : '—') + '</td></tr>').join(''),
    csvData: [['LO Name', 'Stage', 'Branch', 'Created Date', 'Invite Sent', 'Meeting Attended'], ...loOutSorted.map(x => [x.name, x.stage || '', x.branch || '', fmtDate(x.createdDate), x.inviteD ? fmtDate(x.inviteD) : '', x.attendD ? fmtDate(x.attendD) : ''])]
  });

  const nppmMain = m20List(m20NppmPred, start, end);
  const nppmCmp = hasCmp ? m20List(m20NppmPred, cmpBounds.start, cmpBounds.end) : null;
  const nppmSorted = m20Sort(nppmMain);
  _perfModalCache.set('m20Nppm', {
    title: owner + ' — NPPM Realtors',
    sub: nppmMain.length + ' realtor' + (nppmMain.length !== 1 ? 's' : '') + ' · ' + mainLbl,
    head: nppmHead, body: nppmSorted.map(nppmRowHtml).join(''),
    csvData: [nppmCsvHead, ...nppmSorted.map(nppmCsvRow)]
  });
  const nppmInvitesList = nppmMain.filter(x => x.inviteD).sort((a, b) => (b.inviteD || 0) - (a.inviteD || 0));
  _perfModalCache.set('nppmInvites', {
    title: owner + ' — NPPM Invites Sent',
    sub: nppmInvitesList.length + ' realtor' + (nppmInvitesList.length !== 1 ? 's' : '') + ' · ' + mainLbl,
    head: nppmHead, body: nppmInvitesList.map(nppmRowHtml).join(''),
    csvData: [nppmCsvHead, ...nppmInvitesList.map(nppmCsvRow)]
  });
  const nppmAttendedList = nppmMain.filter(x => x.attendD).sort((a, b) => (b.attendD || 0) - (a.attendD || 0));
  _perfModalCache.set('nppmAttended', {
    title: owner + ' — NPPM Meetings Attended',
    sub: nppmAttendedList.length + ' realtor' + (nppmAttendedList.length !== 1 ? 's' : '') + ' · ' + mainLbl,
    head: nppmHead, body: nppmAttendedList.map(nppmRowHtml).join(''),
    csvData: [nppmCsvHead, ...nppmAttendedList.map(nppmCsvRow)]
  });

  const m20SectionHtml =
    '<div class="perf-section-label">04 — Mission 20</div>' +
    '<div class="perf-grid-2">' +
      '<div class="perf-kpi-card">' +
        '<div class="perf-card-header-full">' + cardTop('perf-icon-blue', ICON.users, 'LO Outreach') + '</div>' +
        '<div class="perf-card-body">' +
          '<div class="perf-card-left">' +
            '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left" data-perf-modal="m20LoOutreach" title="Click to view detailed breakdown">' + loOutMain.length + '</button>' +
            '<div class="perf-kpi-sub">loan officers</div>' +
            m20SubMetrics(loOutMain) +
            trendBadge(loOutMain.length, loOutCmp ? loOutCmp.length : null) +
          '</div>' +
          '<div class="perf-card-right">' + m20BuildBreakdown(loOutMain) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="perf-kpi-card">' +
        '<div class="perf-card-header-full">' + cardTop('perf-icon-blue', ICON.target, 'NPPM Realtors') + '</div>' +
        '<div class="perf-card-body">' +
          '<div class="perf-card-left">' +
            '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left" data-perf-modal="m20Nppm" title="Click to view detailed breakdown">' + nppmMain.length + '</button>' +
            '<div class="perf-kpi-sub">NPPM realtors</div>' +
            m20SubMetricsNppm(nppmMain) +
            trendBadge(nppmMain.length, nppmCmp ? nppmCmp.length : null) +
          '</div>' +
          '<div class="perf-card-right">' + m20BuildBreakdown(nppmMain) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  content.innerHTML =
    '<div class="perf-compare-pill">Comparing ' + mainRange +
      (hasCmp ? ' vs ' + rangeStr(cmpBounds.start, cmpBounds.end) + ' (full month)' : '') + '</div>' +
    '<div class="perf-owner-heading">' + owner + '</div>' +
    '<div class="perf-period-banner">' +
      '<span class="perf-period-current">' + mainShort + '</span>' +
      (hasCmp ? '<span class="perf-period-vs">vs</span><span class="perf-period-compare">' + cmpShort + ' (full month)</span>' : '') +
    '</div>' +

    // ══ SECTION 1: PIPELINE & ENTRADAS ══
    '<div class="perf-section-label">01 — Pipeline &amp; Inputs</div>' +
    '<div class="perf-grid-3">' +
      // Leads Received
      '<div class="perf-kpi-card">' +
        '<div class="perf-card-header-full">' +
          cardTop('perf-icon-blue', ICON.users, 'Leads B2C') +
          '<div class="perf-card-period-label">During selected period</div>' +
        '</div>' +
        '<div class="perf-card-body">' +
          '<div class="perf-card-left">' +
            valBtn('mainLeads', mainLeads.count) +
            '<div class="perf-kpi-sub"><button class="perf-cmp-clickable kpi-clickable" style="font:inherit;font-weight:700;color:#334466;background:none;border:none;cursor:pointer;padding:0" data-perf-modal="leadRealtors" title="Click to view detailed breakdown">' + mainLeads.uniqueRealtors + '</button> unique realtor' + (mainLeads.uniqueRealtors !== 1 ? 's' : '') + '</div>' +
            trendBadge(mainLeads.count, cmpLeads ? cmpLeads.count : null) +
          '</div>' +
          '<div class="perf-card-right">' + leadsBreakdownHtml + convRateHtml + '</div>' +
        '</div>' +
      '</div>' +
      // Opportunities Created
      '<div class="perf-kpi-card">' +
        '<div class="perf-card-header-full">' +
          cardTop('perf-icon-blue', ICON.briefcase, 'Opportunities B2C') +
          '<div class="perf-card-period-label">During selected period</div>' +
        '</div>' +
        '<div class="perf-card-body">' +
          '<div class="perf-card-left">' +
            valBtn('mainPipe', mainPipe.created) +
            '<div class="perf-kpi-sub"><button class="perf-cmp-clickable kpi-clickable" style="font:inherit;font-weight:700;color:#334466;background:none;border:none;cursor:pointer;padding:0" data-perf-modal="oppRealtors" title="Click to view detailed breakdown">' + oppUniqueRealtors + '</button> unique realtors' + (oppUnknownCount > 0 ? ' · <span style="color:#B45309;font-weight:600">' + oppUnknownCount + ' unknown</span>' : '') + '</div>' +
            '<div class="perf-kpi-sub" style="font-weight:700;color:#0B192C">' + oppsPct + '% of goal</div>' +
            trendBadge(mainPipe.created, cmpPipe ? cmpPipe.created : null) +
          '</div>' +
          '<div class="perf-card-right">' + oppBreakdownHtml + '</div>' +
        '</div>' +
      '</div>' +
      // Open Pipeline (snapshot)
      '<div class="perf-kpi-card">' +
        '<div class="perf-card-header-full">' +
          cardTop('perf-icon-blue', ICON.trendingUp, 'Open Pipeline B2C') +
          '<div class="perf-card-period-label">Current snapshot — all open today</div>' +
        '</div>' +
        '<div class="perf-card-body">' +
          '<div class="perf-card-left">' +
            valBtn('openPipelineAll', openPipeCount) +
            pipeRealtorsHtml +
            '<div class="perf-kpi-sub" style="color:#94A3B8">' + openPipeAsOf + '</div>' +
          '</div>' +
          '<div class="perf-card-right">' + openBreakdownHtml + buildHealthBreakdown(openAllRows, owner) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // ══ SECTION 2: BD ACTIVITY ══
    '<div class="perf-section-label">02 — BD Activity</div>' +
    '<div class="perf-grid-3 perf-grid-activity">' +
      // Calls
      '<div class="perf-kpi-card">' +
        '<div class="perf-card-header-full">' +
          cardTop('perf-icon-green', ICON.phone, 'Calls') +
        '</div>' +
        '<div class="perf-card-body">' +
          '<div class="perf-card-left">' +
            '<div class="perf-kpi-value">' + mainCalls.totalCalls + '</div>' +
            '<div class="perf-kpi-sub">' + mainCalls.effectiveCalls + ' effective · <span class="perf-rate-chip perf-rate-' + callsRateColor + '" style="font-size:11px;padding:1px 6px">' + mainCalls.effectivenessRate + '% rate</span></div>' +
            '<div style="margin-top:auto">' + trendBadge(mainCalls.totalCalls, cmpCalls ? cmpCalls.totalCalls : null) + '</div>' +
          '</div>' +
          '<div class="perf-card-right">' + callsBreakdownHtml + '</div>' +
        '</div>' +
      '</div>' +
      // Zoom & Meetings Activity
      '<div class="perf-kpi-card">' +
        '<div class="perf-card-header-full">' +
          cardTop('perf-icon-green', ICON.calendar, 'Meetings — Realtors') +
        '</div>' +
        '<div class="perf-card-body">' +
          '<div class="perf-card-left">' +
            '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left" data-perf-modal="meetingAttended" title="Click to view detailed breakdown">' + mainInvites.meetingAttended + '</button>' +
            '<div class="perf-kpi-sub">meetings attended</div>' +
            meetConvHtml +
            '<div style="margin-top:auto">' + trendBadge(mainInvites.meetingAttended, cmpInvites ? cmpInvites.meetingAttended : null) + '</div>' +
          '</div>' +
          '<div class="perf-card-right">' + meetBreakdownHtml + '</div>' +
        '</div>' +
      '</div>' +
      // B2B Behavior
      '<div class="perf-kpi-card">' +
        cardTop('perf-icon-green', ICON.target, 'B2B Behavior') +
        b2bWindowHtml +
        '<div class="perf-hf-row">' +
          '<div class="perf-hf-block">' +
            '<div class="perf-kpi-label" style="color:#A32D2D">Hunting</div>' +
            valBtn('mainHunting', mainHF.hunting, '#A32D2D') +
            '<div class="perf-kpi-sub">' + hPct + '% of active</div>' +
            hfChip(mainHF.hunting, teamAvg.avgH) +
            (hasCmp && cmpHF ? trendBadge(mainHF.hunting, cmpHF.hunting) : '') +
          '</div>' +
          '<div class="perf-hf-divider"></div>' +
          '<div class="perf-hf-block">' +
            '<div class="perf-kpi-label" style="color:#085041">Farming</div>' +
            valBtn('mainFarming', mainHF.farming, '#085041') +
            '<div class="perf-kpi-sub">' + fPct + '% of active</div>' +
            hfChip(mainHF.farming, teamAvg.avgF) +
            (hasCmp && cmpHF ? trendBadge(mainHF.farming, cmpHF.farming) : '') +
          '</div>' +
        '</div>' +
        '<div class="perf-hf-team-avg">Team avg: ' + teamAvg.avgH.toFixed(1) + 'H / ' + teamAvg.avgF.toFixed(1) + 'F</div>' +
      '</div>' +
    '</div>' +

    // ══ SECTION 3: RESULTS ══
    '<div class="perf-section-label">03 — Results &amp; Closings B2C</div>' +
    '<div class="perf-grid-2">' +
      // Closings vs Goal
      '<div class="perf-kpi-card">' +
        cardTop('perf-icon-red', ICON.checkCircle, 'Closings vs Goal') +
        '<div style="display:flex;gap:16px">' +
          '<div style="flex:1;min-width:0">' +
            '<div class="perf-kpi-label">Closings</div>' +
            '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left" data-perf-modal="closingsDetail" title="Click to view detailed breakdown">' + mainClosings.count + '</button>' +
          '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="perf-kpi-label">Loan Amount</div>' +
            '<div class="perf-kpi-value">' + fmtMoney(mainClosings.totalAmount) + '</div>' +
          '</div>' +
        '</div>' +
        closingBar +
        '<div class="perf-kpi-sub"><span style="color:' + closingAmtCol + ';font-weight:700">' + closingAmtPct + '%</span> of ' + fmtMoney(loanAmtGoal) + ' goal</div>' +
        closingBadge(mainClosings.totalAmount, cmpClosings ? cmpClosings.totalAmount : null) +
        closingBreakdownHtml +
        closingFooterHtml +
      '</div>' +
      // Lost Opportunities
      '<div class="perf-kpi-card">' +
        '<div class="perf-card-header-full">' +
          cardTop('perf-icon-amber', ICON.alertCircle, 'Lost Opportunities') +
          '<div class="perf-card-period-label">Closed Lost with milestone in period</div>' +
        '</div>' +
        (lostTotal === 0
          ? '<div style="color:#1D9E75;font-size:12px;font-weight:600;padding:10px 0">No lost opportunities in this period &#10003;</div>'
          : '<div class="perf-card-body">' +
              '<div class="perf-card-left">' +
                '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left" data-perf-modal="lostOpps" title="Click to view detailed breakdown">' + lostTotal + '</button>' +
                trendBadge(lostTotal, cmpLost ? cmpLost.total : null) +
              '</div>' +
              '<div class="perf-card-right">' + lostReachedHtml + '</div>' +
            '</div>' +
            '<div style="margin-top:10px">' + lostTableHtml() + '</div>'
        ) +
      '</div>' +
    '</div>' +
    m20SectionHtml;
}

function populateSelects() {
  const ownerEl = document.getElementById('perf-owner');
  if (!ownerEl) return;

  const owners = getAllowedOwners();
  const prevOwner = ownerEl.value;
  ownerEl.innerHTML = '<option value="">&#8212; Select BD &#8212;</option>' +
    owners.map(o => '<option value="' + o + '"' + (o === prevOwner ? ' selected' : '') + '>' + o + '</option>').join('');
  // Preselecciona el BD del usuario sin acceso total (para que vea lo suyo sin filtrar).
  if (!state.fullAccess && owners.length && !ownerEl.value) {
    ownerEl.value = owners[0];
    ownerEl.dispatchEvent(new Event('change'));
  }

  const yearsSet = new Set();
  const today = new Date();
  yearsSet.add(today.getUTCFullYear());
  yearsSet.add(today.getUTCFullYear() - 1);
  for (const row of (state.oppData || [])) {
    const d1 = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    const d2 = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (d1) yearsSet.add(d1.getUTCFullYear());
    if (d2) yearsSet.add(d2.getUTCFullYear());
  }
  const sortedYears = [...yearsSet].sort((a, b) => b - a);
  const yOpts = sortedYears.map(y => '<option value="' + y + '">' + y + '</option>').join('');
  const curY = today.getUTCFullYear(), prevY = curY - 1;

  const yearEl = document.getElementById('perf-year');
  if (yearEl) {
    const pv = yearEl.value;
    yearEl.innerHTML = yOpts;
    yearEl.value = pv || String(curY);
    if (!yearEl.value && sortedYears.length) yearEl.value = String(sortedYears[0]);
  }
  const cmpYearEl = document.getElementById('perf-cmp-year');
  if (cmpYearEl) {
    const pv = cmpYearEl.value;
    cmpYearEl.innerHTML = yOpts;
    cmpYearEl.value = pv || String(curY);
    if (!cmpYearEl.value && sortedYears.length) cmpYearEl.value = String(sortedYears[0]);
  }

  const monthsEl = document.getElementById('perf-months');
  const cmpMonthsEl = document.getElementById('perf-cmp-months');
  const curM = today.getUTCMonth(), prevM = curM === 0 ? 11 : curM - 1;
  const mOpts = MS_FULL.map((n, i) => '<option value="' + i + '">' + n + '</option>').join('');

  if (monthsEl && !monthsEl.options.length) {
    monthsEl.innerHTML = mOpts;
    monthsEl.options[curM].selected = true;
  }
  if (cmpMonthsEl && !cmpMonthsEl.options.length) {
    cmpMonthsEl.innerHTML = mOpts;
    cmpMonthsEl.options[prevM].selected = true;
  }
}

export function initPerformance() {
  populateSelects();
  renderPerformance();
}

// Event delegation for Performance modal clicks
document.addEventListener('click', e => {
  const el = e.target.closest('[data-perf-modal]');
  if (!el) return;
  const key = el.getAttribute('data-perf-modal');
  const m = _perfModalCache.get(key);
  if (!m) return;
  openModal(m.title, m.sub, m.head, m.body, m.csvData);
  if (m.filters && m.rows && m.renderRow) {
    renderModalFilters({
      containerId: m.containerId,
      subtitleId: 'modal-sub',
      tableBodyId: 'modal-tbody',
      rows: m.rows,
      filters: m.filters,
      renderRow: m.renderRow,
      countLabel: m.countLabel
    });
  }
});

// Healthiness chips → modal de detalle (BD Performance — Open Pipeline)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-pipeline-health]');
  if (!el || !el.closest('#perf-content')) return;
  const owner = el.getAttribute('data-owner');
  const opps = _healthCachePerf.get(owner);
  if (!opps) return;
  openHealthModal(opps, owner, el.getAttribute('data-health'));
});
