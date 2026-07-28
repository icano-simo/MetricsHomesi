import { state } from './state.js';
import { norm, parseDate, fmtDate, getField, initials, normalizeLO } from './utils.js';
import { openModal, pushModalView } from './modal.js';
import { renderModalFilters } from './modal-filters.js';
import { dl } from './export.js';
import { buildHealthBreakdown, openHealthModal, healthChipHtml } from './pipeline.js';

const _healthCacheLoP = new Map();
// Drill-down de Pipeline LO: Realtor clickeable → todas sus opps con este LO (← Back)
const _loPipeDrill = new Map();
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _loCwDetailCache = new Map();

function getAllowedLOs() {
  return document.getElementById('lo-list').value
    .split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== '');
}

function getLoInactiveCutoff() {
  const val = document.getElementById('lo-pl-inactive-cutoff').value;
  if (val) return new Date(val + 'T00:00:00Z');
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 60); d.setUTCHours(0, 0, 0, 0);
  return d;
}

function statusChipHtml(status) {
  if (status === 'active') return '<span class="pl-status-chip pl-chip-active">Active</span>';
  if (status === 'inactive') return '<span class="pl-status-chip pl-chip-inactive">Inactive</span>';
  return '<span class="pl-status-chip pl-chip-unknown">No Data</span>';
}

