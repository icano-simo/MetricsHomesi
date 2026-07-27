import { state } from './state.js';
import { norm, parseDate, fmtDate, getField, normalizeLO } from './utils.js';
import { openModal } from './modal.js';
import { kpiGoals } from './performance.js';

function getAllowedLOs() {
  return document.getElementById('lo-list').value
    .split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== '');
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

// Meetings Attended basado en realtorOwnerMap (mismo cálculo que BD calcMeetingInvites, filtrado por LO)
function calcLoMeetingInvites(loNames, startDate, endDate) {
  const targets = new Set(loNames.map(l => normalizeLO(l)));
  const rom = state.realtorOwnerMap || new Map();
  const inRange = d => d && d >= startDate && d <= endDate;
  const recs = [];
  for (const [key, entry] of rom.entries()) {
    const e = (entry && typeof entry === 'object') ? entry : {};
    const loRaw = String(e.loan_officers || '').trim();
    if (!loRaw || !targets.has(normalizeLO(loRaw))) continue;
    const inviteD = parseDate(e.invite_sent_date);
    const attendD = parseDate(e.meeting_attended_date);
    if (!inRange(inviteD) && !inRange(attendD)) continue;
    const leads = (state.leadsData || []).filter(lr => norm(String(getField(lr, 'Referred By', 'referred by') || '')) === key);
    const leadDates = leads.map(lr => parseDate(getField(lr, 'Created Date', 'created date', 'Create Date', 'create date'))).filter(Boolean).sort((a, b) => a - b);
    recs.push({
      key,
      name: e.name || (leads[0] ? String(getField(leads[0], 'Referred By', 'referred by') || '').trim() : key),
      leads,
      branch: String(e.branch || '').trim() || '—',
      owner: String(e.owner || '').trim() || '—',
      inviteD, attendD,
      nppm: e.nppm === true,
      leadCount: leads.length,
      firstLeadDate: leadDates[0] || null,
      lastLeadDate: leadDates[leadDates.length - 1] || null,
      hasLeadAfterMeeting: attendD ? leadDates.some(d => d >= attendD) : false,
      leadsAfterMeeting: attendD ? leadDates.filter(d => d >= attendD).length : 0
    });
  }
  const invitesList = recs.filter(r => inRange(r.inviteD));
  const attendedList = recs.filter(r => inRange(r.attendD));
  const invitesSent = invitesList.length;
  const meetingAttended = attendedList.length;
  const nppmCount = attendedList.filter(r => r.nppm).length;
  const leadsReferred = attendedList.reduce((s, r) => s + r.leadsAfterMeeting, 0);
  const realtorsWithLeads = attendedList.filter(r => r.hasLeadAfterMeeting).length;
  const conversionRate = meetingAttended > 0 ? (realtorsWithLeads / meetingAttended * 100).toFixed(1) : '0.0';
  return { invitesSent, meetingAttended, nppmCount, leadsReferred, realtorsWithLeads, conversionRate, invitesList, attendedList };
}

function matchLo(row, lo) {
  const loRaw = String(getField(row, 'Loan Officers', 'loan officers', 'Loan Officer', 'loan officer') || '').trim();
  return normalizeLO(loRaw) === normalizeLO(lo);
}

// B2C Goal: Closed Won opps where Loan Officers = this LO, disbursement_date in period
function calcLoLoanAmount(lo, start, end) {
  let total = 0;
  for (const row of (state.oppData || [])) {
    if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed won') continue;
    if (!matchLo(row, lo)) continue;
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    if (!disbDate || disbDate < start || disbDate > end) continue;
    if (String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase().includes('city lending inc')) continue;
    const raw = String(getField(row, 'Loan Amount', 'loan amount', 'Amount', 'amount') || '').replace(/[$,]/g, '');
    total += parseFloat(raw) || 0;
  }
  return total;
}

// Pipeline Activity: opps where Loan Officers = this LO AND created_date in period
function calcLoPipelineActivity(lo, start, end) {
  let created = 0, stillActive = 0;
  for (const row of (state.oppData || [])) {
    if (!matchLo(row, lo)) continue;
    const cd = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (!cd || cd < start || cd > end) continue;
    created++;
    const stage = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    if (stage !== 'closed lost') stillActive++;
  }
  return { created, stillActive };
}

// B2B Behavior: realtors whose leads have Loan Officer = this LO in window, H/F classification
function calcLoHuntingFarmingForWindow(lo, floorDate, cutoffDate, byRef, oppLoMap, getNormLO, allowedNorm) {
  const reactDays = parseInt((document.getElementById('lo-react-days') || {}).value) || 150;
  const reactThreshold = new Date(cutoffDate);
  reactThreshold.setUTCDate(reactThreshold.getUTCDate() - reactDays);

  const huntingRealtors = [], farmingRealtors = [];

  for (const [key, rec] of byRef.entries()) {
    // Deriva datos de la ventana desde los leads pre-indexados (sin re-escanear leadsData)
    let windowCnt = 0;
    const windowLos = new Map(), windowBranches = new Map();
    for (const l of rec.leads) {
      if (l.date >= floorDate && l.date <= cutoffDate) {
        windowCnt++;
        if (l.lo) windowLos.set(l.lo, (windowLos.get(l.lo) || 0) + 1);
        if (l.branch) windowBranches.set(l.branch, (windowBranches.get(l.branch) || 0) + 1);
      }
    }
    if (!windowCnt) continue;

    const allSorted = [...rec.allDates].sort((a, b) => a - b);
    const uniqueDays = [], seen = new Set();
    for (const d of allSorted) {
      const dk = d.toISOString().slice(0, 10);
      if (!seen.has(dk)) { seen.add(dk); uniqueDays.push(d); }
    }
    const firstDate = uniqueDays[0] || null;
    const penult = uniqueDays.length >= 2 ? uniqueDays[uniqueDays.length - 2] : null;
    const c2 = firstDate ? firstDate >= floorDate : false;
    const c4 = penult ? penult <= reactThreshold : false;

    let assignedLO = '';
    const me = state.loMasterMap.get(key);
    if (me && me.loan_officer && me.source === 'manual') {
      assignedLO = me.loan_officer;
    } else {
      if (windowLos.size > 0) {
        let best = '', bestN = -1;
        for (const [l, n] of windowLos.entries()) {
          const canonical = allowedNorm.get(norm(l));
          if (canonical && n > bestN) { bestN = n; best = canonical; }
        }
        if (bestN > -1) assignedLO = best;
      }
      if (!assignedLO && oppLoMap.has(key)) {
        const canonical = allowedNorm.get(norm(oppLoMap.get(key)));
        if (canonical) assignedLO = canonical;
      }
    }
    if (!assignedLO || getNormLO(assignedLO) !== getNormLO(lo)) continue;

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

function calcLoTeamAvgHF(cutoff, baseDate, byRef, oppLoMap, getNormLO, allowedNorm) {
  const los = getAllowedLOs();
  const hVals = [], fVals = [];
  for (const lo of los) {
    const hf = calcLoHuntingFarmingForWindow(lo, baseDate, cutoff, byRef, oppLoMap, getNormLO, allowedNorm);
    if (hf.hunting >= 1) hVals.push(hf.hunting);
    if (hf.farming >= 1) fVals.push(hf.farming);
  }
  return {
    avgH: hVals.length ? hVals.reduce((s, v) => s + v, 0) / hVals.length : 0,
    avgF: fVals.length ? fVals.reduce((s, v) => s + v, 0) / fVals.length : 0
  };
}

// Zoom time parser (local time for display)
function _parseZoomTime(s) {
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  return null;
}

// Match participant name against leadsData referred_by (2-level: exact then partial)
function _loMatchLeads(participantName) {
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
      if (!refGroups.has(nRef)) refGroups.set(nRef, { leads: [], name: ref });
      refGroups.get(nRef).leads.push(row);
    }
    for (const { leads: rLeads, name } of refGroups.values()) {
      if (partWords.filter(w => sigWords(name).includes(w)).length >= 2) {
        return { level: 'partial', leads: rLeads, matchedName: name };
      }
    }
  }
  return { level: 'none', leads: [] };
}

