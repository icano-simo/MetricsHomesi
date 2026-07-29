import { state } from './state.js';
import { norm, parseDate, fmtDate, getField, initials } from './utils.js';
import { openModal, pushModalView } from './modal.js';
import { renderModalFilters } from './modal-filters.js';
import { dl } from './export.js';

// ── Healthiness breakdown (compartido: pipeline, lo-pipeline, performance, lo-performance) ──
export function buildHealthBreakdown(opps, ownerAttr) {
  const counts = { 'On Track': 0, Delayed: 0, 'Out of Scope': 0 };
  let hasAny = false;
  for (const row of opps) {
    const h = String(getField(row, 'Healthiness', 'healthiness') || '').trim();
    if (!h) continue;
    hasAny = true;
    if (counts[h] !== undefined) counts[h]++;
  }
  if (!hasAny) return '';
  const chips = [
    { key: 'On Track', bg: '#ECFDF5', color: '#065F46' },
    { key: 'Delayed', bg: '#FFFBEB', color: '#B45309' },
    { key: 'Out of Scope', bg: '#EFF6FF', color: '#1D4ED8' }
  ];
  const ownerEsc = String(ownerAttr).replace(/"/g, '&quot;');
  const rows = chips.filter(c => counts[c.key] > 0).map(c =>
    '<div class="health-row" style="display:flex;justify-content:space-between;align-items:center;padding:3px 8px;border-radius:6px;background:' + c.bg + ';margin-bottom:2px;cursor:pointer" data-health="' + c.key + '" data-owner="' + ownerEsc + '" data-pipeline-health="1">' +
      '<span style="font-size:10px;font-weight:600;color:' + c.color + '">' + c.key + '</span>' +
      '<span style="font-size:12px;font-weight:700;color:' + c.color + '">' + counts[c.key] + '</span>' +
    '</div>'
  ).join('');
  return '<div class="health-section"><div class="health-label">LOAN HEALTH STATUS</div>' + rows + '</div>';
}

// Modal de detalle de Healthiness (11 columnas) — recibe opps ya del owner/LO y el valor de health
export function openHealthModal(opps, ownerLabel, health) {
  const nH = norm(health);
  const rows = (opps || []).filter(row => norm(String(getField(row, 'Healthiness', 'healthiness') || '')) === nH);
  const negFirst = s => /negotiation/i.test(String(s || '')) ? 0 : 1;
  const amtOf = row => parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0;
  rows.sort((a, b) => {
    const sa = negFirst(getField(a, 'Stage', 'stage')), sb = negFirst(getField(b, 'Stage', 'stage'));
    if (sa !== sb) return sa - sb;
    return amtOf(b) - amtOf(a);
  });
  const cols = ['Loan #', 'Opportunity Name', 'Realtor', 'Stage', 'Branch', 'Loan Officer', 'Created Date', 'Pre-Approval Date', 'Ratified Date', 'Est. Closing Date', 'Loan Amount'];
  const head = '<tr>' + cols.map(c => '<th' + (c === 'Loan Amount' ? ' style="text-align:right"' : '') + '>' + c + '</th>').join('') + '</tr>';
  const body = rows.map(row => {
    const amt = amtOf(row);
    return '<tr>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + (String(getField(row, 'Loan #', 'loan #') || '—').trim()) + '</td>' +
      '<td style="font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis" title="' + (String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim()) + '">' + (String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim()) + '</td>' +
      '<td>' + (String(getField(row, 'Referred By', 'referred by') || '—').trim()) + '</td>' +
      '<td style="font-size:11px">' + (String(getField(row, 'Stage', 'stage') || '—').trim()) + '</td>' +
      '<td style="font-size:11px">' + (String(getField(row, 'Branch', 'branch') || '—').trim()) + '</td>' +
      '<td style="font-size:11px">' + (String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '—').trim()) + '</td>' +
      '<td class="dt">' + fmtDate(parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'))) + '</td>' +
      '<td class="dt">' + fmtDate(parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date'))) + '</td>' +
      '<td class="dt">' + fmtDate(parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'))) + '</td>' +
      '<td class="dt">' + fmtDate(parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'Close Date', 'close date'))) + '</td>' +
      '<td class="modal-amount" style="text-align:right">' + (amt ? '$' + amt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</td>' +
    '</tr>';
  }).join('');
  const csvData = [cols, ...rows.map(row => [
    String(getField(row, 'Loan #', 'loan #') || '').trim(), String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim(),
    String(getField(row, 'Referred By', 'referred by') || '').trim(), String(getField(row, 'Stage', 'stage') || '').trim(),
    String(getField(row, 'Branch', 'branch') || '').trim(), String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer') || '').trim(),
    fmtDate(parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'))),
    fmtDate(parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date'))),
    fmtDate(parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'))),
    fmtDate(parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'Close Date', 'close date'))),
    amtOf(row) || 0
  ])];
  openModal(ownerLabel + ' — ' + health, rows.length + ' opportunit' + (rows.length !== 1 ? 'ies' : 'y'), head, body, csvData);
}

// Chip de color para la columna "Health Status" en los modales de detalle por stage
export function healthChipHtml(val) {
  const h = String(val || '').trim();
  if (!h) return '<span style="color:#94A3B8">—</span>';
  const styles = { 'On Track': 'background:#ECFDF5;color:#065F46', 'Delayed': 'background:#FFFBEB;color:#B45309', 'Out of Scope': 'background:#EFF6FF;color:#1D4ED8' };
  const s = styles[h] || 'background:#F1F5F9;color:#64748B';
  return '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;' + s + '">' + h + '</span>';
}

const _healthCacheP = new Map();
// Drill-down de Pipeline BD: Realtor clickeable → todas sus opps abiertas en pipeline (← Back)
const _pipeDrill = new Map();
function _pipelineOpenRowsForRealtor(realtorKey) {
  const allowedNorm = new Set(getAllowedOwners().map(o => norm(o)));
  return (state.oppData || []).filter(row => {
    const stageLc = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    if (!stageLc || stageLc === 'closed won' || stageLc === 'closed lost') return false;
    const currStatus = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (currStatus.includes('archive loan')) return false;
    const rowLender = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
    if (rowLender.includes('city lending inc')) return false;
    const rowOwner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    if (!allowedNorm.has(norm(rowOwner))) return false;
    const ref = getField(row, 'Referred By', 'referred by');
    return ref && norm(String(ref)) === realtorKey;
  });
}
function _drillPipeRealtorTable(rows) {
  const cols = ['Loan #', 'Stage', 'Health Status', 'Branch', 'Loan Officer', 'Created Date', 'Pre-Approval Date', 'Ratified Date', 'Est. Closing Date', 'Loan Amount'];
  const head = '<tr>' + cols.map(c => '<th' + (c === 'Loan Amount' ? ' style="text-align:right"' : '') + '>' + c + '</th>').join('') + '</tr>';
  const g = (row, ...a) => String(getField(row, ...a) || '—').trim();
  const body = rows.map(row => {
    const amt = getField(row, 'Loan Amount', 'loan amount');
    const amtFmt = amt ? '$' + Number(amt).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
    return '<tr>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + g(row, 'Loan #', 'loan #') + '</td>' +
      '<td style="font-size:11px">' + g(row, 'Stage', 'stage') + '</td>' +
      '<td>' + healthChipHtml(getField(row, 'Healthiness', 'healthiness')) + '</td>' +
      '<td style="font-size:11px">' + g(row, 'Branch', 'branch') + '</td>' +
      '<td style="font-size:11px">' + g(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer', 'loan officer') + '</td>' +
      '<td class="dt">' + fmtDate(parseDate(getField(row, 'Created Date', 'created date', 'create date'))) + '</td>' +
      '<td class="dt">' + fmtDate(parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date', 'Pre-Approval Date', 'pre-approval date'))) + '</td>' +
      '<td class="dt">' + fmtDate(parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'))) + '</td>' +
      '<td class="dt">' + fmtDate(parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'estimated closing date', 'Estimated Closing Date', 'Close Date', 'close date'))) + '</td>' +
      '<td class="modal-amount" style="text-align:right">' + amtFmt + '</td>' +
    '</tr>';
  }).join('');
  return '<table class="modal-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _cwCsvCache = new Map();
const _cwDetailCache = new Map();

// ── Drill-down por realtor en Closed Won (historial completo de closings) ──
const _cwDrill = new Map(); // realtorKey -> realtorName
function _cwHistoryForRealtor(realtorKey) {
  return (state.oppData || []).filter(row => {
    if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed won') return false;
    if (!parseDate(getField(row, 'Disbursement Date', 'disbursement date'))) return false;
    const cs = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (cs.includes('archive loan')) return false;
    if (String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase().includes('city lending inc')) return false;
    const ref = getField(row, 'Referred By', 'referred by');
    return ref && norm(String(ref)) === realtorKey;
  }).sort((a, b) => {
    const da = parseDate(getField(a, 'Disbursement Date', 'disbursement date')) || 0;
    const db = parseDate(getField(b, 'Disbursement Date', 'disbursement date')) || 0;
    return db - da;
  });
}
const _cwHistoryCols = ['#', 'Opportunity Name', 'BD Owner', 'Loan Officer', 'Branch', 'Disbursement Date', 'Loan Amount'];
const _cwAmt = row => parseFloat(String(getField(row, 'Loan Amount', 'loan amount') || '').replace(/[$,]/g, '')) || 0;
function _cwHistoryTable(rows, realtorKey) {
  const g = (r, ...a) => String(getField(r, ...a) || '—').trim();
  const head = '<tr>' + _cwHistoryCols.map(c => '<th' + (c === 'Loan Amount' ? ' style="text-align:right"' : '') + '>' + c + '</th>').join('') + '</tr>';
  let totalAmt = 0;
  const body = rows.map((row, i) => {
    const amt = _cwAmt(row); totalAmt += amt;
    return '<tr>' +
      '<td style="color:#8899BB;font-size:10px">' + (i + 1) + '</td>' +
      '<td style="font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis" title="' + g(row, 'Opportunity Name', 'opportunity name') + '">' + g(row, 'Opportunity Name', 'opportunity name') + '</td>' +
      '<td style="font-size:11px">' + g(row, 'Opportunity Owner', 'opportunity owner') + '</td>' +
      '<td style="font-size:11px">' + g(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer', 'loan officer') + '</td>' +
      '<td style="font-size:11px">' + g(row, 'Branch', 'branch') + '</td>' +
      '<td class="dt">' + fmtDate(parseDate(getField(row, 'Disbursement Date', 'disbursement date'))) + '</td>' +
      '<td class="modal-amount" style="text-align:right">' + (amt ? '$' + amt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</td>' +
    '</tr>';
  }).join('');
  const totalsRow = '<tr style="background:#001A40;font-family:\'Barlow\',sans-serif;font-weight:700">' +
    '<td style="color:white">TOTAL</td><td style="color:white">—</td><td style="color:white">—</td><td style="color:white">—</td><td style="color:white">—</td>' +
    '<td style="color:white">' + rows.length + ' closing' + (rows.length !== 1 ? 's' : '') + '</td>' +
    '<td style="color:white;text-align:right">' + (totalAmt ? '$' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + '</td>' +
  '</tr>';
  return '<div style="margin-bottom:8px"><button data-cw-csv="' + realtorKey + '" style="display:inline-flex;align-items:center;gap:6px;background:#F1F5F9;border:1px solid #E2E8F0;border-radius:8px;padding:5px 12px;font-size:11px;font-weight:600;color:#475569;cursor:pointer"><i class="ti ti-download"></i> Download CSV</button></div>' +
    '<table class="modal-table"><thead>' + head + '</thead><tbody>' + body + totalsRow + '</tbody></table>';
}
function _cwHistoryCsv(rows) {
  const g = (r, ...a) => String(getField(r, ...a) || '').trim();
  let totalAmt = 0;
  const dataRows = rows.map((row, i) => {
    const amt = _cwAmt(row); totalAmt += amt;
    return [i + 1, g(row, 'Opportunity Name', 'opportunity name'), g(row, 'Opportunity Owner', 'opportunity owner'), g(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer', 'loan officer'), g(row, 'Branch', 'branch'), fmtDate(parseDate(getField(row, 'Disbursement Date', 'disbursement date'))), amt || ''];
  });
  return [_cwHistoryCols, ...dataRows, ['TOTAL', '', '', '', '', rows.length + ' closings', totalAmt || '']];
}

function getInactiveCutoff() {
  const val = document.getElementById('pl-inactive-cutoff').value;
  if (val) return new Date(val + 'T00:00:00Z');
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 60);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}


function getAllowedOwners() {
  return document.getElementById('owners-list').value
    .split(',')
    .map(s => s.trim().replace(/^["']+|["']+$/g, '').trim())
    .filter(s => s !== '');
}

function statusChipHtml(status) {
  if (status === 'active') return '<span class="pl-status-chip pl-chip-active">Active</span>';
  if (status === 'inactive') return '<span class="pl-status-chip pl-chip-inactive">Inactive</span>';
  return '<span class="pl-status-chip pl-chip-unknown">No Data</span>';
}

function buildRealtorCache(realtorKeys, inactiveCutoff) {
  const keySet = new Set(realtorKeys);
  const latestDates = new Map();
  for (const row of (state.leadsData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (!ref) continue;
    const key = norm(String(ref));
    if (!keySet.has(key)) continue;
    const cd = parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'));
    if (cd) {
      const cur = latestDates.get(key);
      if (!cur || cd > cur) latestDates.set(key, cd);
    }
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

const _unknownCache = new Map();

function unknownRealtorOpps(opps) {
  const rom = state.realtorOwnerMap || new Map();
  return opps.filter(o => {
    const ref = getField(o, 'Referred By', 'referred by');
    if (!ref || !String(ref).trim()) return true;
    return !rom.has(norm(String(ref)));
  });
}

function fmtCompactAmt(n) {
  if (!n || isNaN(n)) return '$0';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function unknownWarningHtml(cacheKey, opps, compact) {
  const unk = unknownRealtorOpps(opps);
  if (!unk.length) return '';
  _unknownCache.set(cacheKey, unk);
  const safe = cacheKey.replace(/"/g, '&quot;');
  if (compact) {
    return '<div class="pipeline-unknown-warning compact" data-unknown-key="' + safe + '">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ' + unk.length + ' opp' + (unk.length !== 1 ? 's' : '') + ' with unknown realtor · <span class="pl-review-link">Review →</span></div>';
  }
  return '<div class="pipeline-unknown-warning" data-unknown-key="' + safe + '">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ' + unk.length + ' opp' + (unk.length !== 1 ? 's' : '') + ' with unknown realtor — click to review</div>';
}

function showUnknownRealtorDetail(cacheKey) {
  const opps = _unknownCache.get(cacheKey);
  if (!opps || !opps.length) return;
  const head = '<tr><th>Loan #</th><th>Opportunity Name</th><th>Stage</th><th>Created Date</th><th>Loan Amount</th></tr>';
  const rowsOut = opps.map(row => {
    const lnNum = String(getField(row, 'Loan #', 'loan #') || '—').trim();
    const oppName = String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim();
    const stg = String(getField(row, 'Stage', 'stage') || '—').trim();
    const created = parseDate(getField(row, 'Created Date', 'created date', 'create date'));
    const amt = getField(row, 'Loan Amount', 'loan amount');
    const amtFmt = amt ? '$' + Number(amt).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
    return { lnNum, oppName, stg, created, amt, amtFmt };
  });
  const body = rowsOut.map(e =>
    '<tr>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
      '<td style="font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis" title="' + e.oppName + '">' + e.oppName + '</td>' +
      '<td style="font-size:11px">' + e.stg + '</td>' +
      '<td class="dt">' + fmtDate(e.created) + '</td>' +
      '<td class="modal-amount">' + e.amtFmt + '</td>' +
    '</tr>'
  ).join('');
  const csvData = [
    ['Loan #', 'Opportunity Name', 'Stage', 'Created Date', 'Loan Amount'],
    ...rowsOut.map(e => [e.lnNum, e.oppName, e.stg, fmtDate(e.created), e.amt || ''])
  ];
  openModal('Unknown Realtor — Review', opps.length + ' opp' + (opps.length !== 1 ? 's' : '') + ' with unmatched realtor', head, body, csvData);
}

export function initPipeline() {
  const defaultCutoff = new Date();
  defaultCutoff.setUTCDate(defaultCutoff.getUTCDate() - 60);
  const cutoffEl = document.getElementById('pl-inactive-cutoff');
  if (!cutoffEl.value) cutoffEl.value = defaultCutoff.toISOString().split('T')[0];

  const owners = getAllowedOwners();
  const allowedNorm = new Set(owners.map(o => norm(o)));

  const ownerEl = document.getElementById('pl-filter-owner');
  const prev = Array.from(ownerEl.selectedOptions).map(o => o.value);
  ownerEl.innerHTML = owners.map(o => '<option value="' + o + '"' + (prev.includes(o) ? ' selected' : '') + '>' + o + '</option>').join('');

  const cwOpps = (state.oppData || []).filter(row =>
    String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() === 'closed won' &&
    allowedNorm.has(norm(String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim()))
  );
  const branches = [...new Set(cwOpps.map(r => {
    const b = String(getField(r, 'Branch', 'branch') || '').trim();
    return b || null;
  }).filter(Boolean))].sort();
  const branchEl = document.getElementById('pl-filter-cw-branch');
  const prevBranches = Array.from(branchEl.selectedOptions).map(o => o.value);
  branchEl.innerHTML = branches.map(b => '<option value="' + b + '"' + (prevBranches.includes(b) ? ' selected' : '') + '>' + b + '</option>').join('');

  renderPipeline();
  renderClosedWon();
}

export function renderPipeline() {
  const inactiveCutoff = getInactiveCutoff();
  const filterOwners = Array.from(document.getElementById('pl-filter-owner').selectedOptions).map(o => o.value).filter(Boolean);
  const allowedNorm = new Set(getAllowedOwners().map(o => norm(o)));
  _healthCacheP.clear();

  const openOpps = (state.oppData || []).filter(row => {
    const stage = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    if (!stage) return false;
    if (stage === 'closed won' || stage === 'closed lost') return false;
    const currStatus = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (currStatus.includes('archive loan')) return false;
    const lender = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
    if (lender.includes('city lending inc')) return false;
    const owner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    return allowedNorm.has(norm(owner));
  });

  const byOwner = new Map();
  for (const row of openOpps) {
    const owner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    if (!owner) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(row);
  }

  const owners = (filterOwners.length
    ? [...byOwner.keys()].filter(o => filterOwners.includes(o))
    : [...byOwner.keys()]
  ).sort();

  if (!owners.length) {
    document.getElementById('pl-pipeline-content').innerHTML = '<div class="empty-state">No open opportunities found</div>';
    return;
  }

  const allRealtorKeys = [...new Set(openOpps.map(r => {
    const ref = getField(r, 'Referred By', 'referred by');
    return ref ? norm(String(ref)) : null;
  }).filter(Boolean))];
  const realtorCache = buildRealtorCache(allRealtorKeys, inactiveCutoff);

  const stageRank = { 'need analysis': 0, 'needs analysis': 0, 'qualification': 1, 'proposal': 2, 'negotiation': 3 };

  function buildCard(label, opps, ownerAttr, extraClass, isAll) {
    _healthCacheP.set(ownerAttr, opps);
    const stageMap = new Map();
    for (const row of opps) {
      const stage = String(getField(row, 'Stage', 'stage') || '—').trim();
      if (!stageMap.has(stage)) stageMap.set(stage, []);
      stageMap.get(stage).push(row);
    }

    const totalAmt = opps.reduce((s, r) => {
      const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0);
      return s + (isNaN(a) ? 0 : a);
    }, 0);

    const realtorKeys = [...new Set(opps.map(r => {
      const ref = getField(r, 'Referred By', 'referred by');
      return ref ? norm(String(ref)) : null;
    }).filter(Boolean))];

    let activeCount = 0, inactiveCount = 0, unknownCount = 0;
    for (const key of realtorKeys) {
      const st = (realtorCache.get(key) || {}).status || 'unknown';
      if (st === 'active') activeCount++;
      else if (st === 'inactive') inactiveCount++;
      else unknownCount++;
    }

    const stageRows = [...stageMap.entries()]
      .sort(([a], [b]) => {
        const nrm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
        const ai = stageRank[nrm(a)] ?? 999;
        const bi = stageRank[nrm(b)] ?? 999;
        return ai - bi;
      })
      .map(([stage, rows]) => {
        const stageAmt = rows.reduce((s, r) => {
          const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0);
          return s + (isNaN(a) ? 0 : a);
        }, 0);
        const fmtAmt = stageAmt ? '$' + stageAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
        return '<div class="pl-stage-item" data-pl-owner="' + ownerAttr.replace(/"/g, '&quot;') + '" data-pl-stage="' + stage.replace(/"/g, '&quot;') + '">' +
          '<div class="pl-stage-info">' +
            '<div class="pl-stage-title">' + stage + '</div>' +
            (fmtAmt ? '<div class="pl-stage-amt2">' + fmtAmt + '</div>' : '') +
          '</div>' +
          '<div class="pl-stage-num">' + rows.length + '</div>' +
        '</div>';
      }).join('');

    if (isAll) {
      return '<div class="pl-owner-card all-bds">' +
        '<div class="pl-allbds-header">' +
          '<div>' +
            '<div class="pl-allbds-title">ALL BDs</div>' +
            '<div class="pl-allbds-sub">' + owners.length + ' Business Developer' + (owners.length !== 1 ? 's' : '') + '</div>' +
          '</div>' +
          '<div class="pl-allbds-right">' +
            '<div class="pl-allbds-amt">' + fmtCompactAmt(totalAmt) + '</div>' +
            '<div class="pl-allbds-sub">' + opps.length + ' open opportunit' + (opps.length !== 1 ? 'ies' : 'y') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pl-allbds-stats">' +
          '<div class="pl-allbds-stat"><div class="pl-allbds-stat-num" style="color:#1D9E75">' + activeCount + '</div><div class="pl-allbds-stat-label">Active</div></div>' +
          '<div class="pl-allbds-stat"><div class="pl-allbds-stat-num" style="color:#E65100">' + inactiveCount + '</div><div class="pl-allbds-stat-label">Inactive</div></div>' +
          '<div class="pl-allbds-stat"><div class="pl-allbds-stat-num" style="color:#8899BB">' + unknownCount + '</div><div class="pl-allbds-stat-label">No data</div></div>' +
        '</div>' +
        unknownWarningHtml('pl:' + label, opps, true) +
        '<div class="pipeline-stages-list">' + stageRows + '</div>' +
        buildHealthBreakdown(opps, ownerAttr) +
      '</div>';
    }

    const fmtTotal = totalAmt ? '$' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
    const warning = unknownWarningHtml('pl:' + label, opps);

    return '<div class="pl-owner-card' + (extraClass ? ' ' + extraClass : '') + '">' +
      '<div class="pl-owner-header">' +
        '<div class="pl-owner-avatar">' + initials(label) + '</div>' +
        '<div class="pl-owner-info">' +
          '<div class="pl-owner-name">' + label + '</div>' +
          '<div class="pl-owner-meta">' + opps.length + ' open opp' + (opps.length !== 1 ? 's' : '') + ' · ' + realtorKeys.length + ' realtor' + (realtorKeys.length !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="pl-owner-total">' + fmtTotal + '</div>' +
      '</div>' +
      '<div class="pl-realtor-summary">' +
        '<span class="pl-rs-item pl-chip-active"><i class="ti ti-check"></i> ' + activeCount + ' active</span>' +
        '<span class="pl-rs-item pl-chip-inactive"><i class="ti ti-clock"></i> ' + inactiveCount + ' inactive</span>' +
        (unknownCount ? '<span class="pl-rs-item pl-chip-unknown"><i class="ti ti-help"></i> ' + unknownCount + ' no data</span>' : '') +
      '</div>' +
      warning +
      '<div class="pipeline-stages-list">' + stageRows + '</div>' +
      buildHealthBreakdown(opps, ownerAttr) +
    '</div>';
  }

  const allOpps = owners.flatMap(o => byOwner.get(o) || []);
  const allCard = buildCard('ALL BDs', allOpps, 'ALL', 'all-bds', true);
  const ownerCards = owners.map(o => buildCard(o, byOwner.get(o) || [], o, '', false)).join('');

  document.getElementById('pl-pipeline-content').innerHTML =
    '<div class="pipeline-owners-grid">' + allCard + ownerCards + '</div>';
}

export function showPipelineStageDetail(owner, stage) {
  const inactiveCutoff = getInactiveCutoff();
  const today = new Date();
  const isAll = owner === 'ALL';
  const allowedNorm = new Set(getAllowedOwners().map(o => norm(o)));

  const rows = (state.oppData || []).filter(row => {
    const stageLc = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    if (!stageLc) return false;
    if (stageLc === 'closed won' || stageLc === 'closed lost') return false;
    const currStatus = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (currStatus.includes('archive loan')) return false;
    const rowLender = String(getField(row, 'Lender', 'lender') || '').trim().toLowerCase();
    if (rowLender.includes('city lending inc')) return false;
    const rowOwner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    const rowStage = String(getField(row, 'Stage', 'stage') || '—').trim();
    if (rowStage !== stage) return false;
    if (isAll) { if (!allowedNorm.has(norm(rowOwner))) return false; }
    else if (rowOwner !== owner) return false;
    return true;
  });
  if (!rows.length) return;
  _pipeDrill.clear();

  const realtorKeys = [...new Set(rows.map(row => {
    const ref = getField(row, 'Referred By', 'referred by');
    return ref ? norm(String(ref)) : null;
  }).filter(Boolean))];
  const cache = buildRealtorCache(realtorKeys, inactiveCutoff);

  const enriched = rows.map(row => {
    const ref = getField(row, 'Referred By', 'referred by');
    const realtorKey = ref ? norm(String(ref)) : null;
    const realtorName = ref ? String(ref).trim() : '—';
    const cached = realtorKey ? (cache.get(realtorKey) || { status: 'unknown', daysSince: null }) : { status: 'unknown', daysSince: null };

    const oppName = String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim();
    const lnNum = String(getField(row, 'Loan #', 'loan #') || '—').trim();
    const branch = String(getField(row, 'Branch', 'branch') || '').trim() || '—';
    const loanOfficer = String(getField(row, 'Loan Officers', 'loan officers', 'loan_officer', 'Loan Officer', 'loan officer') || '').trim() || '—';
    const currentMilestone = String(getField(row, 'Current Milestone', 'current milestone', 'current_milestone') || '').trim() || '—';
    const oppCd = parseDate(getField(row, 'Created Date', 'created date', 'create date'));
    const preApprovalDate = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre_approved_date', 'Pre-Approval Date', 'pre-approval date'));
    const ratifiedDate = parseDate(getField(row, 'Ratified Date', 'ratified date', 'ratified_date'));
    const estClosingDate = parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'est_closing_date', 'estimated closing date', 'Estimated Closing Date', 'Close Date', 'close date'));
    const amt = getField(row, 'Loan Amount', 'loan amount');
    const amtFmt = amt ? '$' + Number(amt).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';

    const daysOpen = oppCd ? Math.floor((today - oppCd) / 86400000) : null;
    const healthiness = String(getField(row, 'Healthiness', 'healthiness') || '').trim();
    return { row, realtorKey, realtorName, status: cached.status, daysSince: cached.daysSince, lnNum, oppName, branch, loanOfficer, currentMilestone, healthiness, oppCd, daysOpen, preApprovalDate, ratifiedDate, estClosingDate, amt, amtFmt };
  });

  // Registrar drill por realtor (celda Realtor Name → todas sus opps abiertas en pipeline)
  const _drillSeen = new Set();
  for (const e of enriched) {
    if (!e.realtorKey || _drillSeen.has(e.realtorKey)) continue;
    _drillSeen.add(e.realtorKey);
    _pipeDrill.set('plReal:' + e.realtorKey, { realtorName: e.realtorName, realtorKey: e.realtorKey });
  }

  const order = { inactive: 0, active: 1, unknown: 2 };
  enriched.sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));

  const head =
    '<tr>' +
      '<th colspan="3" style="background:#1D6FA4;color:white;text-align:center">Realtor</th>' +
      '<th colspan="12" style="background:#0D4B7A;color:white;text-align:center">Loan</th>' +
    '</tr>' +
    '<tr>' +
      '<th>Realtor Name</th><th>Realtor Status</th><th>Days Since Last Lead</th>' +
      '<th>Loan #</th><th>Opportunity Name</th><th>Branch</th><th>Loan Officer</th>' +
      '<th>Current Milestone</th><th>Health Status</th><th>Opp. Created Date</th><th>Days Open as Opportunity</th>' +
      '<th>Pre-Approval Date</th><th>Ratified Date</th><th>Est. Closing Date</th><th>Loan Amount</th>' +
    '</tr>';

  const renderRow = e => {
    const daysTxt = e.daysSince != null ? e.daysSince + 'd' : '—';
    const daysColor = e.daysSince == null ? '#8899BB' : e.daysSince > 90 ? '#A32D2D' : e.daysSince > 45 ? '#856400' : '#085041';
    return '<tr>' +
      '<td' + (e.realtorKey ? ' style="cursor:pointer;text-decoration:underline;color:#1D4ED8" data-drill-pipe="plReal:' + e.realtorKey + '"' : '') + '>' + e.realtorName + '</td>' +
      '<td>' + statusChipHtml(e.status) + '</td>' +
      '<td style="text-align:center;font-weight:700;color:' + daysColor + '">' + daysTxt + '</td>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
      '<td style="font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis" title="' + e.oppName + '">' + e.oppName + '</td>' +
      '<td style="font-size:11px">' + e.branch + '</td>' +
      '<td style="font-size:11px">' + e.loanOfficer + '</td>' +
      '<td style="font-size:11px">' + e.currentMilestone + '</td>' +
      '<td>' + healthChipHtml(getField(e.row, 'Healthiness', 'healthiness')) + '</td>' +
      '<td class="dt">' + fmtDate(e.oppCd) + '</td>' +
      '<td style="text-align:center;font-weight:700;color:' + (e.daysOpen == null ? '#8899BB' : e.daysOpen > 180 ? '#A32D2D' : e.daysOpen > 90 ? '#856400' : '#085041') + '">' + (e.daysOpen != null ? e.daysOpen + 'd' : '—') + '</td>' +
      '<td class="dt">' + (e.preApprovalDate ? fmtDate(e.preApprovalDate) : '—') + '</td>' +
      '<td class="dt">' + (e.ratifiedDate ? fmtDate(e.ratifiedDate) : '—') + '</td>' +
      '<td class="dt">' + (e.estClosingDate ? fmtDate(e.estClosingDate) : '—') + '</td>' +
      '<td class="modal-amount">' + e.amtFmt + '</td>' +
    '</tr>';
  };
  const body = enriched.map(renderRow).join('');

  const totalAmt = enriched.reduce((s, e) => {
    const a = parseFloat(getField(e.row, 'Loan Amount', 'loan amount') || 0);
    return s + (isNaN(a) ? 0 : a);
  }, 0);
  const totalFmt = totalAmt ? '$' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';

  const csvData = [
    ['Realtor Name', 'Realtor Status', 'Days Since Last Lead', 'Loan #', 'Opportunity Name', 'Branch', 'Loan Officer', 'Current Milestone', 'Health Status', 'Opp. Created Date', 'Days Open as Opportunity', 'Pre-Approval Date', 'Ratified Date', 'Est. Closing Date', 'Loan Amount'],
    ...enriched.map(e => [
      e.realtorName, e.status, e.daysSince ?? '', e.lnNum, e.oppName,
      e.branch === '—' ? '' : e.branch, e.loanOfficer === '—' ? '' : e.loanOfficer,
      e.currentMilestone === '—' ? '' : e.currentMilestone,
      String(getField(e.row, 'Healthiness', 'healthiness') || '').trim(),
      fmtDate(e.oppCd),
      e.daysOpen ?? '',
      e.preApprovalDate ? fmtDate(e.preApprovalDate) : '',
      e.ratifiedDate ? fmtDate(e.ratifiedDate) : '',
      e.estClosingDate ? fmtDate(e.estClosingDate) : '',
      e.amt || ''
    ])
  ];

  openModal(
    (isAll ? 'ALL BDs' : owner) + ' — ' + stage,
    enriched.length + ' opportunit' + (enriched.length !== 1 ? 'ies' : 'y') + ' · Total: ' + totalFmt,
    head, body, csvData
  );
  renderModalFilters({
    containerId: 'ps-detail-filters',
    subtitleId: 'modal-sub',
    tableBodyId: 'modal-tbody',
    rows: enriched,
    filters: [
      { id: 'f-ps-branch', label: 'Branch', field: 'branch', allLabel: 'All Branches' },
      { id: 'f-ps-lo', label: 'Loan Officer', field: 'loanOfficer', allLabel: 'All LOs' },
      { id: 'f-ps-health', label: 'Health', field: 'healthiness', allLabel: 'All Health' }
    ],
    renderRow,
    countLabel: n => n + ' opportunities'
  });
}

export function renderClosedWon() {
  const allowedNorm = new Set(getAllowedOwners().map(o => norm(o)));
  const inactiveCutoff = getInactiveCutoff();

  const allCW = (state.oppData || []).filter(row => {
    if (String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase() !== 'closed won') return false;
    const currStatus = String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim().toLowerCase();
    if (currStatus.includes('archive loan')) return false;
    const owner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    return allowedNorm.has(norm(owner));
  });

  const dates = allCW.map(r => parseDate(getField(r, 'Disbursement Date', 'disbursement date'))).filter(Boolean);
  const years = [...new Set(dates.map(d => d.getUTCFullYear()))].sort((a, b) => b - a);
  const months = [...new Set(dates.map(d => d.getUTCMonth() + 1))].sort((a, b) => a - b);

  const yearEl = document.getElementById('pl-cw-year');
  const monthEl = document.getElementById('pl-cw-month');
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
  const selBranches = Array.from(document.getElementById('pl-filter-cw-branch').selectedOptions).map(o => o.value);

  const filtered = allCW.filter(row => {
    const d = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    if (!d) return false;
    if (selYears.length && !selYears.includes(d.getUTCFullYear())) return false;
    if (selMonths.length && !selMonths.includes(d.getUTCMonth() + 1)) return false;
    if (selBranches.length) {
      const b = String(getField(row, 'Branch', 'branch') || '').trim();
      if (!selBranches.includes(b)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    document.getElementById('pl-cw-content').innerHTML = '<div class="empty-state">No Closed Won records match the selected filters</div>';
    return;
  }

  const allRealtorKeysCW = [...new Set(filtered.map(r => {
    const ref = getField(r, 'Referred By', 'referred by');
    return ref ? norm(String(ref)) : null;
  }).filter(Boolean))];
  const realtorCacheCW = buildRealtorCache(allRealtorKeysCW, inactiveCutoff);

  const byOwner = new Map();
  for (const row of filtered) {
    const owner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    if (!owner) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(row);
  }

  // CAMBIO 1 — global summary
  const totalCount = filtered.length;
  const totalAmt = filtered.reduce((s, r) => {
    const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0);
    return s + (isNaN(a) ? 0 : a);
  }, 0);
  const closeTimes = filtered.map(r => {
    const disb = parseDate(getField(r, 'Disbursement Date', 'disbursement date'));
    const created = parseDate(getField(r, 'Created Date', 'created date', 'create date'));
    return disb && created ? Math.floor((disb - created) / 86400000) : null;
  }).filter(v => v != null);
  const avgDays = closeTimes.length ? Math.round(closeTimes.reduce((s, v) => s + v, 0) / closeTimes.length) : null;

  const branchMap = new Map();
  for (const r of filtered) {
    const b = String(getField(r, 'Branch', 'branch') || '').trim() || 'No Branch';
    const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0);
    const entry = branchMap.get(b) || { count: 0, amt: 0 };
    entry.count++;
    entry.amt += isNaN(a) ? 0 : a;
    branchMap.set(b, entry);
  }
  const branchRows = [...branchMap.entries()]
    .sort((a, b) => b[1].amt - a[1].amt)
    .map(([name, { count, amt }]) =>
      '<tr><td>' + name + '</td>' +
      '<td style="text-align:center">' + count + '</td>' +
      '<td class="modal-amount">$' + amt.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '</td></tr>'
    ).join('');

  const summaryHtml =
    '<style>.pipeline-summary-table{font-size:11px;max-width:600px;border-collapse:collapse}' +
    '.pipeline-summary-table th{font-size:10px;padding:6px 10px;font-family:\'Barlow\',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;background:#0B192C;color:white}' +
    '.pipeline-summary-table td{padding:5px 10px;font-size:11px;border-bottom:1px solid #F1F5F9}' +
    '.pipeline-summary-table tr:last-child td{font-weight:700;background:#F8FAFC}</style>' +
    '<div class="pl-cw-summary">' +
      '<div class="pl-cw-summary-stats">' +
        '<span class="pl-cw-summary-total">Total Closed Won: <strong>' + totalCount + ' closing' + (totalCount !== 1 ? 's' : '') + ' · $' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '</strong></span>' +
        (avgDays != null ? '<span class="pl-cw-summary-avg">Avg. days to close: <strong>' + avgDays + 'd</strong></span>' : '') +
      '</div>' +
      (branchRows ? '<table class="pipeline-summary-table"><thead><tr><th>Branch</th><th>Closings</th><th>Loan Amount</th></tr></thead><tbody>' + branchRows + '</tbody></table>' : '') +
    '</div>';

  // Per-owner summary cards (CAMBIO 3 + 4)
  _cwDetailCache.clear();
  _cwDetailCache.set('ALL', filtered);
  let grandTotal = 0, grandCount = 0;

  // Tarjeta consolidada "ALL BDs" (mismo estilo que Open Pipeline)
  let allActive = 0, allInactive = 0;
  for (const key of allRealtorKeysCW) {
    const st = (realtorCacheCW.get(key) || {}).status || 'unknown';
    if (st === 'active') allActive++;
    else if (st === 'inactive') allInactive++;
  }
  const allBdBreakdown = [...byOwner.entries()]
    .map(([owner, opps]) => ({ owner, count: opps.length }))
    .filter(b => b.count > 0)
    .sort((a, b) => b.count - a.count)
    .map(b => '<div class="perf-leads-breakdown-row" style="cursor:pointer" data-cw-detail-owner="' + b.owner.replace(/"/g, '&quot;') + '" title="View ' + b.owner.replace(/"/g, '&quot;') + ' closings"><span class="plb-label">' + b.owner + '</span><span class="plb-count">' + b.count + '</span></div>')
    .join('');
  const allBdsCard =
    '<div class="pl-owner-card all-bds">' +
      '<div class="pl-allbds-header">' +
        '<div>' +
          '<div class="pl-allbds-title">ALL BDs</div>' +
          '<div class="pl-allbds-sub">' + byOwner.size + ' Business Developer' + (byOwner.size !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="pl-allbds-right">' +
          '<div class="pl-allbds-amt" style="font-size:24px;cursor:pointer;text-decoration:underline" data-cw-detail-owner="ALL" title="View all closings">' + totalCount + ' closing' + (totalCount !== 1 ? 's' : '') + '</div>' +
          '<div class="pl-allbds-sub" style="font-size:14px;color:rgba(255,255,255,0.8)">' + (totalAmt ? '$' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '$0') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pl-allbds-stats">' +
        '<div class="pl-allbds-stat"><div class="pl-allbds-stat-num" style="color:#1D9E75">' + allActive + '</div><div class="pl-allbds-stat-label">Active</div></div>' +
        '<div class="pl-allbds-stat"><div class="pl-allbds-stat-num" style="color:#E65100">' + allInactive + '</div><div class="pl-allbds-stat-label">Inactive</div></div>' +
        '<div class="pl-allbds-stat"><div class="pl-allbds-stat-num" style="color:#1565C0">' + allRealtorKeysCW.length + '</div><div class="pl-allbds-stat-label">Realtors</div></div>' +
      '</div>' +
      '<div class="perf-leads-breakdown" style="padding:6px 12px 12px">' + allBdBreakdown + '</div>' +
    '</div>';

  const cardsHtml = '<div class="pipeline-owners-grid">' + allBdsCard + [...byOwner.keys()].sort().map(owner => {
    const opps = byOwner.get(owner);
    _cwDetailCache.set(owner, opps);

    const ownerTotal = opps.reduce((s, r) => {
      const a = parseFloat(getField(r, 'Loan Amount', 'loan amount') || 0);
      return s + (isNaN(a) ? 0 : a);
    }, 0);
    grandTotal += ownerTotal;
    grandCount += opps.length;

    const branchCountMap = new Map();
    for (const r of opps) {
      const b = String(getField(r, 'Branch', 'branch') || '').trim() || 'No Branch';
      branchCountMap.set(b, (branchCountMap.get(b) || 0) + 1);
    }

    const ownerRealtorKeys = [...new Set(opps.map(r => {
      const ref = getField(r, 'Referred By', 'referred by');
      return ref ? norm(String(ref)) : null;
    }).filter(Boolean))];
    let activeC = 0, inactiveC = 0, unknownC = 0;
    for (const key of ownerRealtorKeys) {
      const st = (realtorCacheCW.get(key) || {}).status || 'unknown';
      if (st === 'active') activeC++;
      else if (st === 'inactive') inactiveC++;
      else unknownC++;
    }

    const branchRowsHtml = [...branchCountMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([branchName, count]) =>
        '<div class="pipeline-stage-row" data-cw-detail-owner="' + owner.replace(/"/g, '&quot;') + '">' +
          '<div><div class="pipeline-stage-row-name">' + branchName + '</div></div>' +
          '<span class="pipeline-stage-row-chip">' + count + '</span>' +
        '</div>'
      ).join('');

    const fmtOwnerTotal = ownerTotal ? '$' + ownerTotal.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';

    return '<div class="pl-owner-card pl-cw-card" style="cursor:pointer" data-cw-detail-owner="' + owner.replace(/"/g, '&quot;') + '">' +
      '<div class="pl-owner-header">' +
        '<div class="pl-owner-avatar">' + initials(owner) + '</div>' +
        '<div class="pl-owner-info">' +
          '<div class="pl-owner-name">' + owner + '</div>' +
          '<div class="pl-owner-meta">' + opps.length + ' closing' + (opps.length !== 1 ? 's' : '') + ' · ' + ownerRealtorKeys.length + ' realtor' + (ownerRealtorKeys.length !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="pl-owner-total">' + fmtOwnerTotal + '</div>' +
      '</div>' +
      '<div class="pl-realtor-summary">' +
        '<span class="pl-rs-item pl-chip-active"><i class="ti ti-check"></i> ' + activeC + ' active</span>' +
        '<span class="pl-rs-item pl-chip-inactive"><i class="ti ti-clock"></i> ' + inactiveC + ' inactive</span>' +
        (unknownC ? '<span class="pl-rs-item pl-chip-unknown"><i class="ti ti-help"></i> ' + unknownC + ' no data</span>' : '') +
      '</div>' +
      unknownWarningHtml('cw:' + owner, opps) +
      '<div class="pipeline-stages-list">' + branchRowsHtml + '</div>' +
    '</div>';
  }).join('') + '</div>';

  const grandFmt = grandTotal ? '$' + grandTotal.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';

  document.getElementById('pl-cw-content').innerHTML = summaryHtml + cardsHtml +
    '<div class="pl-grand-total">' +
      '<span>' + grandCount + ' total deal' + (grandCount !== 1 ? 's' : '') + '</span>' +
      '<span class="pl-grand-amt">' + grandFmt + '</span>' +
    '</div>';
}

export function clearPipelineFilters() {
  Array.from(document.getElementById('pl-filter-owner').options).forEach(o => o.selected = false);
  Array.from(document.getElementById('pl-cw-month').options).forEach(o => o.selected = false);
  Array.from(document.getElementById('pl-cw-year').options).forEach(o => o.selected = false);
  Array.from(document.getElementById('pl-filter-cw-branch').options).forEach(o => o.selected = false);
  renderPipeline();
  renderClosedWon();
}

export function clearClosedWonFilters() {
  const now = new Date();
  const curYear = String(now.getFullYear());
  const curMonth = String(now.getMonth());
  Array.from(document.getElementById('pl-cw-month').options).forEach(o => { o.selected = o.value === curMonth; });
  Array.from(document.getElementById('pl-cw-year').options).forEach(o => { o.selected = o.value === curYear; });
  Array.from(document.getElementById('pl-filter-cw-branch').options).forEach(o => o.selected = false);
  renderClosedWon();
}

export function downloadCwOwnerCsv(owner) {
  const rows = _cwCsvCache.get(owner);
  if (!rows) return;
  const csv = rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
  dl(new Blob([csv], { type: 'text/csv' }), (owner || 'cw') + '_closed_won.csv');
}

export function showClosedWonDetail(owner) {
  const inactiveCutoff = getInactiveCutoff();
  const opps = _cwDetailCache.get(owner);
  if (!opps || !opps.length) return;
  _cwDrill.clear();

  const realtorKeys = [...new Set(opps.map(r => {
    const ref = getField(r, 'Referred By', 'referred by');
    return ref ? norm(String(ref)) : null;
  }).filter(Boolean))];
  const cache = buildRealtorCache(realtorKeys, inactiveCutoff);

  const enriched = opps.map(row => {
    const ref = getField(row, 'Referred By', 'referred by');
    const realtorKey = ref ? norm(String(ref)) : null;
    const realtorName = ref ? String(ref).trim() : '—';
    const cached = realtorKey ? (cache.get(realtorKey) || { status: 'unknown', daysSince: null }) : { status: 'unknown', daysSince: null };
    const lnNum = String(getField(row, 'Loan #', 'loan #') || '—').trim();
    const oppName = String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim();
    const branch = String(getField(row, 'Branch', 'branch') || '').trim() || '—';
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    const ratifiedDate = parseDate(getField(row, 'Ratified Date', 'ratified date'));
    const createdDate = parseDate(getField(row, 'Created Date', 'created date', 'create date'));
    const amt = getField(row, 'Loan Amount', 'loan amount');
    const amtFmt = amt ? '$' + Number(amt).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
    const daysToClose = disbDate && ratifiedDate
      ? Math.floor((disbDate - ratifiedDate) / 86400000)
      : (disbDate && createdDate ? Math.floor((disbDate - createdDate) / 86400000) : null);
    const oppOwner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
    return { row, realtorKey, realtorName, oppOwner, status: cached.status, lnNum, oppName, branch, disbDate, ratifiedDate, createdDate, daysToClose, amt, amtFmt };
  });
  for (const e of enriched) { if (e.realtorKey) _cwDrill.set(e.realtorKey, e.realtorName); }

  const totalAmt = enriched.reduce((s, e) => {
    const a = parseFloat(getField(e.row, 'Loan Amount', 'loan amount') || 0);
    return s + (isNaN(a) ? 0 : a);
  }, 0);
  const totalFmt = totalAmt ? '$' + totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';

  const head = '<tr>' +
    '<th>Loan #</th><th>Opportunity Name</th><th>Realtor</th><th>Realtor Status</th>' +
    '<th>Branch</th><th>Disbursement Date</th><th>Ratified Date</th><th>Opp. Created</th><th>Days to Close</th><th>Loan Amount</th>' +
  '</tr>';

  const body = enriched.map(e => {
    const dtcClass = e.daysToClose == null ? '' : e.daysToClose < 90 ? 'days-to-close-fast' : e.daysToClose <= 180 ? 'days-to-close-medium' : 'days-to-close-slow';
    const dtcTxt = e.daysToClose != null ? e.daysToClose + 'd' : '—';
    return '<tr>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + e.lnNum + '</td>' +
      '<td style="font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis" title="' + e.oppName + '">' + e.oppName + '</td>' +
      '<td' + (e.realtorKey ? ' style="cursor:pointer;text-decoration:underline;color:#1D4ED8" data-drill-cw="' + e.realtorKey + '" data-cw-owner="' + e.oppOwner.replace(/"/g, '&quot;') + '"' : '') + '>' + e.realtorName + '</td>' +
      '<td>' + statusChipHtml(e.status) + '</td>' +
      '<td style="font-size:11px">' + e.branch + '</td>' +
      '<td class="dt">' + fmtDate(e.disbDate) + '</td>' +
      '<td class="dt">' + (e.ratifiedDate ? fmtDate(e.ratifiedDate) : '—') + '</td>' +
      '<td class="dt">' + fmtDate(e.createdDate) + '</td>' +
      '<td style="text-align:center"><span class="' + dtcClass + '">' + dtcTxt + '</span></td>' +
      '<td class="modal-amount">' + e.amtFmt + '</td>' +
    '</tr>';
  }).join('');

  const csvData = [
    ['Loan #', 'Opportunity Name', 'Realtor', 'Realtor Status', 'Branch', 'Disbursement Date', 'Ratified Date', 'Opp. Created', 'Days to Close', 'Loan Amount'],
    ...enriched.map(e => [
      e.lnNum, e.oppName, e.realtorName, e.status, e.branch === '—' ? '' : e.branch,
      fmtDate(e.disbDate), e.ratifiedDate ? fmtDate(e.ratifiedDate) : '', fmtDate(e.createdDate), e.daysToClose ?? '', e.amt || ''
    ])
  ];

  openModal(
    (owner === 'ALL' ? 'ALL BDs' : owner) + ' — Closed Won',
    enriched.length + ' closing' + (enriched.length !== 1 ? 's' : '') + ' · Total: ' + totalFmt,
    head, body, csvData
  );
}

document.addEventListener('click', e => {
  const unk = e.target.closest('[data-unknown-key]');
  if (unk) {
    showUnknownRealtorDetail(unk.getAttribute('data-unknown-key'));
    return;
  }
  const el = e.target.closest('[data-cw-detail-owner]');
  if (!el) return;
  showClosedWonDetail(el.getAttribute('data-cw-detail-owner'));
});

// Healthiness chips → modal de detalle (BD Pipeline)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-pipeline-health]');
  if (!el || !el.closest('#pl-pipeline-content')) return;
  const owner = el.getAttribute('data-owner');
  const opps = _healthCacheP.get(owner);
  if (!opps) return;
  openHealthModal(opps, owner === 'ALL' ? 'ALL BDs' : owner, el.getAttribute('data-health'));
});

// Drill-down: Realtor Name en Pipeline stage detail → sus opps abiertas (← Back)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-drill-pipe]');
  if (!el || !el.closest('#detail-modal')) return;
  const d = _pipeDrill.get(el.getAttribute('data-drill-pipe'));
  if (!d) return;
  const rows = _pipelineOpenRowsForRealtor(d.realtorKey);
  pushModalView({
    title: d.realtorName + ' — Pipeline Opportunities',
    subtitle: rows.length + ' open opportunit' + (rows.length !== 1 ? 'ies' : 'y'),
    content: _drillPipeRealtorTable(rows)
  });
});

// Drill-down: Realtor en Closed Won detail → historial completo de closings (← Back)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-drill-cw]');
  if (!el || !el.closest('#detail-modal')) return;
  const key = el.getAttribute('data-drill-cw');
  const owner = el.getAttribute('data-cw-owner') || '';
  const rows = _cwHistoryForRealtor(key);
  if (!rows.length) return;
  const realtorName = _cwDrill.get(key) || String(getField(rows[0], 'Referred By', 'referred by') || '').trim() || key;
  pushModalView({
    title: realtorName + ' — Closing History',
    subtitle: 'All closings with ' + (owner || '—'),
    content: _cwHistoryTable(rows, key)
  });
});

// Descargar CSV desde el drill de Closing History
document.addEventListener('click', e => {
  const el = e.target.closest('[data-cw-csv]');
  if (!el || !el.closest('#detail-modal')) return;
  dl(_cwHistoryCsv(_cwHistoryForRealtor(el.getAttribute('data-cw-csv'))), 'closing-history.csv');
});