function fmtCompactAmt(n) {
  if (!n || isNaN(n)) return '$0';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function buildRealtorCacheLo(realtorKeys, inactiveCutoff) {
  const keySet = new Set(realtorKeys);
  const latestDates = new Map();
  for (const row of (state.leadsData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (!ref) continue;
    const key = norm(String(ref));
    if (!keySet.has(key)) continue;
    const cd = parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'));
    if (cd) { const cur = latestDates.get(key); if (!cur || cd > cur) latestDates.set(key, cd); }
  }
  const cache = new Map();
  const now = new Date();
  for (const key of keySet) {
    const d = latestDates.get(key);
    if (!d) { cache.set(key, { status: 'unknown', daysSince: null }); continue; }
    const daysSince = Math.floor((now - d) / 86400000);
    cache.set(key, { status: d >= inactiveCutoff ? 'active' : 'inactive', daysSince });
  }
  return cache;
}

function matchLo(row, lo) {
  const loRaw = String(getField(row, 'Loan Officers', 'loan officers', 'Loan Officer', 'loan officer') || '').trim();
  return normalizeLO(loRaw) === normalizeLO(lo);
}

export function initLoPipeline() {
  const defaultCutoff = new Date(); defaultCutoff.setUTCDate(defaultCutoff.getUTCDate() - 60);
  const cutoffEl = document.getElementById('lo-pl-inactive-cutoff');
  if (!cutoffEl.value) cutoffEl.value = defaultCutoff.toISOString().split('T')[0];

  const los = getAllowedLOs();
  const loEl = document.getElementById('lo-pl-filter-lo');
  const prev = Array.from(loEl.selectedOptions).map(o => o.value);
  loEl.innerHTML = los.map(lo => '<option value="' + lo + '"' + (prev.includes(lo) ? ' selected' : '') + '>' + lo + '</option>').join('');

  const cwOpps = (state.oppData || []).filter(row => {
    if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed won') return false;
    return los.some(lo => matchLo(row, lo));
  });
  const branches = [...new Set(cwOpps.map(r => String(getField(r, 'Branch', 'branch') || '').trim() || null).filter(Boolean))].sort();
  const branchEl = document.getElementById('lo-pl-filter-cw-branch');
  const prevBranches = Array.from(branchEl.selectedOptions).map(o => o.value);
  branchEl.innerHTML = branches.map(b => '<option value="' + b + '"' + (prevBranches.includes(b) ? ' selected' : '') + '>' + b + '</option>').join('');

  renderLoPipeline();
  renderLoCwSection();
}

export function renderLoPipeline() {
  const inactiveCutoff = getLoInactiveCutoff();
  const filterLos = Array.from(document.getElementById('lo-pl-filter-lo').selectedOptions).map(o => o.value).filter(Boolean);
  const allowedLOs = getAllowedLOs();

  const openOpps = (state.oppData || []).filter(row => {
    const stage = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    if (!stage || stage === 'closed won' || stage === 'closed lost') return false;
    const currStatus = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (currStatus.includes('archive loan')) return false;
    const lender = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
    if (lender.includes('city lending inc')) return false;
    return allowedLOs.some(lo => matchLo(row, lo));
  });

  const byLo = new Map();
  for (const row of openOpps) {
    const loRaw = String(getField(row, 'Loan Officers', 'loan officers', 'Loan Officer', 'loan officer') || '').trim();
    const lo = normalizeLO(loRaw) || loRaw;
    if (!lo) continue;
    if (!byLo.has(lo)) byLo.set(lo, []);
    byLo.get(lo).push(row);
  }

  const los = (filterLos.length
    ? [...byLo.keys()].filter(lo => filterLos.some(f => normalizeLO(f) === normalizeLO(lo)))
    : [...byLo.keys()]
  ).sort();

  if (!los.length) {
    document.getElementById('lo-pl-pipeline-content').innerHTML = '<div class="empty-state">No open opportunities found for these Loan Officers</div>';
    return;
  }

  const allRealtorKeys = [...new Set(openOpps.map(r => {
    const ref = getField(r, 'Referred By', 'referred by');
    return ref ? norm(String(ref)) : null;
  }).filter(Boolean))];
  const realtorCache = buildRealtorCacheLo(allRealtorKeys, inactiveCutoff);

  // ── Tarjeta agregada "ALL LOs" (mismo patrón/estilo que "ALL BDs" de BD) ──
  _healthCacheLoP.clear();
  const allOppsLo = los.flatMap(lo => byLo.get(lo) || []);
  _healthCacheLoP.set('ALL', allOppsLo);
  const allStageMap = new Map();
  for (const row of allOppsLo) {
    const stage = String(getField(row, 'Stage', 'stage') || '—').trim();
    if (!allStageMap.has(stage)) allStageMap.set(stage, []);
    allStageMap.get(stage).push(row);
  }
  const allTotalAmt = allOppsLo.reduce((s, r) => { const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0); return s + (isNaN(a) ? 0 : a); }, 0);
  const allRealtorKeys2 = [...new Set(allOppsLo.map(r => { const ref = getField(r, 'Referred By', 'referred by'); return ref ? norm(String(ref)) : null; }).filter(Boolean))];
  let aAct = 0, aIn = 0, aUn = 0;
  for (const key of allRealtorKeys2) {
    const st = (realtorCache.get(key) || {}).status || 'unknown';
    if (st === 'active') aAct++; else if (st === 'inactive') aIn++; else aUn++;
  }
  const allStageRank = { 'need analysis': 0, 'needs analysis': 0, 'qualification': 1, 'proposal': 2, 'negotiation': 3 };
  const allStageRows = [...allStageMap.entries()]
    .sort(([a], [b]) => { const n = s => s.toLowerCase().replace(/\s+/g, ' ').trim(); return (allStageRank[n(a)] ?? 999) - (allStageRank[n(b)] ?? 999); })
    .map(([stage, rows]) => {
      const stageAmt = rows.reduce((s, r) => { const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0); return s + (isNaN(a) ? 0 : a); }, 0);
      const fmtAmt = stageAmt ? '$' + stageAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
      return '<div class="pl-stage-item" data-lo-pl-lo="ALL" data-lo-pl-stage="' + stage.replace(/"/g, '&quot;') + '">' +
        '<div class="pl-stage-info"><div class="pl-stage-title">' + stage + '</div>' +
        (fmtAmt ? '<div class="pl-stage-amt2">' + fmtAmt + '</div>' : '') + '</div>' +
        '<div class="pl-stage-num">' + rows.length + '</div></div>';
    }).join('');
  const allCard =
    '<div class="pl-owner-card all-bds">' +
      '<div class="pl-allbds-header">' +
        '<div>' +
          '<div class="pl-allbds-title">ALL LOs</div>' +
          '<div class="pl-allbds-sub">' + los.length + ' Loan Officer' + (los.length !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="pl-allbds-right">' +
          '<div class="pl-allbds-amt">' + fmtCompactAmt(allTotalAmt) + '</div>' +
          '<div class="pl-allbds-sub">' + allOppsLo.length + ' open opportunit' + (allOppsLo.length !== 1 ? 'ies' : 'y') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pl-allbds-stats">' +
        '<div class="pl-allbds-stat"><div class="pl-allbds-stat-num" style="color:#1D9E75">' + aAct + '</div><div class="pl-allbds-stat-label">Active</div></div>' +
        '<div class="pl-allbds-stat"><div class="pl-allbds-stat-num" style="color:#E65100">' + aIn + '</div><div class="pl-allbds-stat-label">Inactive</div></div>' +
        '<div class="pl-allbds-stat"><div class="pl-allbds-stat-num" style="color:#8899BB">' + aUn + '</div><div class="pl-allbds-stat-label">No data</div></div>' +
      '</div>' +
      '<div class="pipeline-stages-list">' + allStageRows + '</div>' +
      buildHealthBreakdown(allOppsLo, 'ALL') +
    '</div>';

  document.getElementById('lo-pl-pipeline-content').innerHTML = '<div class="pipeline-owners-grid">' + allCard + los.map(lo => {
    const opps = byLo.get(lo) || [];
    _healthCacheLoP.set(lo, opps);
    const stageMap = new Map();
    for (const row of opps) {
      const stage = String(getField(row, 'Stage', 'stage') || '—').trim();
      if (!stageMap.has(stage)) stageMap.set(stage, []);
      stageMap.get(stage).push(row);
    }
    const totalAmt = opps.reduce((s, r) => { const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0); return s + (isNaN(a) ? 0 : a); }, 0);
    const realtorKeys = [...new Set(opps.map(r => { const ref = getField(r, 'Referred By', 'referred by'); return ref ? norm(String(ref)) : null; }).filter(Boolean))];
    let activeCount = 0, inactiveCount = 0, unknownCount = 0;
    for (const key of realtorKeys) {
      const st = (realtorCache.get(key) || {}).status || 'unknown';
      if (st === 'active') activeCount++;
      else if (st === 'inactive') inactiveCount++;
      else unknownCount++;
    }
    const stageRank = { 'need analysis': 0, 'needs analysis': 0, 'qualification': 1, 'proposal': 2, 'negotiation': 3 };
    const stageRows = [...stageMap.entries()]
      .sort(([a], [b]) => { const n = s => s.toLowerCase().replace(/\s+/g, ' ').trim(); return (stageRank[n(a)] ?? 999) - (stageRank[n(b)] ?? 999); })
      .map(([stage, rows]) => {
        const stageAmt = rows.reduce((s, r) => { const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0); return s + (isNaN(a) ? 0 : a); }, 0);
        const fmtAmt = stageAmt ? '$' + stageAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
        return '<div class="pl-stage-item" data-lo-pl-lo="' + lo.replace(/"/g, '&quot;') + '" data-lo-pl-stage="' + stage.replace(/"/g, '&quot;') + '">' +
          '<div class="pl-stage-info">' +
            '<div class="pl-stage-title">' + stage + '</div>' +
            (fmtAmt ? '<div class="pl-stage-amt2">' + fmtAmt + '</div>' : '') +
          '</div>' +
          '<div class="pl-stage-num">' + rows.length + '</div>' +
        '</div>';
      }).join('');
    return '<div class="pl-owner-card">' +
      '<div class="pl-owner-header">' +
        '<div class="pl-owner-avatar">' + initials(lo) + '</div>' +
        '<div class="pl-owner-info">' +
          '<div class="pl-owner-name">' + lo + '</div>' +
          '<div class="pl-owner-meta">' + opps.length + ' open opp' + (opps.length !== 1 ? 's' : '') + ' · ' + realtorKeys.length + ' realtor' + (realtorKeys.length !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="pl-owner-total">' + (totalAmt ? '$' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</div>' +
      '</div>' +
      '<div class="pl-realtor-summary">' +
        '<span class="pl-rs-item pl-chip-active"><i class="ti ti-check"></i> ' + activeCount + ' active</span>' +
        '<span class="pl-rs-item pl-chip-inactive"><i class="ti ti-clock"></i> ' + inactiveCount + ' inactive</span>' +
        (unknownCount ? '<span class="pl-rs-item pl-chip-unknown"><i class="ti ti-help"></i> ' + unknownCount + ' no data</span>' : '') +
      '</div>' +
      '<div class="pipeline-stages-list">' + stageRows + '</div>' +
      buildHealthBreakdown(opps, lo) +
    '</div>';
  }).join('') + '</div>';
}

function showLoPipelineStageDetail(lo, stage) {
  const inactiveCutoff = getLoInactiveCutoff();
  const today = new Date();
  const isAll = lo === 'ALL';
  const allowedLOsForAll = isAll ? getAllowedLOs() : null;
  const rows = (state.oppData || []).filter(row => {
    if (String(getField(row, 'Stage', 'stage') || '—').trim() !== stage) return false;
    if (isAll) {
      const st = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
      if (!st || st === 'closed won' || st === 'closed lost') return false;
      const currStatus = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
      if (currStatus.includes('archive loan')) return false;
      if (String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase().includes('city lending inc')) return false;
      return allowedLOsForAll.some(l => matchLo(row, l));
    }
    if (!matchLo(row, lo)) return false;
    return !String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase().includes('city lending inc');
  });
  if (!rows.length) return;
  _loPipeDrill.clear();
  const realtorKeys = [...new Set(rows.map(row => { const ref = getField(row, 'Referred By', 'referred by'); return ref ? norm(String(ref)) : null; }).filter(Boolean))];
  const cache = buildRealtorCacheLo(realtorKeys, inactiveCutoff);
  const enriched = rows.map(row => {
    const ref = getField(row, 'Referred By', 'referred by');
    const realtorKey = ref ? norm(String(ref)) : null;
    const realtorName = ref ? String(ref).trim() : '—';
    const cached = realtorKey ? (cache.get(realtorKey) || { status: 'unknown', daysSince: null }) : { status: 'unknown', daysSince: null };
    const oppName = String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim();
    const lnNum = String(getField(row, 'Loan #', 'loan #') || '—').trim();
    const branch = String(getField(row, 'Branch', 'branch') || '').trim() || '—';
    const currentMilestone = String(getField(row, 'Current Milestone', 'current milestone') || '').trim() || '—';
    const loanStatus = String(getField(row, 'Loan Status', 'loan status') || '').trim() || '—';
    const oppCd = parseDate(getField(row, 'Created Date', 'created date', 'create date'));
    const preApprovalDate = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date'));
    const ratifiedDate = parseDate(getField(row, 'Ratified Date', 'ratified date'));
    const estClosingDate = parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'Close Date', 'close date'));
    const amt = getField(row, 'Loan Amount', 'loan amount');
    const amtFmt = amt ? '$' + Number(amt).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
    const daysOpen = oppCd ? Math.floor((today - oppCd) / 86400000) : null;
    return { row, realtorKey, realtorName, status: cached.status, daysSince: cached.daysSince, lnNum, oppName, branch, currentMilestone, loanStatus, oppCd, daysOpen, preApprovalDate, ratifiedDate, estClosingDate, amt, amtFmt };
  });
  enriched.sort((a, b) => ({ inactive: 0, active: 1, unknown: 2 }[a.status] ?? 2) - ({ inactive: 0, active: 1, unknown: 2 }[b.status] ?? 2));

  // Drill-down: Realtor Name → todas sus opps con este LO (Loan Officers = este LO)
  const loScopeMatch = row => isAll ? allowedLOsForAll.some(l => matchLo(row, l)) : matchLo(row, lo);
  const _dg = (row, ...a) => String(getField(row, ...a) || '—').trim();
  const drillLoRealtorTable = drows => {
    const cols = ['Loan #', 'Stage', 'Health Status', 'Branch', 'BD Owner', 'Created Date', 'Pre-Approval Date', 'Ratified Date', 'Est. Closing Date', 'Loan Amount'];
    const head = '<tr>' + cols.map(c => '<th' + (c === 'Loan Amount' ? ' style="text-align:right"' : '') + '>' + c + '</th>').join('') + '</tr>';
    const body = drows.map(row => {
      const amt = getField(row, 'Loan Amount', 'loan amount');
      return '<tr>' +
        '<td style="font-family:monospace;font-size:10px;color:#556080">' + _dg(row, 'Loan #', 'loan #') + '</td>' +
        '<td style="font-size:11px">' + _dg(row, 'Stage', 'stage') + '</td>' +
        '<td>' + healthChipHtml(getField(row, 'Healthiness', 'healthiness')) + '</td>' +
        '<td style="font-size:11px">' + _dg(row, 'Branch', 'branch') + '</td>' +
        '<td style="font-size:11px">' + _dg(row, 'Opportunity Owner', 'opportunity owner') + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Created Date', 'created date', 'create date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Ratified Date', 'ratified date'))) + '</td>' +
        '<td class="dt">' + fmtDate(parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'Close Date', 'close date'))) + '</td>' +
        '<td class="modal-amount" style="text-align:right">' + (amt ? '$' + Number(amt).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</td>' +
      '</tr>';
    }).join('');
    return '<table class="modal-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  };
  const _loPipeSeen = new Set();
  for (const e of enriched) {
    if (!e.realtorKey || _loPipeSeen.has(e.realtorKey)) continue;
    _loPipeSeen.add(e.realtorKey);
    const rrows = (state.oppData || []).filter(row => {
      if (String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase().includes('city lending inc')) return false;
      const ref = getField(row, 'Referred By', 'referred by');
      if (!ref || norm(String(ref)) !== e.realtorKey) return false;
      return loScopeMatch(row);
    });
    _loPipeDrill.set('loPlReal:' + e.realtorKey, {
      title: e.realtorName + ' — All Opportunities (LO)',
      subtitle: rrows.length + ' opportunit' + (rrows.length !== 1 ? 'ies' : 'y'),
      build: () => drillLoRealtorTable(rrows)
    });
  }
  const totalAmt = enriched.reduce((s, e) => { const a = parseFloat(getField(e.row, 'Loan Amount', 'loan amount') || 0); return s + (isNaN(a) ? 0 : a); }, 0);
  const head = '<tr>' +
      '<th colspan="3" style="background:#1D6FA4;color:white;text-align:center">Realtor</th>' +
      '<th colspan="12" style="background:#0D4B7A;color:white;text-align:center">Loan</th>' +
    '</tr>' +
    '<tr><th>Realtor</th><th>Status</th><th>Days Since Last Lead</th><th>Loan #</th><th>Opportunity Name</th><th>Branch</th><th>Current Milestone</th><th>Health Status</th><th>Loan Status</th><th>Created Date</th><th>Days Open</th><th>Pre-Approval Date</th><th>Ratified Date</th><th>Est. Closing Date</th><th>Loan Amount</th></tr>';
  const renderRow = e => {
    const daysColor = e.daysSince == null ? '#8899BB' : e.daysSince > 90 ? '#A32D2D' : e.daysSince > 45 ? '#856400' : '#085041';
    return '<tr>' +
      '<td' + (e.realtorKey ? ' style="cursor:pointer;text-decoration:underline;color:#1D4ED8" data-lo-drill-pipe="loPlReal:' + e.realtorKey + '"' : '') + '>' + e.realtorName + '</td>' +
      '<td>' + statusChipHtml(e.status) + '</td>' +
      '<td style="text-align:center;font-weight:700;color:' + daysColor + '">' + (e.daysSince != null ? e.daysSince + 'd' : '—') + '</td>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
      '<td style="font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis" title="' + e.oppName + '">' + e.oppName + '</td>' +
      '<td style="font-size:11px">' + e.branch + '</td>' +
      '<td style="font-size:11px">' + e.currentMilestone + '</td>' +
      '<td>' + healthChipHtml(getField(e.row, 'Healthiness', 'healthiness')) + '</td>' +
      '<td style="font-size:11px">' + e.loanStatus + '</td>' +
      '<td class="dt">' + fmtDate(e.oppCd) + '</td>' +
      '<td style="text-align:center;font-weight:700;color:' + (e.daysOpen == null ? '#8899BB' : e.daysOpen > 180 ? '#A32D2D' : e.daysOpen > 90 ? '#856400' : '#085041') + '">' + (e.daysOpen != null ? e.daysOpen + 'd' : '—') + '</td>' +
      '<td class="dt">' + (e.preApprovalDate ? fmtDate(e.preApprovalDate) : '—') + '</td>' +
      '<td class="dt">' + (e.ratifiedDate ? fmtDate(e.ratifiedDate) : '—') + '</td>' +
      '<td class="dt">' + (e.estClosingDate ? fmtDate(e.estClosingDate) : '—') + '</td>' +
      '<td class="modal-amount">' + e.amtFmt + '</td>' +
    '</tr>';
  };
  const body = enriched.map(renderRow).join('');
  openModal((isAll ? 'ALL LOs' : lo) + ' — ' + stage,
    enriched.length + ' opportunit' + (enriched.length !== 1 ? 'ies' : 'y') + ' · Total: ' + (totalAmt ? '$' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'),
    head, body, null);
  renderModalFilters({
    containerId: 'lop-detail-filters',
    subtitleId: 'modal-sub',
    tableBodyId: 'modal-tbody',
    rows: enriched,
    filters: [
      { id: 'f-lop-branch', label: 'Branch', field: e => e.branch, allLabel: 'All Branches' },
      { id: 'f-lop-bd', label: 'BD Owner', field: e => String(getField(e.row, 'Opportunity Owner', 'opportunity owner') || '').trim(), allLabel: 'All BDs' },
      { id: 'f-lop-health', label: 'Health', field: e => String(getField(e.row, 'Healthiness', 'healthiness') || '').trim(), allLabel: 'All Health' }
    ],
    renderRow,
    countLabel: n => n + ' opportunities'
  });
}