// Meetings attended by any LO in loNames array during the given monthKeys Set
function calcMeetingsAttended(loNames, monthKeys) {
  const doNotCount = state.doNotCountMeetings || new Set();
  const loNormed = new Set(loNames.map(l => normalizeLO(l)));
  const meetingMap = new Map();
  for (const r of (state.zoomData || [])) {
    if (!monthKeys.has(r.month_key || '')) continue;
    if (doNotCount.has(r.meeting_id || '')) continue;
    const key = (r.meeting_id || '') + '|' + (r.month_key || '') + '|' + (r.start_time || '');
    if (!meetingMap.has(key)) {
      meetingMap.set(key, {
        meeting_id: r.meeting_id || '',
        host_name: (r.host_name || '').trim(),
        start_time: r.start_time,
        duration: r.duration_minutes,
        topic: (r.topic || '').trim() || null,
        rows: []
      });
    }
    meetingMap.get(key).rows.push(r);
  }
  const attendedMeetings = [];
  const externalsByNorm = new Map();
  for (const m of meetingMap.values()) {
    const externals = m.rows.filter(r => r.is_guest === 'Yes');
    if (!externals.length) continue;
    const hostNorm = norm(m.host_name);
    const loAttended = m.rows.filter(r => r.is_guest !== 'Yes').some(r => {
      const pn = (r.participant_name || '').trim();
      if (norm(pn) === hostNorm) return false;
      return loNormed.has(normalizeLO(pn));
    });
    if (!loAttended) continue;
    const extNames = [...new Map(externals.map(r => [norm(r.participant_name || ''), r.participant_name || ''])).values()].filter(Boolean);
    attendedMeetings.push({ ...m, externals: extNames });
    for (const e of extNames) {
      const nn = norm(e);
      if (!externalsByNorm.has(nn)) externalsByNorm.set(nn, e);
    }
  }
  const realtorLeadInfo = [];
  let realtorsWithLeads = 0;
  for (const [, name] of externalsByNorm.entries()) {
    const m = _loMatchLeads(name);
    if (!m.leads.length) continue;
    realtorsWithLeads++;
    let minD = null, maxD = null;
    for (const row of m.leads) {
      const d = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
      if (d) { if (!minD || d < minD) minD = d; if (!maxD || d > maxD) maxD = d; }
    }
    const me = state.loMasterMap ? state.loMasterMap.get(norm(name)) : null;
    realtorLeadInfo.push({ name, totalLeads: m.leads.length, firstDate: minD, lastDate: maxD, bdOwner: (me || {}).loan_officer || '' });
  }
  realtorLeadInfo.sort((a, b) => b.totalLeads - a.totalLeads);
  return { meetingsAttended: attendedMeetings.length, uniqueExternals: externalsByNorm.size, realtorsWithLeads, attendedMeetings, realtorLeadInfo };
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

// Modal builders
const _loPerfModalCache = new Map();

function buildLoLoanModal(loNames, lo, start, end, label) {
  const rows = (state.oppData || []).filter(row => {
    if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed won') return false;
    if (!loNames.some(l => matchLo(row, l))) return false;
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
    title: lo + ' — Closed Won',
    sub: label + ' · ' + enriched.length + ' loan' + (enriched.length !== 1 ? 's' : '') + ' · $' + Math.round(total).toLocaleString('en-US'),
    head, body,
    csvData: [
      ['Loan #', 'Opportunity Name', 'Realtor', 'Branch', 'Disbursement Date', 'Loan Amount'],
      ...enriched.map(e => [e.lnNum, e.oppName, e.realtor, e.branch === '—' ? '' : e.branch, fmtDate(e.disbDate), e.amt])
    ]
  };
}

function buildLoPipelineModal(loNames, lo, start, end, label) {
  const rows = (state.oppData || []).filter(row => {
    if (!loNames.some(l => matchLo(row, l))) return false;
    const cd = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    return cd && cd >= start && cd <= end;
  });
  const enriched = rows.map(row => {
    const stage = String(getField(row, 'Stage', 'stage') || '—').trim();
    return {
      lnNum: String(getField(row, 'Loan #', 'loan #') || '—').trim(),
      oppName: String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim(),
      realtor: String(getField(row, 'Referred By', 'referred by') || '—').trim(),
      stage,
      createdDate: parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date')),
      stillActive: stage.toLowerCase() !== 'closed lost'
    };
  });
  enriched.sort((a, b) => (a.createdDate || 0) - (b.createdDate || 0));
  const activeCount = enriched.filter(e => e.stillActive).length;
  const head = '<tr><th>Loan #</th><th>Opportunity Name</th><th>Realtor</th><th>Stage</th><th>Created Date</th><th>Still Active</th></tr>';
  const body = enriched.map(e =>
    '<tr>' +
    '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
    '<td style="font-weight:600">' + e.oppName + '</td>' +
    '<td>' + e.realtor + '</td>' +
    '<td style="font-size:11px">' + e.stage + '</td>' +
    '<td class="dt">' + fmtDate(e.createdDate) + '</td>' +
    '<td style="text-align:center">' + (e.stillActive ? '<span style="color:#085041;font-weight:700">Yes</span>' : '<span style="color:#A32D2D">No</span>') + '</td>' +
    '</tr>'
  ).join('');
  return {
    title: lo + ' — Opportunities Created',
    sub: label + ' · ' + enriched.length + ' opp' + (enriched.length !== 1 ? 's' : '') + ' · ' + activeCount + ' still active',
    head, body,
    csvData: [
      ['Loan #', 'Opportunity Name', 'Realtor', 'Stage', 'Created Date', 'Still Active'],
      ...enriched.map(e => [e.lnNum, e.oppName, e.realtor, e.stage, fmtDate(e.createdDate), e.stillActive ? 'Yes' : 'No'])
    ]
  };
}

function buildLoHFModal(isHunting, realtors, lo, label) {
  const type = isHunting ? 'Hunting' : 'Farming';
  const sorted = [...realtors].sort((a, b) => (b.cnt || 0) - (a.cnt || 0));
  const head = '<tr><th>Realtor</th><th>Branch</th><th>1st Lead Date</th><th>Period Leads</th><th>Rating</th></tr>';
  const body = sorted.map(r => {
    const isH = r.med && r.med.startsWith('Hunting');
    const badgeStyle = isH
      ? 'background:#FDE8E8;color:#A32D2D;padding:2px 6px;border-radius:4px;font-size:9px;font-weight:700;white-space:nowrap'
      : 'background:#E8F5F0;color:#085041;padding:2px 6px;border-radius:4px;font-size:9px;font-weight:700;white-space:nowrap';
    return '<tr>' +
      '<td style="font-weight:600">' + (r.name || '—') + '</td>' +
      '<td style="font-size:11px">' + (r.branch || '—') + '</td>' +
      '<td class="dt">' + fmtDate(r.firstDate) + '</td>' +
      '<td style="text-align:center;font-weight:700;color:var(--hs-navy)">' + (r.cnt || 0) + '</td>' +
      '<td><span style="' + badgeStyle + '">' + (r.med || type) + '</span></td>' +
      '</tr>';
  }).join('');
  return {
    title: lo + ' — ' + type + ' Realtors',
    sub: label + ' · ' + realtors.length + ' realtor' + (realtors.length !== 1 ? 's' : ''),
    head, body,
    csvData: [
      ['Realtor', 'Branch', '1st Lead Date', 'Period Leads', 'Rating'],
      ...sorted.map(r => [r.name || '', r.branch || '', fmtDate(r.firstDate), r.cnt || 0, r.med || type])
    ]
  };
}

function buildLoMeetingsModal(attendedMeetings, lo, label) {
  const head = '<tr><th>Date</th><th>BD Host</th><th>Duration</th><th>Topic</th><th>External Realtors</th></tr>';
  const body = attendedMeetings.map(m => {
    const dt = m.start_time ? _parseZoomTime(m.start_time) : null;
    return '<tr>' +
      '<td class="dt">' + (dt ? fmtDate(dt) : '—') + '</td>' +
      '<td style="font-size:11px">' + (m.host_name || '—') + '</td>' +
      '<td style="text-align:center">' + (m.duration != null ? m.duration : '—') + '</td>' +
      '<td style="font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (m.topic || '') + '">' + (m.topic || '—') + '</td>' +
      '<td style="font-size:11px">' + (m.externals || []).join(', ') + '</td>' +
      '</tr>';
  }).join('');
  return {
    title: lo + ' — Meetings Attended',
    sub: label + ' · ' + attendedMeetings.length + ' meeting' + (attendedMeetings.length !== 1 ? 's' : ''),
    head, body,
    csvData: [
      ['Date', 'BD Host', 'Duration', 'Topic', 'External Realtors'],
      ...attendedMeetings.map(m => {
        const dt = m.start_time ? _parseZoomTime(m.start_time) : null;
        return [fmtDate(dt), m.host_name || '', m.duration != null ? m.duration : '', m.topic || '', (m.externals || []).join('; ')];
      })
    ]
  };
}

function buildLoRealtorsModal(realtorLeadInfo, lo, label) {
  const head = '<tr><th>Realtor</th><th>First Lead</th><th>Total Leads</th><th>Last Lead</th><th>BD Assigned</th></tr>';
  const body = realtorLeadInfo.map(r =>
    '<tr>' +
    '<td style="font-weight:600">' + r.name + '</td>' +
    '<td class="dt">' + fmtDate(r.firstDate) + '</td>' +
    '<td style="text-align:center;font-weight:700;color:var(--hs-navy)">' + r.totalLeads + '</td>' +
    '<td class="dt">' + fmtDate(r.lastDate) + '</td>' +
    '<td style="font-size:11px">' + (r.bdOwner || '—') + '</td>' +
    '</tr>'
  ).join('');
  return {
    title: lo + ' — Realtors with Leads',
    sub: label + ' · ' + realtorLeadInfo.length + ' realtor' + (realtorLeadInfo.length !== 1 ? 's' : ''),
    head, body,
    csvData: [
      ['Realtor', 'First Lead', 'Total Leads', 'Last Lead', 'BD Assigned'],
      ...realtorLeadInfo.map(r => [r.name, fmtDate(r.firstDate), r.totalLeads, fmtDate(r.lastDate), r.bdOwner || ''])
    ]
  };
}

// Main render
export function renderLoPerformance() {
  const content = document.getElementById('lo-perf-content');
  if (!content) return;

  if (!state.oppData || !state.oppData.length) {
    content.innerHTML = '<div class="empty-state">Run calculation first to view performance metrics</div>';
    return;
  }

  // Requiere al menos un LO seleccionado — sin selección NO se calcula nada (evita el render pesado inicial)
  const loEl = document.getElementById('lo-perf-owner');
  const selectedLOs = loEl ? Array.from(loEl.selectedOptions).map(o => o.value).filter(Boolean) : [];
  if (!selectedLOs.length) {
    content.innerHTML = '<div class="perf-empty-bd"><i class="ti ti-user-circle" style="font-size:32px;color:#CCD5E0"></i><div>Select a Loan Officer to view performance metrics</div></div>';
    return;
  }
  const loNames = selectedLOs;
  const lo = loNames.length === 1 ? loNames[0] : loNames.length + ' LOs';

  const yearEl = document.getElementById('lo-perf-year');
  const monthsEl = document.getElementById('lo-perf-months');
  const cmpYearEl = document.getElementById('lo-perf-cmp-year');
  const cmpMonthsEl = document.getElementById('lo-perf-cmp-months');

  const year = parseInt((yearEl || {}).value) || new Date().getUTCFullYear();
  const months0 = monthsEl ? Array.from(monthsEl.selectedOptions).map(o => parseInt(o.value)) : [];
  const cmpYear = parseInt((cmpYearEl || {}).value) || year;
  const cmpMonths0 = cmpMonthsEl ? Array.from(cmpMonthsEl.selectedOptions).map(o => parseInt(o.value)) : [];

  if (!months0.length) {
    content.innerHTML = '<div class="empty-state">Select at least one month for the main period</div>';
    return;
  }

  const today = new Date();
  const hasCmp = cmpMonths0.length > 0;

  const windowDays = parseInt((document.getElementById('lo-window-days') || {}).value) || 60;

  const mainSorted = [...months0].sort((a, b) => a - b);
  const mainLastM  = mainSorted[mainSorted.length - 1];
  const isMainCurrent = year === today.getUTCFullYear() && months0.includes(today.getUTCMonth());
  const mainHFCutoff = isMainCurrent
    ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999))
    : new Date(Date.UTC(year, mainLastM + 1, 0, 23, 59, 59, 999));
  const mainHFBase = new Date(mainHFCutoff);
  mainHFBase.setUTCDate(mainHFBase.getUTCDate() - windowDays);

  // ── Pre-indexado O(1): construir byRef y oppLoMap UNA sola vez (elimina el O(LOs × filas)) ──
  const firstLead = (state.leadsData || [])[0] || {};
  const refByField = Object.keys(firstLead).find(k => norm(k) === 'referred by') || 'Referred By';
  const loLeadField = Object.keys(firstLead).find(k => norm(k) === 'loan officer') || 'Loan Officer';
  const dateField = Object.keys(firstLead).find(k => norm(k) === 'created date' || norm(k) === 'create date') || 'Created Date';
  const branchLeadField = Object.keys(firstLead).find(k => norm(k) === 'branch') || 'Branch';

  const firstOpp = (state.oppData || [])[0] || {};
  const loOppField = Object.keys(firstOpp).find(k => norm(k) === 'loan officers' || norm(k) === 'loan officer') || 'Loan Officers';
  const refByOppField = Object.keys(firstOpp).find(k => norm(k) === 'referred by') || 'Referred By';

  const loNormCache = new Map();
  const getNormLO = (raw) => {
    if (!raw) return '';
    if (loNormCache.has(raw)) return loNormCache.get(raw);
    const r = normalizeLO(raw);
    loNormCache.set(raw, r);
    return r;
  };

  const byRef = new Map();
  for (const row of (state.leadsData || [])) {
    const refRaw = String(row[refByField] || '').trim();
    if (!refRaw) continue;
    const key = norm(refRaw);
    const dateVal = parseDate(row[dateField]);
    const loRaw = String(row[loLeadField] || '').trim();
    const loStr = loRaw ? getNormLO(loRaw) : '';
    const branchStr = String(row[branchLeadField] || '').trim();
    if (!byRef.has(key)) byRef.set(key, { name: refRaw, allDates: [], leads: [] });
    const rec = byRef.get(key);
    if (dateVal) {
      rec.allDates.push(dateVal);
      rec.leads.push({ date: dateVal, lo: loStr, branch: branchStr });
    }
  }

  const oppLoMap = new Map();
  for (const row of (state.oppData || [])) {
    const refRaw = String(row[refByOppField] || '').trim();
    if (!refRaw) continue;
    const loRaw = String(row[loOppField] || '').trim();
    if (loRaw) oppLoMap.set(norm(refRaw), getNormLO(loRaw));
  }

  const allowedNorm = new Map(getAllowedLOs().map(l => [norm(l), l]));

  const _hArr    = loNames.map(l => calcLoHuntingFarmingForWindow(l, mainHFBase, mainHFCutoff, byRef, oppLoMap, getNormLO, allowedNorm));
  const mainHF   = {
    hunting: _hArr.reduce((s, h) => s + h.hunting, 0),
    farming: _hArr.reduce((s, h) => s + h.farming, 0),
    total:   _hArr.reduce((s, h) => s + h.total, 0),
    huntingRealtors: _hArr.flatMap(h => h.huntingRealtors),
    farmingRealtors: _hArr.flatMap(h => h.farmingRealtors)
  };
  const teamAvg = calcLoTeamAvgHF(mainHFCutoff, mainHFBase, byRef, oppLoMap, getNormLO, allowedNorm);

  // Meetings Attended (realtorOwnerMap: invite/meeting dates + NPPM, filtrado por LO)
  const mtgMain = getPeriodBounds(year, months0, today, false);
  const mainMtg = calcLoMeetingInvites(loNames, mtgMain.start, mtgMain.end);
  const cmpMtgB = hasCmp ? getPeriodBounds(cmpYear, cmpMonths0, today, true) : null;
  const cmpMtg = hasCmp ? calcLoMeetingInvites(loNames, cmpMtgB.start, cmpMtgB.end) : null;

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
    const _chArr = loNames.map(l => calcLoHuntingFarmingForWindow(l, cmpHFBase, cmpHFCutoff, byRef, oppLoMap, getNormLO, allowedNorm));
    cmpHF = {
      hunting: _chArr.reduce((s, h) => s + h.hunting, 0),
      farming: _chArr.reduce((s, h) => s + h.farming, 0),
      total:   _chArr.reduce((s, h) => s + h.total, 0),
      huntingRealtors: _chArr.flatMap(h => h.huntingRealtors),
      farmingRealtors: _chArr.flatMap(h => h.farmingRealtors)
    };
    cmpHFLbl = ('VS ' + MS_SHORT[lastCmpM] + ' ' + cmpYear + ' · ' + fmtShortDate(cmpHFBase) + ' → ' + fmtShortDate(cmpHFCutoff)).toUpperCase();
  }

  const total = mainHF.total || 1;
  const hPct = Math.round((mainHF.hunting / total) * 100);
  const fPct = Math.round((mainHF.farming / total) * 100);

  const mainLbl = pLabel(year, months0, today, false);
  const cmpLbl  = hasCmp ? pLabel(cmpYear, cmpMonths0, today, true) : '';

  // ── Meetings funnel + conversion chip + modales (realtorOwnerMap) ──
  const invitePct = mainMtg.invitesSent > 0 ? Math.round(mainMtg.meetingAttended / mainMtg.invitesSent * 100) : 0;
  const meetBreakdownHtml = '<div class="perf-leads-breakdown">' +
    '<div class="perf-leads-breakdown-row plb-new" style="cursor:pointer" data-lo-perf-modal="meetingInvites" title="Click to view detailed breakdown"><span class="plb-label">Invites Sent</span><span class="plb-count">' + mainMtg.invitesSent + '</span></div>' +
    '<div class="perf-leads-breakdown-row plb-working" style="cursor:pointer" data-lo-perf-modal="meetingAttended" title="Click to view detailed breakdown"><span class="plb-label">Attended <span style="font-size:9px;color:#94A3B8;font-weight:400">(' + invitePct + '% of invites)</span></span><span class="plb-count">' + mainMtg.meetingAttended + '</span></div>' +
    '<div class="perf-leads-breakdown-row" style="background:#F5F3FF;cursor:pointer" data-lo-perf-modal="meetingNPPM" title="Click to view detailed breakdown"><span class="plb-label">NPPM</span><span class="plb-count">' + mainMtg.nppmCount + '</span></div>' +
    '<div class="perf-leads-breakdown-row plb-converted" style="cursor:pointer" data-lo-perf-modal="meetingLeads" title="Click to view detailed breakdown"><span class="plb-label">Leads Referred</span><span class="plb-count">' + mainMtg.leadsReferred + '</span></div>' +
  '</div>';
  const mcRate = parseFloat(mainMtg.conversionRate);
  const mcColor = mcRate > 30 ? '#065F46' : mcRate >= 15 ? '#B45309' : '#BE123C';
  const mcBg = mcRate > 30 ? '#F0FDF4' : mcRate >= 15 ? '#FFFBEB' : '#FFF1F2';
  const meetConvHtml = '<div class="perf-conversion-rate" style="background:' + mcBg + ';border-left-color:' + mcColor + ';justify-content:flex-start"><span class="pcr-label" style="color:' + mcColor + '">' + mainMtg.conversionRate + '% realtors referred leads after meeting</span></div>';

  const meetCols = ['Realtor', 'Branch', 'BD Owner', 'Meeting Attended Date', 'Invite Sent Date', 'NPPM', 'Leads in Pipeline'];
  const meetHead = '<tr>' + meetCols.map(c => '<th>' + c + '</th>').join('') + '</tr>';
  const meetRowHtml = r =>
    '<tr>' +
      '<td style="font-weight:600">' + r.name + '</td>' +
      '<td style="font-size:11px">' + r.branch + '</td>' +
      '<td style="font-size:11px">' + r.owner + '</td>' +
      '<td class="dt">' + (r.attendD ? fmtDate(r.attendD) : '—') + '</td>' +
      '<td class="dt">' + (r.inviteD ? fmtDate(r.inviteD) : '—') + '</td>' +
      '<td style="text-align:center">' + (r.nppm ? '<span style="color:#6D28D9;font-weight:700">Yes</span>' : '<span style="color:#8899BB">—</span>') + '</td>' +
      '<td style="text-align:center;font-weight:700">' + (r.leadCount > 0 ? r.leadCount : '—') + '</td>' +
    '</tr>';
  const meetCsvRow = r => [r.name, r.branch, r.owner, r.attendD ? fmtDate(r.attendD) : '', r.inviteD ? fmtDate(r.inviteD) : '', r.nppm ? 'Yes' : '', r.leadCount > 0 ? r.leadCount : ''];
  const invitesSorted = [...mainMtg.invitesList].sort((a, b) => { const aa = a.attendD ? 1 : 0, ba = b.attendD ? 1 : 0; if (ba !== aa) return ba - aa; return (b.inviteD || 0) - (a.inviteD || 0); });
  const attendedSorted = [...mainMtg.attendedList].sort((a, b) => { if (b.leadCount !== a.leadCount) return b.leadCount - a.leadCount; return (b.attendD || 0) - (a.attendD || 0); });
  const nppmList = attendedSorted.filter(r => r.nppm);
  const meetLeadRows = [];
  for (const r of mainMtg.attendedList) {
    for (const lr of r.leads) {
      const created = parseDate(getField(lr, 'Created Date', 'created date', 'Create Date', 'create date'));
      if (!(r.attendD && created && created >= r.attendD)) continue;
      meetLeadRows.push({
        realtor: r.name, owner: r.owner, attendD: r.attendD,
        leadName: (String(getField(lr, 'First Name', 'first name') || '').trim() + ' ' + String(getField(lr, 'Last Name', 'last name') || '').trim()).trim() || '—',
        status: String(getField(lr, 'Lead Status', 'lead status') || '—').trim(),
        created,
        converted: (() => { const v = getField(lr, 'Converted', 'converted'); return v === true || String(v).toLowerCase() === 'true'; })()
      });
    }
  }
  meetLeadRows.sort((a, b) => { const n = a.realtor.localeCompare(b.realtor); if (n !== 0) return n; return (b.created || 0) - (a.created || 0); });
  const meetLeadCols = ['Realtor', 'BD Owner', 'Meeting Attended Date', 'Lead Name', 'Lead Status', 'Created Date', 'Converted'];

  _loPerfModalCache.clear();
  _loPerfModalCache.set('meetingInvites', { title: lo + ' — Meeting Invites Sent', sub: mainMtg.invitesSent + ' realtor' + (mainMtg.invitesSent !== 1 ? 's' : '') + ' · ' + mainLbl, head: meetHead, body: invitesSorted.map(meetRowHtml).join(''), csvData: [meetCols, ...invitesSorted.map(meetCsvRow)] });
  _loPerfModalCache.set('meetingAttended', { title: lo + ' — Meetings Attended', sub: mainMtg.meetingAttended + ' realtor' + (mainMtg.meetingAttended !== 1 ? 's' : '') + ' · ' + mainLbl, head: meetHead, body: attendedSorted.map(meetRowHtml).join(''), csvData: [meetCols, ...attendedSorted.map(meetCsvRow)] });
  _loPerfModalCache.set('meetingNPPM', { title: lo + ' — NPPM Realtors', sub: nppmList.length + ' realtor' + (nppmList.length !== 1 ? 's' : '') + ' · ' + mainLbl, head: meetHead, body: nppmList.map(meetRowHtml).join(''), csvData: [meetCols, ...nppmList.map(meetCsvRow)] });
  _loPerfModalCache.set('meetingLeads', {
    title: lo + ' — Leads Referred After Meeting',
    sub: meetLeadRows.length + ' lead' + (meetLeadRows.length !== 1 ? 's' : '') + ' · ' + mainLbl,
    head: '<tr>' + meetLeadCols.map(c => '<th>' + c + '</th>').join('') + '</tr>',
    body: meetLeadRows.map(e => '<tr><td style="font-weight:600">' + e.realtor + '</td><td style="font-size:11px">' + e.owner + '</td><td class="dt">' + (e.attendD ? fmtDate(e.attendD) : '—') + '</td><td>' + e.leadName + '</td><td style="font-size:11px">' + e.status + '</td><td class="dt">' + fmtDate(e.created) + '</td><td style="text-align:center">' + (e.converted ? '<span style="color:#085041;font-weight:700">Yes</span>' : '<span style="color:#8899BB">No</span>') + '</td></tr>').join(''),
    csvData: [meetLeadCols, ...meetLeadRows.map(e => [e.realtor, e.owner, e.attendD ? fmtDate(e.attendD) : '', e.leadName, e.status, fmtDate(e.created), e.converted ? 'Yes' : 'No'])]
  });
  _loPerfModalCache.set('loMainHunting',  buildLoHFModal(true,  mainHF.huntingRealtors, lo, mainLbl));
  _loPerfModalCache.set('loMainFarming',  buildLoHFModal(false, mainHF.farmingRealtors, lo, mainLbl));
  if (hasCmp && cmpHF) {
    _loPerfModalCache.set('loCmpHunting', buildLoHFModal(true,  cmpHF.huntingRealtors, lo, cmpLbl));
    _loPerfModalCache.set('loCmpFarming', buildLoHFModal(false, cmpHF.farmingRealtors, lo, cmpLbl));
  }

  // ── Helpers de estilo BD (portados de performance.js: cardTop, ICON, trendBadge) ──
  const ICON = {
    calendar: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    target: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    trendingUp: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    checkCircle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    alertCircle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    briefcase: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>'
  };
  const cardTop = (iconClass, icon, title) =>
    '<div class="perf-card-top"><div class="perf-card-icon ' + iconClass + '">' + icon + '</div><span class="perf-card-title">' + title + '</span></div>';
  const cmpMSorted = hasCmp ? [...cmpMonths0].sort((a, b) => a - b) : [];
  const cmpShort = hasCmp ? ((cmpMSorted.length === 1 ? MS_SHORT[cmpMSorted[0]] : MS_SHORT[cmpMSorted[0]] + '–' + MS_SHORT[cmpMSorted[cmpMSorted.length - 1]]) + ' ' + cmpYear) : '';
  const trendBadge = (main, cmp) => {
    if (!hasCmp || cmp === null || cmp === undefined) return '';
    const diff = main - cmp;
    if (diff === 0) return '<span class="perf-trend-badge perf-trend-neutral">&#8594; no change vs ' + cmpShort + ' <span style="opacity:0.75">(' + cmp + ')</span></span>';
    const up = diff > 0;
    const delta = (up ? '+' : '-') + Math.abs(diff);
    return '<span class="perf-trend-badge ' + (up ? 'perf-trend-up' : 'perf-trend-down') + '">' + (up ? '&#8593; ' : '&#8595; ') + delta + ' vs ' + cmpShort + ' <span style="opacity:0.75">(was ' + cmp + ')</span></span>';
  };

  // ── Open Pipeline (snapshot: opps abiertas de estos LOs, sin filtro de fechas) ──
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
  const openAllRows = [];
  for (const row of (state.oppData || [])) {
    if (!loNames.some(l => matchLo(row, l))) continue;
    const st = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    if (!st || st === 'closed won' || st === 'closed lost') continue;
    const cs = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (cs.includes('archive loan')) continue;
    const ld = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
    if (ld.includes('city lending inc')) continue;
    openAllRows.push(row);
    const cat = openStageCat(st);
    if (cat) openStageRows[cat].push(row);
  }
  const openPipeCount = openAllRows.length;

  const openActiveSet = new Set((state.loActiveResults || []).map(r => r.key));
  const openInactiveSet = new Set((state.loInactiveResults || []).map(r => r.key));
  const openRealtorKeys = new Set(openAllRows.map(row => { const ref = getField(row, 'Referred By', 'referred by'); return ref ? norm(String(ref)) : null; }).filter(Boolean));
  const openLastLeadByKey = new Map();
  for (const lr of (state.leadsData || [])) {
    const ref = getField(lr, 'Referred By', 'referred by');
    if (!ref) continue;
    const k = norm(String(ref));
    if (!openRealtorKeys.has(k)) continue;
    const cd = parseDate(getField(lr, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (cd) { const cur = openLastLeadByKey.get(k); if (!cur || cd > cur) openLastLeadByKey.set(k, cd); }
  }
  let openActive = 0, openInactive = 0;
  for (const k of openRealtorKeys) {
    if (openActiveSet.has(k)) openActive++;
    else if (openInactiveSet.has(k)) openInactive++;
  }
  const openStatusInfo = key => {
    if (openActiveSet.has(key)) return { label: 'Active', color: '#085041' };
    if (openInactiveSet.has(key)) return { label: 'Inactive', color: '#B45309' };
    return { label: 'Unknown', color: '#8899BB' };
  };
  const openDaysColor = d => d == null ? '#8899BB' : d < 30 ? '#085041' : d <= 60 ? '#B45309' : '#BE123C';

  const buildLoOpenDetail = (rows, titleSuffix) => {
    const sorted = [...rows].sort((a, b) =>
      String(getField(a, 'Referred By', 'referred by') || '').localeCompare(String(getField(b, 'Referred By', 'referred by') || '')));
    const head = '<tr>' +
      '<th>Realtor</th><th>Realtor Status</th><th style="text-align:center">Days Since Last Lead</th>' +
      '<th>Loan #</th><th>Opportunity Name</th><th>Branch</th><th>BD Owner</th>' +
      '<th>Created Date</th><th>Pre-Approval Date</th><th>Ratified Date</th><th>Pre-Qual Date</th><th>Est. Closing Date</th>' +
      '<th style="text-align:right">Loan Amount</th></tr>';
    let totalAmt = 0;
    const body = sorted.map(row => {
      const ref = String(getField(row, 'Referred By', 'referred by') || '—').trim();
      const rkey = norm(ref);
      const stInfo = openStatusInfo(rkey);
      const last = openLastLeadByKey.get(rkey);
      const days = last ? Math.floor((today - last) / 86400000) : null;
      const amt = parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0;
      totalAmt += amt;
      return '<tr>' +
        '<td style="font-weight:600">' + ref + '</td>' +
        '<td><span style="font-weight:700;font-size:11px;color:' + stInfo.color + '">' + stInfo.label + '</span></td>' +
        '<td style="text-align:center;font-weight:700;color:' + openDaysColor(days) + '">' + (days == null ? '—' : days + 'd') + '</td>' +
        '<td style="font-family:monospace;font-size:10px;color:#556080">' + (String(getField(row, 'Loan #', 'loan #') || '—').trim()) + '</td>' +
        '<td style="font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis" title="' + (String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim()) + '">' + (String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim()) + '</td>' +
        '<td style="font-size:11px">' + (String(getField(row, 'Branch', 'branch') || '').trim() || '—') + '</td>' +
        '<td style="font-size:11px">' + (String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim() || '—') + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Pre-Qualified Doc requested Date', 'pre-qualified doc requested date', 'pre_qualified_date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'Close Date', 'close date'))) + '</td>' +
        '<td class="modal-amount" style="text-align:right">' + (amt ? '$' + amt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</td>' +
      '</tr>';
    }).join('');
    const csvData = [
      ['Realtor', 'Realtor Status', 'Days Since Last Lead', 'Loan #', 'Opportunity Name', 'Branch', 'BD Owner', 'Created Date', 'Pre-Approval Date', 'Ratified Date', 'Pre-Qual Date', 'Est. Closing Date', 'Loan Amount'],
      ...sorted.map(row => {
        const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
        const rkey = norm(ref);
        const last = openLastLeadByKey.get(rkey);
        const days = last ? Math.floor((today - last) / 86400000) : null;
        const amt = parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0;
        return [ref, openStatusInfo(rkey).label, days == null ? '' : days, String(getField(row, 'Loan #', 'loan #') || '').trim(),
          String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim(), String(getField(row, 'Branch', 'branch') || '').trim(),
          String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim(),
          fmtDate(parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'))),
          fmtDate(parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date'))),
          fmtDate(parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'))),
          fmtDate(parseDate(getField(row, 'Pre-Qualified Doc requested Date', 'pre-qualified doc requested date', 'pre_qualified_date'))),
          fmtDate(parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'Close Date', 'close date'))),
          amt || 0];
      })
    ];
    return {
      title: lo + ' — ' + titleSuffix,
      sub: sorted.length + ' opportunit' + (sorted.length !== 1 ? 'ies' : 'y') + ' · Total: ' + (totalAmt ? '$' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + ' · open today',
      head, body, csvData
    };
  };

  openStageOrder.forEach(k => {
    if (openStageRows[k].length) _loPerfModalCache.set('loOpenStage:' + k, buildLoOpenDetail(openStageRows[k], k));
  });

  // Índices por realtor y por BD (Opportunity Owner) para los modales
  const emptyCats = () => ({ 'Need Analysis': 0, 'Qualification': 0, 'Proposal': 0, 'Negotiation': 0 });
  const pipeStageCols = ['Need Analysis', 'Qualification', 'Proposal', 'Negotiation'];
  const pipeRealtorMap = new Map();
  const pipeOwnerMap = new Map();
  let pipeNoOwner = null;
  for (const row of openAllRows) {
    const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
    const bd = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    const cat = openStageCat(getField(row, 'Stage', 'stage'));
    if (ref) {
      const rk = norm(ref);
      let r = pipeRealtorMap.get(rk);
      if (!r) { r = { name: ref, key: rk, total: 0, cats: emptyCats(), ownerMap: new Map() }; pipeRealtorMap.set(rk, r); }
      r.total++; if (cat) r.cats[cat]++; if (bd) r.ownerMap.set(bd, (r.ownerMap.get(bd) || 0) + 1);
    }
    let g;
    if (!bd) { if (!pipeNoOwner) pipeNoOwner = { name: 'No BD Assigned', total: 0, cats: emptyCats(), realtorKeys: new Set(), noOwner: true }; g = pipeNoOwner; }
    else { const ok = norm(bd); g = pipeOwnerMap.get(ok); if (!g) { g = { name: bd, total: 0, cats: emptyCats(), realtorKeys: new Set() }; pipeOwnerMap.set(ok, g); } }
    g.total++; if (cat) g.cats[cat]++; if (ref) g.realtorKeys.add(norm(ref));
  }
  const openBdCount = pipeOwnerMap.size;

  const bdOwnerDisplay = ownerMap => {
    const e = [...ownerMap.entries()].sort((a, b) => b[1] - a[1]);
    if (!e.length) return '—';
    return e.length > 1 ? e[0][0] + ' (+' + (e.length - 1) + ' more)' : e[0][0];
  };
  const buildLoPipeRealtorModal = (keySet, word) => {
    const rows = [...pipeRealtorMap.values()].filter(r => keySet.has(r.key)).sort((a, b) => b.total - a.total);
    const rowData = rows.map(r => { const last = openLastLeadByKey.get(r.key); return { r, days: last ? Math.floor((today - last) / 86400000) : null }; });
    const head = '<tr><th>Realtor</th><th style="text-align:center">Days Since Last Lead</th><th>BD Owner</th><th style="text-align:center"># Opps</th>' +
      pipeStageCols.map(c => '<th style="text-align:center">' + c + '</th>').join('') + '</tr>';
    const body = rowData.map(({ r, days }) =>
      '<tr>' +
        '<td style="font-weight:600">' + r.name + '</td>' +
        '<td style="text-align:center;font-weight:700;color:' + openDaysColor(days) + '">' + (days == null ? '—' : days + 'd') + '</td>' +
        '<td style="font-size:11px">' + bdOwnerDisplay(r.ownerMap) + '</td>' +
        '<td style="text-align:center;font-weight:700">' + r.total + '</td>' +
        pipeStageCols.map(c => '<td style="text-align:center">' + (r.cats[c] || '—') + '</td>').join('') +
      '</tr>').join('');
    const sumOpps = rows.reduce((s, r) => s + r.total, 0);
    const sumStage = {}; pipeStageCols.forEach(c => sumStage[c] = rows.reduce((s, r) => s + r.cats[c], 0));
    const totals = '<tr style="background:#0B192C;font-family:\'Barlow\',sans-serif;font-weight:700">' +
      '<td style="color:white">TOTAL</td><td style="color:white"></td><td style="color:white"></td>' +
      '<td style="text-align:center;color:white">' + sumOpps + '</td>' +
      pipeStageCols.map(c => '<td style="text-align:center;color:white">' + sumStage[c] + '</td>').join('') + '</tr>';
    return {
      title: lo + ' — ' + word + ' Realtors in Pipeline',
      sub: rows.length + ' realtor' + (rows.length !== 1 ? 's' : '') + ' · open pipeline today',
      head, body: body + totals,
      csvData: [
        ['Realtor', 'Days Since Last Lead', 'BD Owner', '# Opps', ...pipeStageCols],
        ...rowData.map(({ r, days }) => [r.name, days == null ? '' : days, bdOwnerDisplay(r.ownerMap), r.total, ...pipeStageCols.map(c => r.cats[c] || 0)]),
        ['TOTAL', '', '', sumOpps, ...pipeStageCols.map(c => sumStage[c])]
      ]
    };
  };
  _loPerfModalCache.set('loOpenPipeActive', buildLoPipeRealtorModal(openActiveSet, 'Active'));
  _loPerfModalCache.set('loOpenPipeInactive', buildLoPipeRealtorModal(openInactiveSet, 'Inactive'));

  const pipeBdAll = [...pipeOwnerMap.values()].sort((a, b) => b.total - a.total).concat(pipeNoOwner ? [pipeNoOwner] : []);
  const fmtActInact = (a, i) => (a > 0 ? a + ' active' : '—') + (i > 0 ? ' · ' + i + ' inactive' : '');
  const bdRowData = pipeBdAll.map(g => ({
    g,
    activeR: [...g.realtorKeys].filter(k => openActiveSet.has(k)).length,
    inactiveR: [...g.realtorKeys].filter(k => openInactiveSet.has(k)).length,
    pot: openPipeCount ? (g.total / openPipeCount * 100) : 0
  }));
  const bdBody = bdRowData.map(({ g, activeR, inactiveR, pot }) =>
    '<tr' + (g.noOwner ? ' style="background:#FFFBE6"' : '') + '>' +
      '<td style="font-weight:600' + (g.noOwner ? ';color:#B45309' : '') + '">' + g.name + '</td>' +
      '<td style="text-align:center">' + fmtActInact(activeR, inactiveR) + '</td>' +
      '<td style="text-align:center;font-weight:700">' + g.total + '</td>' +
      pipeStageCols.map(c => '<td style="text-align:center">' + (g.cats[c] || '—') + '</td>').join('') +
      '<td style="text-align:center">' + pot.toFixed(1) + '%</td>' +
    '</tr>').join('');
  const bdSumOpps = pipeBdAll.reduce((s, g) => s + g.total, 0);
  const bdSumStage = {}; pipeStageCols.forEach(c => bdSumStage[c] = pipeBdAll.reduce((s, g) => s + g.cats[c], 0));
  const bdTotals = '<tr style="background:#0B192C;font-family:\'Barlow\',sans-serif;font-weight:700">' +
    '<td style="color:white">TOTAL</td><td style="color:white"></td>' +
    '<td style="text-align:center;color:white">' + bdSumOpps + '</td>' +
    pipeStageCols.map(c => '<td style="text-align:center;color:white">' + bdSumStage[c] + '</td>').join('') +
    '<td style="text-align:center;color:white">100%</td></tr>';
  _loPerfModalCache.set('loOpenPipeBD', {
    title: lo + ' — Business Developers in Pipeline',
    sub: openBdCount + ' BD' + (openBdCount !== 1 ? 's' : '') + ' · ' + openPipeCount + ' total open opps',
    head: '<tr><th>BD</th><th style="text-align:center">Active Realtors</th><th style="text-align:center"># Opps</th>' +
      pipeStageCols.map(c => '<th style="text-align:center">' + c + '</th>').join('') + '<th style="text-align:center">% of Pipeline</th></tr>',
    body: bdBody + bdTotals,
    csvData: [
      ['BD', 'Active Realtors', '# Opps', ...pipeStageCols, '% of Pipeline'],
      ...bdRowData.map(({ g, activeR, inactiveR, pot }) => [g.name, fmtActInact(activeR, inactiveR), g.total, ...pipeStageCols.map(c => g.cats[c] || 0), pot.toFixed(1) + '%']),
      ['TOTAL', '', bdSumOpps, ...pipeStageCols.map(c => bdSumStage[c]), '100%']
    ]
  });

  const openPipeAsOf = 'as of ' + MS_SHORT[today.getUTCMonth()] + ' ' + today.getUTCDate() + ', ' + today.getUTCFullYear();
  const briefcaseSm = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>';
  const openPipeRealtorsHtml = '<div style="display:flex;flex-direction:column;gap:4px;margin:8px 0">' +
    '<span class="kpi-clickable" style="font-size:12px;font-weight:600;color:#085041;cursor:pointer" data-lo-perf-modal="loOpenPipeActive" title="Click to view detailed breakdown">&#10003; ' + openActive + ' active realtors</span>' +
    '<span class="kpi-clickable" style="font-size:12px;font-weight:600;color:#B45309;cursor:pointer" data-lo-perf-modal="loOpenPipeInactive" title="Click to view detailed breakdown">&#9201; ' + openInactive + ' inactive realtors</span>' +
    '<span class="kpi-clickable" style="font-size:12px;font-weight:600;color:#1D4ED8;cursor:pointer;text-decoration:underline;margin-top:2px" data-lo-perf-modal="loOpenPipeBD" title="Click to view detailed breakdown">' + briefcaseSm + ' ' + openBdCount + ' business developers</span>' +
  '</div>';
  const openPipeBreakdownHtml = '<div class="perf-leads-breakdown">' +
    openStageOrder.filter(k => openStageRows[k].length > 0).map(k =>
      '<div class="perf-leads-breakdown-row" style="cursor:pointer" data-lo-perf-modal="loOpenStage:' + k + '" title="Click to view detailed breakdown"><span class="plb-label">' + k + '</span><span class="plb-count">' + openStageRows[k].length + '</span></div>'
    ).join('') +
  '</div>';
  const openPipeCardHtml =
    '<div class="perf-kpi-card">' +
      '<div class="perf-card-header-full">' +
        cardTop('perf-icon-blue', ICON.trendingUp, 'Open Pipeline') +
        '<div class="perf-card-period-label">Current snapshot — all open today</div>' +
      '</div>' +
      '<div class="perf-card-body">' +
        '<div class="perf-card-left">' +
          '<div class="perf-kpi-value">' + openPipeCount + '</div>' +
          openPipeRealtorsHtml +
          '<div class="perf-kpi-sub" style="color:#94A3B8">' + openPipeAsOf + '</div>' +
        '</div>' +
        '<div class="perf-card-right">' + openPipeBreakdownHtml + '</div>' +
      '</div>' +
    '</div>';

  // ══ SECCIÓN 03: Results & Closings (Closed Won + Lost) — filtrado por LO, agrupado por BD ══
  const perMain = getPeriodBounds(year, months0, today, false);
  const perStart = perMain.start, perEnd = perMain.end;
  const perCmp = hasCmp ? getPeriodBounds(cmpYear, cmpMonths0, today, true) : null;

  const closingBadge = (main, cmp) => {
    if (!hasCmp || cmp === null || cmp === undefined) return '';
    const diff = main - cmp;
    if (diff === 0) return '<span class="perf-trend-badge perf-trend-neutral">&#8594; no change (' + fmtMoney(cmp) + ')</span>';
    const up = diff > 0;
    const pct = cmp !== 0 ? Math.round(diff / cmp * 100) : null;
    const pctStr = pct !== null ? ' (' + (up ? '+' : '') + pct + '%)' : '';
    return '<span class="perf-trend-badge ' + (up ? 'perf-trend-up' : 'perf-trend-down') + '">' + (up ? '&#8593; +' : '&#8595; -') + fmtMoney(Math.abs(diff)) + pctStr + '</span>';
  };

  const calcLoClosings = (s, e) => {
    const rows = [];
    const byBD = new Map();
    let count = 0, totalAmount = 0;
    for (const row of (state.oppData || [])) {
      if (!loNames.some(l => matchLo(row, l))) continue;
      if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed won') continue;
      const disb = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
      if (!disb || disb < s || disb > e) continue;
      const cs = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
      if (cs.includes('archive loan')) continue;
      const ld = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
      if (ld.includes('city lending inc')) continue;
      const amt = parseFloat(String(getField(row, 'Loan Amount', 'loan amount', 'Amount', 'amount') || '').replace(/[$,]/g, '')) || 0;
      count++; totalAmount += amt;
      const bd = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim() || 'No BD Assigned';
      const g = byBD.get(bd) || { count: 0, amount: 0 }; g.count++; g.amount += amt; byBD.set(bd, g);
      rows.push({ row, amt });
    }
    const bdRows = [...byBD.entries()].map(([bd, v]) => ({ bd, count: v.count, amount: v.amount })).sort((a, b) => b.amount - a.amount);
    return { count, totalAmount, rows, bdRows };
  };
  const mainClosings = calcLoClosings(perStart, perEnd);
  const cmpClosings = hasCmp ? calcLoClosings(perCmp.start, perCmp.end) : null;

  const loanAmtGoal = kpiGoals.loanAmount || 700000;
  const closingAmtPct = loanAmtGoal ? Math.round(mainClosings.totalAmount / loanAmtGoal * 100) : 0;
  const closingAmtCol = closingAmtPct >= 100 ? '#085041' : closingAmtPct >= 60 ? '#D4A000' : '#CC3030';
  const closingBar = '<div class="perf-goal-track" style="margin-top:8px"><div class="perf-goal-fill" style="width:' + Math.min(closingAmtPct, 100) + '%;background:' + closingAmtCol + '"></div></div>';
  const closingBreakdownHtml = mainClosings.bdRows.length
    ? '<div style="margin-top:10px">' + mainClosings.bdRows.slice(0, 3).map(b =>
        '<div class="perf-closing-deal"><span class="pcd-realtor" title="' + b.bd + '">' + b.bd + '</span><span class="pcd-lo">' + b.count + ' closing' + (b.count !== 1 ? 's' : '') + '</span><span class="pcd-amount">' + fmtMoney(b.amount) + '</span></div>'
      ).join('') + (mainClosings.bdRows.length > 3 ? '<div style="font-size:10px;color:#94A3B8;margin-top:4px">+' + (mainClosings.bdRows.length - 3) + ' more BDs</div>' : '') + '</div>'
    : '';

  const closingDaysToClose = row => {
    const disb = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    const rat = parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'));
    const created = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    const base = rat || created;
    return (disb && base) ? Math.max(0, Math.floor((disb - base) / 86400000)) : null;
  };
  const closingModalRows = [...mainClosings.rows].sort((a, b) => b.amt - a.amt);
  _loPerfModalCache.set('closingsDetail', {
    title: lo + ' — Closings',
    sub: mainClosings.count + ' closing' + (mainClosings.count !== 1 ? 's' : '') + ' · ' + fmtMoney(mainClosings.totalAmount) + ' · ' + mainLbl,
    head: '<tr><th>Loan #</th><th>Realtor</th><th>Realtor Status</th><th>Branch</th><th>BD Owner</th><th>Disbursement Date</th><th>Created Date</th><th style="text-align:center">Days to Close</th><th style="text-align:right">Loan Amount</th></tr>',
    body: closingModalRows.map(({ row, amt }) => {
      const ref = String(getField(row, 'Referred By', 'referred by') || '—').trim();
      const st = openStatusInfo(norm(ref));
      const d2c = closingDaysToClose(row);
      return '<tr>' +
        '<td style="font-family:monospace;font-size:10px;color:#556080">' + (String(getField(row, 'Loan #', 'loan #') || '—').trim()) + '</td>' +
        '<td style="font-weight:600">' + ref + '</td>' +
        '<td><span style="font-weight:700;font-size:11px;color:' + st.color + '">' + st.label + '</span></td>' +
        '<td style="font-size:11px">' + (String(getField(row, 'Branch', 'branch') || '').trim() || '—') + '</td>' +
        '<td style="font-size:11px">' + (String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim() || '—') + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Disbursement Date', 'disbursement date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'))) + '</td>' +
        '<td style="text-align:center;font-weight:700">' + (d2c == null ? '—' : d2c + 'd') + '</td>' +
        '<td class="modal-amount" style="text-align:right">' + (amt ? '$' + amt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</td>' +
      '</tr>';
    }).join(''),
    csvData: [
      ['Loan #', 'Realtor', 'Realtor Status', 'Branch', 'BD Owner', 'Disbursement Date', 'Created Date', 'Days to Close', 'Loan Amount'],
      ...closingModalRows.map(({ row, amt }) => {
        const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
        const d2c = closingDaysToClose(row);
        return [String(getField(row, 'Loan #', 'loan #') || '').trim(), ref, openStatusInfo(norm(ref)).label,
          String(getField(row, 'Branch', 'branch') || '').trim(), String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim(),
          fmtDate(parseDate(getField(row, 'Disbursement Date', 'disbursement date'))),
          fmtDate(parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'))),
          d2c == null ? '' : d2c, amt || 0];
      })
    ]
  });

  const closingsCardHtml =
    '<div class="perf-kpi-card">' +
      cardTop('perf-icon-red', ICON.checkCircle, 'Closings vs Goal') +
      '<div style="display:flex;gap:16px">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="perf-kpi-label">Closings</div>' +
          '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left" data-lo-perf-modal="closingsDetail" title="Click to view detailed breakdown">' + mainClosings.count + '</button>' +
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
    '</div>';

  // ── Lost Opportunities (LO filter, agrupado por BD) ──
  const lostInRange = (d, s, e) => d && d >= s && d <= e;
  const calcLoLost = (s, e) => {
    const byBD = new Map();
    const opps = [];
    let total = 0;
    const reached = { 'Reached Ratified': 0, 'Reached Pre-Approval': 0, 'Reached Pre-Qualification': 0 };
    for (const row of (state.oppData || [])) {
      if (!loNames.some(l => matchLo(row, l))) continue;
      if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed lost') continue;
      const ratifD = parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'));
      const preApprD = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre approved date', 'pre_approved_date'));
      const preQualD = parseDate(getField(row, 'Pre-Qualified Doc requested Date', 'pre-qualified doc requested date', 'pre_qualified_date'));
      const inRA = lostInRange(ratifD, s, e), inPA = lostInRange(preApprD, s, e), inPQ = lostInRange(preQualD, s, e);
      if (!inRA && !inPA && !inPQ) continue;
      reached[inRA ? 'Reached Ratified' : inPA ? 'Reached Pre-Approval' : 'Reached Pre-Qualification']++;
      const bd = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim() || 'No BD Assigned';
      const g = byBD.get(bd) || { count: 0 }; g.count++; byBD.set(bd, g);
      total++;
      const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
      const rkey = ref ? norm(ref) : '';
      opps.push({
        lnNum: String(getField(row, 'Loan #', 'loan #') || '—').trim(),
        realtor: ref || '⚠ Unknown Realtor', hasRef: !!ref,
        status: ref ? (openActiveSet.has(rkey) ? 'active' : openInactiveSet.has(rkey) ? 'inactive' : 'unknown') : 'unknown',
        branch: String(getField(row, 'Branch', 'branch') || '').trim() || '—',
        bd, preQualD, preApprD, ratifD,
        reached: inRA ? 'Ratified' : inPA ? 'Pre-Approval' : 'Pre-Qual'
      });
    }
    const bdRows = [...byBD.entries()].map(([bd, v]) => ({ bd, count: v.count })).sort((a, b) => b.count - a.count);
    return { total, reached, bdRows, opps };
  };
  const mainLost = calcLoLost(perStart, perEnd);
  const cmpLost = hasCmp ? calcLoLost(perCmp.start, perCmp.end) : null;

  const lostReachedHtml = '<div>' +
    [['Reached Ratified', mainLost.reached['Reached Ratified'], 'pls-ratified'],
     ['Reached Pre-Appr', mainLost.reached['Reached Pre-Approval'], 'pls-preappr'],
     ['Reached Pre-Qual', mainLost.reached['Reached Pre-Qualification'], 'pls-prequal']]
      .filter(d => d[1] > 0)
      .map(d => '<div class="perf-lost-stage ' + d[2] + '"><span>' + d[0] + '</span><span class="pls-count">' + d[1] + '</span></div>')
      .join('') + '</div>';
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
  const lostModalRows = [...mainLost.opps].sort((a, b) => lostStageOrder[b.reached] - lostStageOrder[a.reached]);
  _loPerfModalCache.set('lostOpps', {
    title: lo + ' — Lost Opportunities',
    sub: mainLost.total + ' opportunit' + (mainLost.total !== 1 ? 'ies' : 'y') + ' · ' + mainLbl,
    head: '<tr><th>Loan #</th><th>Realtor</th><th>Realtor Status</th><th>Branch</th><th>BD Owner</th><th>Pre-Qual Date</th><th>Pre-Approval Date</th><th>Ratified Date</th><th>Stage Reached</th></tr>',
    body: lostModalRows.map(e =>
      '<tr>' +
        '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
        '<td style="font-weight:600' + (e.hasRef ? '' : ';color:#B45309') + '">' + e.realtor + '</td>' +
        '<td>' + lostStatusChip(e.status) + '</td>' +
        '<td style="font-size:11px">' + e.branch + '</td>' +
        '<td style="font-size:11px">' + e.bd + '</td>' +
        '<td class="dt">' + (e.preQualD ? fmtDate(e.preQualD) : '—') + '</td>' +
        '<td class="dt">' + (e.preApprD ? fmtDate(e.preApprD) : '—') + '</td>' +
        '<td class="dt">' + (e.ratifD ? fmtDate(e.ratifD) : '—') + '</td>' +
        '<td>' + lostStageChip(e.reached) + '</td>' +
      '</tr>').join(''),
    csvData: [
      ['Loan #', 'Realtor', 'Realtor Status', 'Branch', 'BD Owner', 'Pre-Qual Date', 'Pre-Approval Date', 'Ratified Date', 'Stage Reached'],
      ...lostModalRows.map(e => [e.lnNum, e.realtor, e.status, e.branch, e.bd,
        e.preQualD ? fmtDate(e.preQualD) : '', e.preApprD ? fmtDate(e.preApprD) : '', e.ratifD ? fmtDate(e.ratifD) : '', e.reached])
    ]
  });
  const lostBdTableHtml = mainLost.bdRows.length
    ? '<div style="margin-top:10px"><table class="perf-lost-table" style="width:100%"><thead><tr><th>BD</th><th style="text-align:center"># Lost</th></tr></thead><tbody>' +
      mainLost.bdRows.slice(0, 3).map(b => '<tr><td>' + b.bd + '</td><td style="text-align:center;font-weight:700">' + b.count + '</td></tr>').join('') +
      (mainLost.bdRows.length > 3 ? '<tr><td colspan="2" style="font-size:10px;color:#94A3B8">+' + (mainLost.bdRows.length - 3) + ' more BDs</td></tr>' : '') +
      '</tbody></table></div>'
    : '';

  const lostCardHtml =
    '<div class="perf-kpi-card">' +
      '<div class="perf-card-header-full">' +
        cardTop('perf-icon-amber', ICON.alertCircle, 'Lost Opportunities') +
        '<div class="perf-card-period-label">Closed Lost with milestone in period</div>' +
      '</div>' +
      (mainLost.total === 0
        ? '<div style="color:#1D9E75;font-size:12px;font-weight:600;padding:10px 0">No lost opportunities in this period &#10003;</div>'
        : '<div class="perf-card-body">' +
            '<div class="perf-card-left">' +
              '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left" data-lo-perf-modal="lostOpps" title="Click to view detailed breakdown">' + mainLost.total + '</button>' +
              trendBadge(mainLost.total, cmpLost ? cmpLost.total : null) +
            '</div>' +
            '<div class="perf-card-right">' + lostReachedHtml + '</div>' +
          '</div>' +
          lostBdTableHtml
      ) +
    '</div>';

  // ══ Opportunities Created (LO filter, breakdown por stage, agrupado por realtor) ══
  const oppcFilter = (s, e) => (state.oppData || []).filter(row => {
    if (!loNames.some(l => matchLo(row, l))) return false;
    const cd = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (!cd || cd < s || cd > e) return false;
    const cs = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (cs.includes('archive loan')) return false;
    const ld = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
    if (ld.includes('city lending inc')) return false;
    return true;
  });
  const oppCreatedRows = oppcFilter(perStart, perEnd);
  const cmpOppCreated = hasCmp ? oppcFilter(perCmp.start, perCmp.end).length : null;

  const oppcStageCat = raw => {
    const s = String(raw || '').toLowerCase();
    if (s.includes('need analysis') || s.includes('needs analysis')) return 'Need Analysis';
    if (s.includes('qualification')) return 'Qualification';
    if (s.includes('proposal')) return 'Proposal';
    if (s.includes('negotiation')) return 'Negotiation';
    if (s.includes('closed won')) return 'Closed Won';
    if (s.includes('closed lost')) return 'Closed Lost';
    return 'Others';
  };
  const oppcStageOrder = ['Need Analysis', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost', 'Others'];
  const oppcStageStyle = { 'Need Analysis': { cls: ' plb-new', bg: '' }, 'Qualification': { cls: ' plb-working', bg: '' }, 'Proposal': { cls: '', bg: '#EFF6FF' }, 'Negotiation': { cls: '', bg: '#F5F3FF' }, 'Closed Won': { cls: '', bg: '#F0FDF4' }, 'Closed Lost': { cls: ' plb-discarded', bg: '' }, 'Others': { cls: ' plb-other', bg: '' } };
  const oppcStageCounts = {}; oppcStageOrder.forEach(k => oppcStageCounts[k] = 0);
  const oppcRealtorMap = new Map();
  let oppcUnknown = null;
  for (const row of oppCreatedRows) {
    const cat = oppcStageCat(getField(row, 'Stage', 'stage'));
    oppcStageCounts[cat]++;
    const bd = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    const ref = String(getField(row, 'Referred By', 'referred by') || '').trim();
    let r;
    if (!ref) {
      if (!oppcUnknown) { oppcUnknown = { name: '⚠ Unknown Realtor', total: 0, cats: {}, ownerMap: new Map(), unknown: true }; oppcStageOrder.forEach(k => oppcUnknown.cats[k] = 0); }
      r = oppcUnknown;
    } else {
      const key = norm(ref);
      r = oppcRealtorMap.get(key);
      if (!r) { r = { name: ref, total: 0, cats: {}, ownerMap: new Map() }; oppcStageOrder.forEach(k => r.cats[k] = 0); oppcRealtorMap.set(key, r); }
    }
    r.total++; r.cats[cat]++;
    if (bd) r.ownerMap.set(bd, (r.ownerMap.get(bd) || 0) + 1);
  }
  const oppcTotal = oppCreatedRows.length;
  const oppcRealtorRows = [...oppcRealtorMap.values()].sort((a, b) => b.total - a.total);
  const oppcUniqueRealtors = oppcRealtorRows.length;
  const oppcUnknownCount = oppcUnknown ? oppcUnknown.total : 0;
  const oppcPctLost = oppcTotal ? (oppcStageCounts['Closed Lost'] / oppcTotal * 100) : 0;
  const oppsGoal = kpiGoals.pipelineOpps || 10;
  const oppcGoalPct = oppsGoal > 0 ? Math.round(oppcTotal / oppsGoal * 100) : 0;

  const oppcBreakdownHtml = '<div class="perf-leads-breakdown">' +
    oppcStageOrder.filter(k => oppcStageCounts[k] > 0).map(k => {
      const st = oppcStageStyle[k];
      return '<div class="perf-leads-breakdown-row' + st.cls + '"' + (st.bg ? ' style="background:' + st.bg + '"' : '') + '><span class="plb-label">' + k + '</span><span class="plb-count">' + oppcStageCounts[k] + '</span></div>';
    }).join('') +
    '<div class="perf-leads-breakdown-row" style="background:' + (oppcPctLost > 20 ? '#FFF1F2' : '#F8FAFC') + '"><span class="plb-label">% Lost</span><span class="plb-count" style="color:' + (oppcPctLost > 20 ? '#BE123C' : '#64748B') + '">' + oppcPctLost.toFixed(1) + '%</span></div>' +
  '</div>';

  // Modal: Realtors — Opportunities Breakdown
  const oppcStageCols = ['Need Analysis', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
  const oppcLostColor = p => p > 30 ? '#BE123C' : p >= 15 ? '#B45309' : '#065F46';
  const bdDisplay = ownerMap => { const s = (ownerMap && ownerMap.size) ? [...ownerMap.entries()].sort((a, b) => b[1] - a[1]) : []; if (!s.length) return '—'; return s.length > 1 ? s[0][0] + ' (+' + (s.length - 1) + ' more)' : s[0][0]; };
  const oppcModalRows = oppcUnknown ? [...oppcRealtorRows, oppcUnknown] : oppcRealtorRows;
  const oppcSumTotal = oppcModalRows.reduce((s, r) => s + r.total, 0);
  const oppcSumStage = {}; oppcStageCols.forEach(c => oppcSumStage[c] = oppcModalRows.reduce((s, r) => s + r.cats[c], 0));
  const oppcTotalPctLost = oppcSumTotal ? (oppcSumStage['Closed Lost'] / oppcSumTotal * 100) : 0;
  _loPerfModalCache.set('loOppRealtors', {
    title: 'Realtors — Opportunities Breakdown',
    sub: oppcUniqueRealtors + ' realtor' + (oppcUniqueRealtors !== 1 ? 's' : '') + (oppcUnknownCount ? ' · ' + oppcUnknownCount + ' unknown' : '') + ' · ' + lo + ' · ' + mainLbl,
    head: '<tr><th>Realtor</th><th>BD Owner</th><th style="text-align:center">Total</th>' + oppcStageCols.map(c => '<th style="text-align:center">' + c + '</th>').join('') + '<th style="text-align:center">% of Total</th><th style="text-align:center">% Lost</th></tr>',
    body: oppcModalRows.map(r => {
      const pot = oppcTotal ? (r.total / oppcTotal * 100) : 0;
      const rl = r.total ? (r.cats['Closed Lost'] / r.total * 100) : 0;
      return '<tr' + (r.unknown ? ' style="background:#FFFBE6"' : '') + '>' +
        '<td style="font-weight:600' + (r.unknown ? ';color:#B45309' : '') + '">' + r.name + '</td>' +
        '<td style="font-size:11px">' + bdDisplay(r.ownerMap) + '</td>' +
        '<td style="text-align:center;font-weight:700">' + r.total + '</td>' +
        oppcStageCols.map(c => '<td style="text-align:center">' + r.cats[c] + '</td>').join('') +
        '<td style="text-align:center">' + pot.toFixed(1) + '%</td>' +
        '<td style="text-align:center;font-weight:700;color:' + oppcLostColor(rl) + '">' + rl.toFixed(1) + '%</td>' +
      '</tr>';
    }).join('') +
      '<tr style="background:#0B192C;font-family:\'Barlow\',sans-serif;font-weight:700"><td style="color:white">TOTAL</td><td style="color:white"></td><td style="text-align:center;color:white">' + oppcSumTotal + '</td>' + oppcStageCols.map(c => '<td style="text-align:center;color:white">' + oppcSumStage[c] + '</td>').join('') + '<td style="text-align:center;color:white">100%</td><td style="text-align:center;color:white">' + oppcTotalPctLost.toFixed(1) + '%</td></tr>',
    csvData: [
      ['Realtor', 'BD Owner', 'Total', ...oppcStageCols, '% of Total', '% Lost'],
      ...oppcModalRows.map(r => { const pot = oppcTotal ? (r.total / oppcTotal * 100) : 0; const rl = r.total ? (r.cats['Closed Lost'] / r.total * 100) : 0; return [r.name, bdDisplay(r.ownerMap), r.total, ...oppcStageCols.map(c => r.cats[c]), pot.toFixed(1) + '%', rl.toFixed(1) + '%']; }),
      ['TOTAL', '', oppcSumTotal, ...oppcStageCols.map(c => oppcSumStage[c]), '100%', oppcTotalPctLost.toFixed(1) + '%']
    ]
  });

  // Modal: opportunities detail (número principal)
  const oppcCreatedDate = row => parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
  const oppcDetailRows = [...oppCreatedRows].sort((a, b) => (oppcCreatedDate(b) || 0) - (oppcCreatedDate(a) || 0));
  const oppcDetailCols = ['Loan #', 'Opportunity Name', 'Realtor', 'Loan Officer', 'BD Owner', 'Stage', 'Pre-Approval Date', 'Ratified Date', 'Est. Closing Date', 'Disbursement Date', 'Created Date', 'Loan Amount'];
  _loPerfModalCache.set('loOppCreated', {
    title: lo + ' — Opportunities Created',
    sub: oppcTotal + ' opportunit' + (oppcTotal !== 1 ? 'ies' : 'y') + ' · ' + mainLbl,
    head: '<tr>' + oppcDetailCols.map(c => '<th' + (c === 'Loan Amount' ? ' style="text-align:right"' : '') + '>' + c + '</th>').join('') + '</tr>',
    body: oppcDetailRows.map(row => {
      const amt = parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0;
      return '<tr>' +
        '<td style="font-family:monospace;font-size:10px;color:#556080">' + (String(getField(row, 'Loan #', 'loan #') || '—').trim()) + '</td>' +
        '<td style="font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis" title="' + (String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim()) + '">' + (String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim()) + '</td>' +
        '<td>' + (String(getField(row, 'Referred By', 'referred by') || '—').trim()) + '</td>' +
        '<td style="font-size:11px">' + (String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '—').trim()) + '</td>' +
        '<td style="font-size:11px">' + (String(getField(row, 'Opportunity Owner', 'opportunity owner') || '—').trim()) + '</td>' +
        '<td style="font-size:11px">' + (String(getField(row, 'Stage', 'stage') || '—').trim()) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'Close Date', 'close date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Disbursement Date', 'disbursement date'))) + '</td>' +
        '<td class="dt">' + fmtDate(oppcCreatedDate(row)) + '</td>' +
        '<td class="modal-amount" style="text-align:right">' + (amt ? '$' + amt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</td>' +
      '</tr>';
    }).join(''),
    csvData: [oppcDetailCols, ...oppcDetailRows.map(row => {
      const amt = parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0;
      return [String(getField(row, 'Loan #', 'loan #') || '').trim(), String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim(), String(getField(row, 'Referred By', 'referred by') || '').trim(), String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '').trim(), String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim(), String(getField(row, 'Stage', 'stage') || '').trim(), fmtDate(parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date'))), fmtDate(parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'))), fmtDate(parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'Close Date', 'close date'))), fmtDate(parseDate(getField(row, 'Disbursement Date', 'disbursement date'))), fmtDate(oppcCreatedDate(row)), amt || 0];
    })]
  });

  const oppCreatedCardHtml =
    '<div class="perf-kpi-card">' +
      '<div class="perf-card-header-full">' +
        cardTop('perf-icon-blue', ICON.briefcase, 'Opportunities Created') +
        '<div class="perf-card-period-label">During selected period</div>' +
      '</div>' +
      '<div class="perf-card-body">' +
        '<div class="perf-card-left">' +
          '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left" data-lo-perf-modal="loOppCreated" title="Click to view detailed breakdown">' + oppcTotal + '</button>' +
          '<div class="perf-kpi-sub"><button class="kpi-clickable" style="font:inherit;font-weight:700;color:#334466;background:none;border:none;cursor:pointer;padding:0" data-lo-perf-modal="loOppRealtors" title="Click to view detailed breakdown">' + oppcUniqueRealtors + '</button> unique realtors' + (oppcUnknownCount > 0 ? ' · <span style="color:#B45309;font-weight:600">' + oppcUnknownCount + ' unknown</span>' : '') + '</div>' +
          '<div class="perf-kpi-sub"><span style="color:' + (oppcGoalPct >= 100 ? '#085041' : oppcGoalPct >= 60 ? '#D4A000' : '#CC3030') + ';font-weight:700">' + oppcGoalPct + '%</span> of goal</div>' +
          trendBadge(oppcTotal, cmpOppCreated) +
        '</div>' +
        '<div class="perf-card-right">' + oppcBreakdownHtml + '</div>' +
      '</div>' +
    '</div>';

  content.innerHTML =
    '<div class="perf-banner"><span class="perf-banner-main">' + mainLbl + '</span>' +
      (hasCmp ? '<span class="perf-banner-vs">vs</span><span class="perf-banner-cmp">' + cmpLbl + '</span>' : '') +
    '</div>' +
    '<div class="perf-owner-heading">' + lo + '</div>' +

    '<div class="perf-section-label">01 &mdash; Pipeline &amp; Inputs</div>' +
    '<div class="perf-grid-2">' +
      oppCreatedCardHtml +
      openPipeCardHtml +
    '</div>' +

    '<div class="perf-section-label">02 &mdash; LO Activity</div>' +
    '<div class="perf-grid-2">' +

    // Card 1: Meetings Attended (realtorOwnerMap funnel)
    '<div class="perf-kpi-card">' +
      '<div class="perf-card-header-full">' +
        cardTop('perf-icon-green', ICON.calendar, 'Meetings Attended') +
        '<div class="perf-card-period-label">During selected period</div>' +
      '</div>' +
      '<div class="perf-card-body">' +
        '<div class="perf-card-left">' +
          '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left" data-lo-perf-modal="meetingAttended">' + mainMtg.meetingAttended + '</button>' +
          '<div class="perf-kpi-sub">meetings attended</div>' +
          meetConvHtml +
          trendBadge(mainMtg.meetingAttended, cmpMtg ? cmpMtg.meetingAttended : null) +
        '</div>' +
        '<div class="perf-card-right">' + meetBreakdownHtml + '</div>' +
      '</div>' +
    '</div>' +

    // Card 2: B2B Behavior (BD icon-card style)
    '<div class="perf-kpi-card">' +
      cardTop('perf-icon-green', ICON.target, 'B2B Behavior') +
      '<div class="perf-b2b-window-compact">Based on Metrics window: ' + fmtShortDate(mainHFBase) + ' → ' + fmtShortDate(mainHFCutoff) + '</div>' +
      '<div class="perf-hf-row">' +
        '<div class="perf-hf-block">' +
          '<div class="perf-kpi-label" style="color:#A32D2D">Hunting</div>' +
          '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left;color:#A32D2D" data-lo-perf-modal="loMainHunting">' + mainHF.hunting + '</button>' +
          '<div class="perf-kpi-sub">' + hPct + '% of active</div>' +
          hfChip(mainHF.hunting, teamAvg.avgH) +
          trendBadge(mainHF.hunting, cmpHF ? cmpHF.hunting : null) +
        '</div>' +
        '<div class="perf-hf-divider"></div>' +
        '<div class="perf-hf-block">' +
          '<div class="perf-kpi-label" style="color:#085041">Farming</div>' +
          '<button class="perf-kpi-value kpi-clickable" style="background:none;border:none;padding:0;cursor:pointer;text-align:left;color:#085041" data-lo-perf-modal="loMainFarming">' + mainHF.farming + '</button>' +
          '<div class="perf-kpi-sub">' + fPct + '% of active</div>' +
          hfChip(mainHF.farming, teamAvg.avgF) +
          trendBadge(mainHF.farming, cmpHF ? cmpHF.farming : null) +
        '</div>' +
      '</div>' +
      '<div class="perf-hf-team-avg">Team avg: ' + teamAvg.avgH.toFixed(1) + 'H / ' + teamAvg.avgF.toFixed(1) + 'F &middot; ' + fmtShortDate(mainHFBase) + ' → ' + fmtShortDate(mainHFCutoff) + '</div>' +
    '</div>' +
    '</div>' +

    '<div class="perf-section-label">03 &mdash; Results &amp; Closings</div>' +
    '<div class="perf-grid-2">' +
      closingsCardHtml +
      lostCardHtml +
    '</div>';
}

function populateLoSelects() {
  const ownerEl = document.getElementById('lo-perf-owner');
  if (!ownerEl) return;

  const los = getAllowedLOs();
  ownerEl.innerHTML = los.map(lo => '<option value="' + lo + '">' + lo + '</option>').join('');

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
  const curY = today.getUTCFullYear();

  const yearEl = document.getElementById('lo-perf-year');
  if (yearEl) {
    const pv = yearEl.value;
    yearEl.innerHTML = yOpts;
    yearEl.value = pv || String(curY);
    if (!yearEl.value && sortedYears.length) yearEl.value = String(sortedYears[0]);
  }
  const cmpYearEl = document.getElementById('lo-perf-cmp-year');
  if (cmpYearEl) {
    const pv = cmpYearEl.value;
    cmpYearEl.innerHTML = yOpts;
    cmpYearEl.value = pv || String(curY);
    if (!cmpYearEl.value && sortedYears.length) cmpYearEl.value = String(sortedYears[0]);
  }

  const monthsEl = document.getElementById('lo-perf-months');
  const cmpMonthsEl = document.getElementById('lo-perf-cmp-months');
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

export function initLoPerformance() {
  populateLoSelects();
  renderLoPerformance();
}

// Event delegation for LO Performance modal clicks
document.addEventListener('click', e => {
  const el = e.target.closest('[data-lo-perf-modal]');
  if (!el) return;
  const key = el.getAttribute('data-lo-perf-modal');
  const m = _loPerfModalCache.get(key);
  if (m) openModal(m.title, m.sub, m.head, m.body, m.csvData);
});