export function renderLoCwSection() {
  const allowedLOs = getAllowedLOs();
  const inactiveCutoff = getLoInactiveCutoff();
  const allCW = (state.oppData || []).filter(row => {
    if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed won') return false;
    const currStatus = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (currStatus.includes('archive loan')) return false;
    return allowedLOs.some(lo => matchLo(row, lo));
  });

  const dates = allCW.map(r => parseDate(getField(r, 'Disbursement Date', 'disbursement date'))).filter(Boolean);
  const years = [...new Set(dates.map(d => d.getUTCFullYear()))].sort((a, b) => b - a);
  const months = [...new Set(dates.map(d => d.getUTCMonth() + 1))].sort((a, b) => a - b);

  const yearEl = document.getElementById('lo-pl-cw-year');
  const monthEl = document.getElementById('lo-pl-cw-month');
  const currentYear = String(new Date().getFullYear());
  const currentMonth = new Date().getMonth() + 1;
  const prevYears = Array.from(yearEl.selectedOptions).map(o => o.value);
  const prevMonths = Array.from(monthEl.selectedOptions).map(o => o.value);
  const effectiveYears = prevYears.length ? prevYears : (years.includes(parseInt(currentYear)) ? [currentYear] : []);
  const effectiveMonths = prevMonths.length ? prevMonths : (months.includes(currentMonth) ? [String(currentMonth)] : []);
  yearEl.innerHTML = years.map(y => '<option value="' + y + '"' + (effectiveYears.includes(String(y)) ? ' selected' : '') + '>' + y + '</option>').join('');
  monthEl.innerHTML = months.map(m => '<option value="' + m + '"' + (effectiveMonths.includes(String(m)) ? ' selected' : '') + '>' + MONTHS[m - 1] + '</option>').join('');

  const selYears = Array.from(yearEl.selectedOptions).map(o => parseInt(o.value));
  const selMonths = Array.from(monthEl.selectedOptions).map(o => parseInt(o.value));
  const selBranches = Array.from(document.getElementById('lo-pl-filter-cw-branch').selectedOptions).map(o => o.value);

  const filtered = allCW.filter(row => {
    const d = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    if (!d) return false;
    if (selYears.length && !selYears.includes(d.getUTCFullYear())) return false;
    if (selMonths.length && !selMonths.includes(d.getUTCMonth() + 1)) return false;
    if (selBranches.length && !selBranches.includes(String(getField(row, 'Branch', 'branch') || '').trim())) return false;
    return true;
  });

  if (!filtered.length) {
    document.getElementById('lo-pl-cw-content').innerHTML = '<div class="empty-state">No Closed Won records match the selected filters</div>';
    return;
  }

  const allRealtorKeysCW = [...new Set(filtered.map(r => { const ref = getField(r, 'Referred By', 'referred by'); return ref ? norm(String(ref)) : null; }).filter(Boolean))];
  const realtorCacheCW = buildRealtorCacheLo(allRealtorKeysCW, inactiveCutoff);
  const totalCount = filtered.length;
  const totalAmt = filtered.reduce((s, r) => { const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0); return s + (isNaN(a) ? 0 : a); }, 0);

  const byLo = new Map();
  for (const row of filtered) {
    const loRaw = String(getField(row, 'Loan Officers', 'loan officers', 'Loan Officer', 'loan officer') || '').trim();
    const lo = normalizeLO(loRaw) || loRaw;
    if (!lo) continue;
    if (!byLo.has(lo)) byLo.set(lo, []);
    byLo.get(lo).push(row);
  }

  _loCwDetailCache.clear();
  let grandTotal = 0, grandCount = 0;
  const cardsHtml = '<div class="pipeline-owners-grid">' + [...byLo.keys()].sort().map(lo => {
    const opps = byLo.get(lo);
    _loCwDetailCache.set(lo, opps);
    const ownerTotal = opps.reduce((s, r) => { const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0); return s + (isNaN(a) ? 0 : a); }, 0);
    grandTotal += ownerTotal; grandCount += opps.length;
    const ownerRealtorKeys = [...new Set(opps.map(r => { const ref = getField(r, 'Referred By', 'referred by'); return ref ? norm(String(ref)) : null; }).filter(Boolean))];
    let activeC = 0, inactiveC = 0, unknownC = 0;
    for (const key of ownerRealtorKeys) {
      const st = (realtorCacheCW.get(key) || {}).status || 'unknown';
      if (st === 'active') activeC++;
      else if (st === 'inactive') inactiveC++;
      else unknownC++;
    }
    return '<div class="pl-owner-card pl-cw-card" style="cursor:pointer" data-lo-cw-lo="' + lo.replace(/"/g, '&quot;') + '">' +
      '<div class="pl-owner-header">' +
        '<div class="pl-owner-avatar">' + initials(lo) + '</div>' +
        '<div class="pl-owner-info">' +
          '<div class="pl-owner-name">' + lo + '</div>' +
          '<div class="pl-owner-meta">' + opps.length + ' closing' + (opps.length !== 1 ? 's' : '') + ' · ' + ownerRealtorKeys.length + ' realtor' + (ownerRealtorKeys.length !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="pl-owner-total">' + (ownerTotal ? '$' + ownerTotal.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</div>' +
      '</div>' +
      '<div class="pl-realtor-summary">' +
        '<span class="pl-rs-item pl-chip-active"><i class="ti ti-check"></i> ' + activeC + ' active</span>' +
        '<span class="pl-rs-item pl-chip-inactive"><i class="ti ti-clock"></i> ' + inactiveC + ' inactive</span>' +
        (unknownC ? '<span class="pl-rs-item pl-chip-unknown"><i class="ti ti-help"></i> ' + unknownC + ' no data</span>' : '') +
      '</div>' +
    '</div>';
  }).join('') + '</div>';

  document.getElementById('lo-pl-cw-content').innerHTML =
    '<div class="pl-cw-summary"><div class="pl-cw-summary-stats">' +
    '<span class="pl-cw-summary-total">Total Closed Won: <strong>' + totalCount + ' closing' + (totalCount !== 1 ? 's' : '') + ' · $' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '</strong></span>' +
    '</div></div>' + cardsHtml +
    '<div class="pl-grand-total"><span>' + grandCount + ' total deal' + (grandCount !== 1 ? 's' : '') + '</span>' +
    '<span class="pl-grand-amt">' + (grandTotal ? '$' + grandTotal.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</span></div>';
}

export function clearLoPipelineFilters() {
  Array.from(document.getElementById('lo-pl-filter-lo').options).forEach(o => o.selected = false);
  Array.from(document.getElementById('lo-pl-cw-month').options).forEach(o => o.selected = false);
  Array.from(document.getElementById('lo-pl-cw-year').options).forEach(o => o.selected = false);
  Array.from(document.getElementById('lo-pl-filter-cw-branch').options).forEach(o => o.selected = false);
  renderLoPipeline();
  renderLoCwSection();
}

export function clearLoCwFilters() {
  const now = new Date();
  const curYear = String(now.getFullYear());
  const curMonth = String(now.getMonth() + 1);
  Array.from(document.getElementById('lo-pl-cw-month').options).forEach(o => { o.selected = o.value === curMonth; });
  Array.from(document.getElementById('lo-pl-cw-year').options).forEach(o => { o.selected = o.value === curYear; });
  Array.from(document.getElementById('lo-pl-filter-cw-branch').options).forEach(o => o.selected = false);
  renderLoCwSection();
}

// Event delegation for LO pipeline stage clicks
document.addEventListener('click', e => {
  const el = e.target.closest('[data-lo-pl-lo][data-lo-pl-stage]');
  if (!el) return;
  showLoPipelineStageDetail(el.getAttribute('data-lo-pl-lo'), el.getAttribute('data-lo-pl-stage'));
});

// Drill-down: Realtor Name en LO Pipeline stage detail → sus opps con este LO (← Back)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-lo-drill-pipe]');
  if (!el || !el.closest('#detail-modal')) return;
  const d = _loPipeDrill.get(el.getAttribute('data-lo-drill-pipe'));
  if (d) pushModalView({ title: d.title, subtitle: d.subtitle, content: d.build() });
});

// Healthiness chips → modal de detalle (LO Pipeline)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-pipeline-health]');
  if (!el || !el.closest('#lo-pl-pipeline-content')) return;
  const lo = el.getAttribute('data-owner');
  const opps = _healthCacheLoP.get(lo);
  if (!opps) return;
  openHealthModal(opps, lo === 'ALL' ? 'ALL LOs' : lo, el.getAttribute('data-health'));
});

// Event delegation for LO CW card clicks
document.addEventListener('click', e => {
  const el = e.target.closest('[data-lo-cw-lo]');
  if (!el) return;
  const lo = el.getAttribute('data-lo-cw-lo');
  const opps = _loCwDetailCache.get(lo);
  if (!opps || !opps.length) return;
  const inactiveCutoff = getLoInactiveCutoff();
  const realtorKeys = [...new Set(opps.map(r => { const ref = getField(r, 'Referred By', 'referred by'); return ref ? norm(String(ref)) : null; }).filter(Boolean))];
  const cache = buildRealtorCacheLo(realtorKeys, inactiveCutoff);
  const enriched = opps.map(row => {
    const ref = getField(row, 'Referred By', 'referred by');
    const realtorKey = ref ? norm(String(ref)) : null;
    const cached = realtorKey ? (cache.get(realtorKey) || { status: 'unknown' }) : { status: 'unknown' };
    const lnNum = String(getField(row, 'Loan #', 'loan #') || '—').trim();
    const oppName = String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim();
    const branch = String(getField(row, 'Branch', 'branch') || '').trim() || '—';
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    const amt = getField(row, 'Loan Amount', 'loan amount');
    return { row, realtorName: ref ? String(ref).trim() : '—', status: cached.status, lnNum, oppName, branch, disbDate, amt, amtFmt: amt ? '$' + Number(amt).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—' };
  });
  const totalAmt = enriched.reduce((s, e) => { const a = parseFloat(getField(e.row, 'Loan Amount', 'loan amount') || 0); return s + (isNaN(a) ? 0 : a); }, 0);
  const head = '<tr><th>Loan #</th><th>Opportunity Name</th><th>Realtor</th><th>Realtor Status</th><th>Branch</th><th>Disbursement Date</th><th>Loan Amount</th></tr>';
  const body = enriched.map(e => '<tr>' +
    '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
    '<td style="font-weight:600">' + e.oppName + '</td>' +
    '<td>' + e.realtorName + '</td>' +
    '<td>' + statusChipHtml(e.status) + '</td>' +
    '<td style="font-size:11px">' + e.branch + '</td>' +
    '<td class="dt">' + fmtDate(e.disbDate) + '</td>' +
    '<td class="modal-amount">' + e.amtFmt + '</td>' +
    '</tr>').join('');
  openModal(lo + ' — Closed Won',
    enriched.length + ' closing' + (enriched.length !== 1 ? 's' : '') + ' · $' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }),
    head, body, null);
});
