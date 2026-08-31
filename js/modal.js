import { state } from './state.js';
import { fmtDate, parseDate, getField, norm } from './utils.js';
import { dl } from './export.js';
import { matchesStrategy } from './strategy.js';

// ── Navegación interna del modal (drill-down con "← Back") ──
const _modalStack = [];
const _mTitle = () => document.getElementById('modal-title');
const _mSub = () => document.getElementById('modal-sub');
const _mBody = () => document.querySelector('#detail-modal .modal-body');
const _mHeader = () => document.querySelector('#detail-modal .modal-header');

function _setModalContent({ title, subtitle, content }) {
  const t = _mTitle(), s = _mSub(), b = _mBody();
  if (t) t.textContent = title || '';
  if (s) s.textContent = subtitle || '';
  if (b) b.innerHTML = content || '';
}
function _showBackButton() {
  let btn = document.getElementById('modal-back-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'modal-back-btn';
    btn.className = 'modal-back-btn';
    btn.innerHTML = '&#8592; Back';
    btn.onclick = popModalView;
    const header = _mHeader();
    if (header) header.prepend(btn);
  }
  btn.style.display = 'inline-flex';
}
function _hideBackButton() {
  const btn = document.getElementById('modal-back-btn');
  if (btn) btn.style.display = 'none';
}
export function pushModalView({ title, subtitle, content }) {
  _modalStack.push({ title: _mTitle()?.textContent, subtitle: _mSub()?.textContent, content: _mBody()?.innerHTML });
  _showBackButton();
  _setModalContent({ title, subtitle, content });
}
export function popModalView() {
  if (_modalStack.length === 0) return;
  _setModalContent(_modalStack.pop());
  if (_modalStack.length === 0) _hideBackButton();
}
export function clearModalStack() {
  _modalStack.length = 0;
  _hideBackButton();
}

export function openModal(title, sub, headHtml, bodyHtml, csvData) {
  clearModalStack();
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-sub').textContent = sub;
  const modalBody = document.querySelector('#detail-modal .modal-body');
  if (headHtml) {
    modalBody.innerHTML = '<table class="modal-table"><thead id="modal-thead"></thead><tbody id="modal-tbody"></tbody></table>';
    document.getElementById('modal-thead').innerHTML = headHtml;
    document.getElementById('modal-tbody').innerHTML = bodyHtml;
  } else {
    modalBody.innerHTML = bodyHtml;
  }
  let csvBtn = document.getElementById('modal-csv-btn');
  if (!csvBtn) {
    csvBtn = document.createElement('button');
    csvBtn.id = 'modal-csv-btn';
    csvBtn.className = 'modal-csv-btn';
    document.querySelector('#detail-modal .modal-close').before(csvBtn);
  }
  csvBtn.style.display = csvData ? '' : 'none';
  if (csvData) {
    csvBtn.innerHTML = '<i class="ti ti-download"></i> Download CSV';
    csvBtn.onclick = () => dl(csvData, 'detalle.csv');
  }
  document.getElementById('detail-modal').classList.remove('hidden');
}

export function closeModal(e) {
  if (e.target === document.getElementById('detail-modal')) {
    document.getElementById('detail-modal').classList.add('hidden');
    clearModalStack();
  }
}

export function showScorecardDetail(owner, med) {
  const rows = state.activeResults.filter(r => r.assignedOwner === owner && r.med === med && matchesStrategy(r));
  if (!rows.length) return;

  const cutoffStr = document.getElementById('cutoff-date').value;
  const windowDays = parseInt(document.getElementById('window-days').value) || 60;
  const cutoff = new Date(cutoffStr + 'T23:59:59Z');
  const floorDate = new Date(cutoff);
  floorDate.setUTCDate(floorDate.getUTCDate() - windowDays);
  floorDate.setUTCHours(0, 0, 0, 0);

  const head = '<tr>' +
    '<th>#</th>' +
    '<th>Realtor</th>' +
    '<th>Branch</th>' +
    '<th>Period Leads</th>' +
    '<th>Converted to Opp.</th>' +
    '<th>1st Lead</th>' +
    '<th>2nd to Last Lead</th>' +
    '<th>Leads w/ Pre-Appr</th>' +
    '<th>Leads w/ Ratified</th>' +
    '<th>Leads Closed Won</th>' +
    '<th>Curr. Pre-Approval</th>' +
    '<th>Curr. Ratified</th>' +
    '<th>Curr. Closed Won</th>' +
    '</tr>';

  const body = rows.map((r, i) =>
    '<tr>' +
    '<td style="color:#8899BB;font-size:10px">' + (i + 1) + '</td>' +
    '<td style="font-weight:600">' + r.name + '</td>' +
    '<td>' + (r.assignedBranch || '—') + '</td>' +
    '<td style="text-align:center"><span class="clickable-num" data-rkey="' + encodeURIComponent(r.key) + '" data-dtype="leads" title="View leads">' + r.cnt + '</span></td>' +
    '<td style="text-align:center;font-weight:700">' + (r.convertedCount ? '<span class="clickable-num" data-rkey="' + encodeURIComponent(r.key) + '" data-dtype="converted" title="View converted leads">' + r.convertedCount + '</span>' : '&#8211;') + '</td>' +
    '<td class="dt">' + fmtDate(r.firstDate) + '</td>' +
    '<td class="dt">' + fmtDate(r.penult) + '</td>' +
    '<td style="text-align:center;color:' + (r.pa ? '#185FA5' : '#CCD5E0') + '">' + (r.pa || '—') + '</td>' +
    '<td style="text-align:center;color:' + (r.rat ? '#3C3489' : '#CCD5E0') + '">' + (r.rat || '—') + '</td>' +
    '<td style="text-align:center;color:' + (r.cw ? '#085041' : '#CCD5E0') + ';font-weight:' + (r.cw ? '700' : '400') + '">' + (r.cw || '—') + '</td>' +
    '<td style="text-align:center;color:' + (r.curPa ? '#185FA5' : '#CCD5E0') + ';font-style:italic">' + (r.curPa || '—') + '</td>' +
    '<td style="text-align:center;color:' + (r.curRat ? '#3C3489' : '#CCD5E0') + ';font-style:italic">' + (r.curRat || '—') + '</td>' +
    '<td style="text-align:center;color:' + (r.curCw ? '#085041' : '#CCD5E0') + ';font-style:italic;font-weight:' + (r.curCw ? '700' : '400') + '">' + (r.curCw || '—') + '</td>' +
    '</tr>'
  ).join('');

  const csvData = [
    ['#', 'Realtor', 'Branch', 'Period Leads', 'Converted to Opp.', '1st Lead', '2nd to Last Lead',
     'Leads w/ Pre-Appr', 'Leads w/ Ratified', 'Leads Closed Won',
     'Curr. Pre-Approval', 'Curr. Ratified', 'Curr. Closed Won'],
    ...rows.map((r, i) => [
      i + 1, r.name, r.assignedBranch || '', r.cnt, r.convertedCount || 0,
      fmtDate(r.firstDate), fmtDate(r.penult),
      r.pa || 0, r.rat || 0, r.cw || 0,
      r.curPa || 0, r.curRat || 0, r.curCw || 0
    ])
  ];

  openModal(
    owner + ' — ' + med,
    rows.length + ' realtor' + (rows.length !== 1 ? 's' : '') + ' · window: ' + fmtDate(floorDate) + ' → ' + fmtDate(cutoff),
    head,
    body,
    csvData
  );
}

// Realtors "direct-to-opportunity" (fromOppsOnly): no tienen leads reales, sus
// leads/conversiones son sintéticos (1 por oportunidad). El modal muestra las
// OPORTUNIDADES tal cual, no filas de lead inventadas — así queda claro de dónde
// sale el conteo. Se usa tanto para "Period Leads" como para "Converted to Opp.".
function showSyntheticOppLeads(r, realtorName, titleSuffix) {
  const rows = r.oppRows || [];
  if (!rows.length) { alert('No opportunities available.'); return; }
  const head = '<tr>' +
    '<th>#</th>' +
    '<th>Opportunity Name</th>' +
    '<th>Opportunity Owner</th>' +
    '<th>Stage</th>' +
    '<th>Created Date</th>' +
    '</tr>';
  const body = rows.map((row, i) => {
    const oppName = String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim();
    const owner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '—').trim();
    const stage = String(getField(row, 'Stage', 'stage') || '—').trim();
    const cd = parseDate(getField(row, 'Created Date', 'created date'));
    return '<tr>' +
      '<td style="color:#8899BB;font-size:10px">' + (i + 1) + '</td>' +
      '<td style="font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis" title="' + oppName + '">' + oppName + '</td>' +
      '<td style="font-size:11px;color:#556080">' + owner + '</td>' +
      '<td><span class="modal-stage stage-other">' + stage + '</span></td>' +
      '<td class="dt">' + fmtDate(cd) + '</td>' +
      '</tr>';
  }).join('');
  const csvData = [
    ['#', 'Opportunity Name', 'Opportunity Owner', 'Stage', 'Created Date'],
    ...rows.map((row, i) => {
      const oppName = String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim();
      const owner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
      const stage = String(getField(row, 'Stage', 'stage') || '').trim();
      const cd = parseDate(getField(row, 'Created Date', 'created date'));
      return [i + 1, oppName, owner, stage, fmtDate(cd)];
    })
  ];
  openModal(
    realtorName + ' — ' + titleSuffix,
    rows.length + ' opportunit' + (rows.length !== 1 ? 'ies' : 'y') + ' · direct-to-opportunity (no leads); each counts as 1 lead & 1 conversion',
    head, body, csvData
  );
}

export function showLeadDetail(key, realtorName) {
  const allResults = [...state.activeResults, ...state.inactiveResults];
  const r = allResults.find(x => x.key === key);
  if (r && r.fromOppsOnly) return showSyntheticOppLeads(r, realtorName, 'Period Leads');
  if (!r || !r.leadRows || !r.leadRows.length) { alert('No leads available.'); return; }
  const rows = r.leadRows;
  const head = '<tr>' +
    '<th>#</th>' +
    '<th>Lead Name</th>' +
    '<th>Lead Owner</th>' +
    '<th>Lead Status</th>' +
    '<th>Created Date</th>' +
    '</tr>';
  const body = rows.map((row, i) => {
    const fn = String(getField(row, 'First Name', 'first name') || '').trim();
    const ln = String(getField(row, 'Last Name', 'last name') || '').trim();
    const co = String(getField(row, 'Company / Account', 'company / account') || '').trim();
    const name = (fn + ' ' + ln).trim() || co || '—';
    const leadOwner = String(getField(row, 'Lead Owner', 'lead owner', 'owner') || '—').trim();
    const status = String(getField(row, 'Lead Status', 'lead status', 'status') || '—').trim();
    const cd = parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'));
    return '<tr>' +
      '<td style="color:#8899BB;font-size:10px">' + (i + 1) + '</td>' +
      '<td style="font-weight:600">' + name + '</td>' +
      '<td style="font-size:11px;color:#556080">' + leadOwner + '</td>' +
      '<td><span class="modal-stage stage-other">' + status + '</span></td>' +
      '<td class="dt">' + fmtDate(cd) + '</td>' +
      '</tr>';
  }).join('');
  const csvData = [
    ['#', 'Lead Name', 'Lead Owner', 'Lead Status', 'Created Date'],
    ...rows.map((row, i) => {
      const fn = String(getField(row, 'First Name', 'first name') || '').trim();
      const ln = String(getField(row, 'Last Name', 'last name') || '').trim();
      const co = String(getField(row, 'Company / Account', 'company / account') || '').trim();
      const name = (fn + ' ' + ln).trim() || co || '';
      const leadOwner = String(getField(row, 'Lead Owner', 'lead owner', 'owner') || '').trim();
      const status = String(getField(row, 'Lead Status', 'lead status', 'status') || '').trim();
      const cd = parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'));
      return [i + 1, name, leadOwner, status, fmtDate(cd)];
    })
  ];
  openModal(
    realtorName + ' — Period Leads',
    rows.length + ' lead' + (rows.length !== 1 ? 's' : '') + ' in the selected window',
    head, body, csvData
  );
}

export function showOppDetail(key, realtorName, colType) {
  const allResults = [...state.activeResults, ...state.inactiveResults];
  const r = allResults.find(x => x.key === key);
  if (!r || !r.oppRows || !r.oppRows.length) { alert('No opportunities available.'); return; }

  const cutoffStr = document.getElementById('cutoff-date').value;
  const windowDays = parseInt(document.getElementById('window-days').value) || 60;
  const cutoff = new Date(cutoffStr + 'T23:59:59Z');
  const floorDate = new Date(cutoff); floorDate.setUTCDate(floorDate.getUTCDate() - windowDays);

  // Range-aware: para realtors INACTIVOS el conteo va sobre inactFloor..cutoff
  // (igual que calc.js), no la ventana de 60d. Activos: ventana sin cambios.
  const inactFromStr = document.getElementById('inactive-from').value;
  const inactFloor = inactFromStr ? new Date(inactFromStr + 'T00:00:00Z') : new Date('2024-01-01');
  const isInactiveKey = state.inactiveResults.some(x => x.key === key);
  const rangeFloor = isInactiveKey ? inactFloor : floorDate;

  const filtered = r.oppRows.filter(row => {
    const stage = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    const paDate = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre approved date'));
    const ratDate = parseDate(getField(row, 'Ratified Date', 'ratified date'));
    // All-time Closings: todos los Closed Won, SIN filtro de fecha (incluye los
    // que no tienen Disbursement Date). Sin filtro de lender ni de exclusión.
    if (colType === 'cwAll') return stage === 'closed won';
    const isCW = stage === 'closed won' && disbDate && disbDate >= rangeFloor && disbDate <= cutoff;
    const isRat = ratDate && ratDate >= rangeFloor && ratDate <= cutoff;
    const isPA = paDate && paDate >= rangeFloor && paDate <= cutoff;
    if (colType === 'pa') return isPA;
    if (colType === 'rat') return isRat;
    if (colType === 'cw') return isCW;
    if (stage === 'closed lost') return false;
    if (colType === 'curCw') return isCW;
    if (colType === 'curRat') return !isCW && isRat;
    if (colType === 'curPa') return !isCW && !isRat && isPA;
    return false;
  });

  if (!filtered.length) { alert('No opportunities found for this filter.'); return; }

  const labels = {
    pa: 'Leads w/ Pre-Approval', rat: 'Leads w/ Ratified', cw: 'Leads Closed Won',
    curPa: 'Curr. Pre-Approval', curRat: 'Curr. Ratified', curCw: 'Curr. Closed Won',
    cwAll: 'All-time Closings'
  };
  const dateLabel = { pa: 'Pre-Approval Date', rat: 'Ratified Date', cw: 'Disbursement Date', curPa: 'Pre-Approval Date', curRat: 'Ratified Date', curCw: 'Disbursement Date', cwAll: 'Disbursement Date' };
  const stageCls = { pa: 'stage-pa', rat: 'stage-rat', cw: 'stage-cw', curPa: 'stage-pa', curRat: 'stage-rat', curCw: 'stage-cw', cwAll: 'stage-cw' };

  const head = '<tr>' +
    '<th>#</th>' +
    '<th>Loan #</th>' +
    '<th>Opportunity Name</th>' +
    '<th>Loan Officer</th>' +
    '<th>Branch</th>' +
    '<th>Lender</th>' +
    '<th>Loan Amount</th>' +
    '<th>' + dateLabel[colType] + '</th>' +
    '<th>Stage</th>' +
    '</tr>';

  const body = filtered.map((row, i) => {
    const oppName = String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim();
    const lo = String(getField(row, 'Loan Officer', 'loan officer', 'Loan Officers', 'loan officers') || '—').trim();
    const branch = String(getField(row, 'Branch', 'branch') || '—').trim();
    const lender = String(getField(row, 'Lender', 'lender') || '—').trim();
    const amt = getField(row, 'Loan Amount', 'loan amount', 'Loan #', 'loan #');
    const amtFmt = amt ? '$' + Number(amt).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—';
    const stage = String(getField(row, 'Stage', 'stage') || '—').trim();
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    const paDate = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre approved date'));
    const ratDate = parseDate(getField(row, 'Ratified Date', 'ratified date'));
    let dateVal = null;
    if (colType === 'pa' || colType === 'curPa') dateVal = paDate;
    else if (colType === 'rat' || colType === 'curRat') dateVal = ratDate;
    else if (colType === 'cw' || colType === 'curCw' || colType === 'cwAll') dateVal = disbDate;
    const lnNum = String(getField(row, 'Loan #', 'loan #') || '—').trim();
    return '<tr>' +
      '<td style="color:#8899BB;font-size:10px">' + (i + 1) + '</td>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + lnNum + '</td>' +
      '<td style="font-weight:600;max-width:160px;overflow:hidden;text-overflow:ellipsis" title="' + oppName + '">' + oppName + '</td>' +
      '<td>' + lo + '</td>' +
      '<td>' + branch + '</td>' +
      '<td>' + lender + '</td>' +
      '<td class="modal-amount">' + amtFmt + '</td>' +
      '<td class="dt">' + fmtDate(dateVal) + '</td>' +
      '<td><span class="modal-stage ' + stageCls[colType] + '">' + stage + '</span></td>' +
      '</tr>';
  }).join('');

  const csvData = [
    ['#', 'Loan #', 'Opportunity Name', 'Loan Officer', 'Branch', 'Lender', 'Loan Amount', dateLabel[colType], 'Stage'],
    ...filtered.map((row, i) => {
      const oppName = String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim();
      const lo = String(getField(row, 'Loan Officer', 'loan officer', 'Loan Officers', 'loan officers') || '').trim();
      const branch = String(getField(row, 'Branch', 'branch') || '').trim();
      const lender = String(getField(row, 'Lender', 'lender') || '').trim();
      const amt = getField(row, 'Loan Amount', 'loan amount', 'Loan #', 'loan #');
      const stage = String(getField(row, 'Stage', 'stage') || '').trim();
      const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
      const paDate = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre approved date'));
      const ratDate = parseDate(getField(row, 'Ratified Date', 'ratified date'));
      let dateVal = null;
      if (colType === 'pa' || colType === 'curPa') dateVal = paDate;
      else if (colType === 'rat' || colType === 'curRat') dateVal = ratDate;
      else if (colType === 'cw' || colType === 'curCw' || colType === 'cwAll') dateVal = disbDate;
      const lnNum = String(getField(row, 'Loan #', 'loan #') || '').trim();
      return [i + 1, lnNum, oppName, lo, branch, lender, amt || '', fmtDate(dateVal), stage];
    })
  ];

  const rangeText = colType === 'cwAll'
    ? 'all-time (no date filter)'
    : 'window: ' + fmtDate(rangeFloor) + ' → ' + fmtDate(cutoff);
  openModal(
    realtorName + ' — ' + labels[colType],
    filtered.length + ' opportunit' + (filtered.length !== 1 ? 'ies' : 'y') + ' · ' + rangeText,
    head, body, csvData
  );
}

export function showConvertedLeadsDetail(key, realtorName) {
  const cutoffStr = document.getElementById('cutoff-date').value;
  const windowDays = parseInt(document.getElementById('window-days').value) || 60;
  const cutoff = new Date(cutoffStr + 'T23:59:59Z');
  const floorDate = new Date(cutoff);
  floorDate.setUTCDate(floorDate.getUTCDate() - windowDays);
  floorDate.setUTCHours(0, 0, 0, 0);

  const allResults = [...state.activeResults, ...state.inactiveResults];
  const r = allResults.find(x => x.key === key);
  if (r && r.fromOppsOnly) return showSyntheticOppLeads(r, realtorName, 'Converted to Opp.');
  if (!r || !r.leadRows || !r.leadRows.length) { alert('No converted leads available.'); return; }

  const rows = r.leadRows.filter(row => {
    const v = getField(row, 'Converted', 'converted');
    return v === true || String(v || '').trim().toLowerCase() === 'true';
  });
  if (!rows.length) { alert('No converted leads found in the selected window.'); return; }

  const head = '<tr>' +
    '<th>#</th>' +
    '<th>Lead Name</th>' +
    '<th>Owner/BD</th>' +
    '<th>Created Date</th>' +
    '<th>Lead Status</th>' +
    '</tr>';

  const body = rows.map((row, i) => {
    const fn = String(getField(row, 'First Name', 'first name') || '').trim();
    const ln = String(getField(row, 'Last Name', 'last name') || '').trim();
    const name = (fn + ' ' + ln).trim() || '—';
    const owner = String(getField(row, 'Lead Owner', 'lead owner', 'owner') || '—').trim();
    const cd = parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'));
    const status = String(getField(row, 'Lead Status', 'lead status', 'status') || '—').trim();
    return '<tr>' +
      '<td style="color:#8899BB;font-size:10px">' + (i + 1) + '</td>' +
      '<td style="font-weight:600">' + name + '</td>' +
      '<td>' + owner + '</td>' +
      '<td class="dt">' + fmtDate(cd) + '</td>' +
      '<td><span class="modal-stage stage-other">' + status + '</span></td>' +
      '</tr>';
  }).join('');

  const csvData = [
    ['#', 'Lead Name', 'Owner/BD', 'Created Date', 'Lead Status'],
    ...rows.map((row, i) => {
      const fn = String(getField(row, 'First Name', 'first name') || '').trim();
      const ln = String(getField(row, 'Last Name', 'last name') || '').trim();
      const owner = String(getField(row, 'Lead Owner', 'lead owner', 'owner') || '').trim();
      const cd = parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'));
      const status = String(getField(row, 'Lead Status', 'lead status', 'status') || '').trim();
      return [i + 1, (fn + ' ' + ln).trim() || '', owner, fmtDate(cd), status];
    })
  ];

  openModal(
    realtorName + ' — Converted to Opp.',
    rows.length + ' converted lead' + (rows.length !== 1 ? 's' : '') + ' · window: ' + fmtDate(floorDate) + ' → ' + fmtDate(cutoff),
    head, body, csvData
  );
}

export function showAllLeadsForRealtor(key, realtorName) {
  const decodedKey = decodeURIComponent(key);

  const allLeads = (state.leadsData || []).filter(row => {
    const ref = getField(row, 'Referred By', 'referred by');
    return ref && norm(String(ref)) === decodedKey;
  });
  allLeads.sort((a, b) => {
    const da = parseDate(getField(a, 'Created Date', 'Create Date', 'created date'));
    const db = parseDate(getField(b, 'Created Date', 'Create Date', 'created date'));
    return (da || 0) - (db || 0);
  });

  const allResults = state.activeResults.concat(state.inactiveResults);
  const r = allResults.find(x => x.key === decodedKey);
  const allOpps = (r && r.oppRows) ? r.oppRows : [];

  if (!allLeads.length && !allOpps.length) {
    alert('No data available for this realtor.');
    return;
  }

  const firstDate = allLeads.length ? parseDate(getField(allLeads[0], 'Created Date', 'Create Date', 'created date')) : null;
  const lastDate  = allLeads.length ? parseDate(getField(allLeads[allLeads.length - 1], 'Created Date', 'Create Date', 'created date')) : null;

  const convertedLeadsCount = allLeads.filter(row => {
    const v = getField(row, 'Converted', 'converted');
    return v === true || String(v || '').trim().toLowerCase() === 'true';
  }).length;
  const sub = allLeads.length + ' lead' + (allLeads.length !== 1 ? 's' : '') +
    ' · ' + convertedLeadsCount + ' converted' +
    (firstDate ? ' · oldest: ' + fmtDate(firstDate) : '') +
    (lastDate  ? ' · most recent: ' + fmtDate(lastDate) : '') +
    ' · ' + allOpps.length + ' opportunit' + (allOpps.length !== 1 ? 'ies' : 'y');

  const secStyle = 'font-family:\'Barlow\',sans-serif;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--hs-red);margin-bottom:8px';
  const divStyle = 'border-top:2px solid var(--hs-red);margin:20px 0 12px';

  const leadsHead = '<tr><th>#</th><th>Lead Name</th><th>Owner/BD</th><th>Created Date</th><th>Branch</th><th>Converted</th></tr>';
  const leadsBody = allLeads.map((row, i) => {
    const fn     = String(getField(row, 'First Name', 'first name') || '').trim();
    const ln     = String(getField(row, 'Last Name', 'last name') || '').trim();
    const leadName = (fn + ' ' + ln).trim() || '—';
    const owner  = String(getField(row, 'Lead Owner', 'lead owner', 'owner') || '—').trim();
    const cd     = parseDate(getField(row, 'Created Date', 'Create Date', 'created date'));
    const branch = String(getField(row, 'Branch', 'branch') || '—').trim();
    const convVal = getField(row, 'Converted', 'converted');
    const isConv = convVal === true || String(convVal || '').trim().toLowerCase() === 'true';
    return '<tr>' +
      '<td style="color:#8899BB;font-size:10px">' + (i + 1) + '</td>' +
      '<td style="font-weight:600">' + leadName + '</td>' +
      '<td>' + owner + '</td>' +
      '<td class="dt">' + fmtDate(cd) + '</td>' +
      '<td>' + branch + '</td>' +
      '<td style="text-align:center">' + (isConv ? '<span class="pl-status-chip pl-chip-active">Yes</span>' : '<span class="pl-status-chip pl-chip-unknown">No</span>') + '</td>' +
      '</tr>';
  }).join('');

  function stageColor(s) {
    const sl = (s || '').toLowerCase();
    if (sl === 'closed won')  return '#085041';
    if (sl === 'closed lost') return '#C0392B';
    if (sl === 'proposal')    return '#185FA5';
    if (sl === 'negotiation') return '#3C3489';
    return '#667799';
  }

  const oppsHead = '<tr><th>Loan #</th><th>Created Date</th><th>Opportunity Name</th><th>Opp. Owner</th><th>Branch</th><th>Loan Officer</th><th>Current Stage</th><th>Last Milestone Date</th><th>Last Milestone</th></tr>';
  const oppsBody = allOpps.map(row => {
    const lnNum    = String(getField(row, 'Loan #', 'loan #') || '—').trim();
    const oppName  = String(getField(row, 'Opportunity Name', 'opportunity name') || '—').trim();
    const oppOwner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '—').trim();
    const branch   = String(getField(row, 'Branch', 'branch') || '—').trim();
    const lo       = String(getField(row, 'Loan Officer', 'loan officer', 'Loan Officers', 'loan officers') || '—').trim();
    const stage    = String(getField(row, 'Stage', 'stage') || '—').trim();
    const oppCd    = parseDate(getField(row, 'Created Date', 'created date', 'create date'));
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    const ratDate  = parseDate(getField(row, 'Ratified Date', 'ratified date'));
    const paDate   = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre approved date'));
    let lastReachedDate, lastReachedStage;
    if (stage.toLowerCase() === 'closed won' && disbDate) { lastReachedDate = disbDate; lastReachedStage = 'Closed Won'; }
    else if (ratDate) { lastReachedDate = ratDate; lastReachedStage = 'Ratified'; }
    else if (paDate)  { lastReachedDate = paDate;  lastReachedStage = 'Pre-Approval'; }
    else              { lastReachedDate = null;     lastReachedStage = '—'; }
    const sc = stageColor(stage);
    return '<tr>' +
      '<td style="font-family:monospace;font-size:10px;color:#556080">' + lnNum + '</td>' +
      '<td class="dt">' + fmtDate(oppCd) + '</td>' +
      '<td style="font-weight:600;max-width:160px;overflow:hidden;text-overflow:ellipsis" title="' + oppName + '">' + oppName + '</td>' +
      '<td>' + oppOwner + '</td>' +
      '<td>' + branch + '</td>' +
      '<td>' + lo + '</td>' +
      '<td><span style="color:' + sc + ';font-weight:600">' + stage + '</span></td>' +
      '<td class="dt">' + fmtDate(lastReachedDate) + '</td>' +
      '<td style="color:#667799;font-size:10px;font-weight:600">' + lastReachedStage + '</td>' +
      '</tr>';
  }).join('');

  const bodyHtml =
    '<div style="' + secStyle + '">Leads (' + allLeads.length + ')</div>' +
    '<div style="overflow-x:auto">' +
      '<table class="modal-table"><thead>' + leadsHead + '</thead><tbody>' + leadsBody + '</tbody></table>' +
    '</div>' +
    '<div style="' + divStyle + '"></div>' +
    '<div style="' + secStyle + '">Opportunities (' + allOpps.length + ')</div>' +
    '<div style="overflow-x:auto">' +
      '<table class="modal-table"><thead>' + oppsHead + '</thead><tbody>' + oppsBody + '</tbody></table>' +
    '</div>';

  const csvData = [
    ['LEADS'],
    ['#', 'Lead Name', 'Realtor', 'Owner/BD', 'Created Date', 'Branch', 'Converted'],
    ...allLeads.map((row, i) => {
      const fn     = String(getField(row, 'First Name', 'first name') || '').trim();
      const ln     = String(getField(row, 'Last Name', 'last name') || '').trim();
      const leadName = (fn + ' ' + ln).trim() || '';
      const owner  = String(getField(row, 'Lead Owner', 'lead owner', 'owner') || '').trim();
      const cd     = parseDate(getField(row, 'Created Date', 'Create Date', 'created date'));
      const branch = String(getField(row, 'Branch', 'branch') || '').trim();
      const convVal = getField(row, 'Converted', 'converted');
      const isConv = convVal === true || String(convVal || '').trim().toLowerCase() === 'true';
      return [i + 1, leadName, realtorName, owner, fmtDate(cd), branch, isConv ? 'Yes' : 'No'];
    }),
    [],
    ['OPPORTUNITIES'],
    ['Loan #', 'Created Date', 'Opportunity Name', 'Opp. Owner', 'Branch', 'Loan Officer', 'Current Stage', 'Last Milestone Date', 'Last Milestone'],
    ...allOpps.map(row => {
      const lnNum    = String(getField(row, 'Loan #', 'loan #') || '').trim();
      const oppName  = String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim();
      const oppOwner = String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim();
      const branch   = String(getField(row, 'Branch', 'branch') || '').trim();
      const lo       = String(getField(row, 'Loan Officer', 'loan officer', 'Loan Officers', 'loan officers') || '').trim();
      const stage    = String(getField(row, 'Stage', 'stage') || '').trim();
      const oppCd    = parseDate(getField(row, 'Created Date', 'created date', 'create date'));
      const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
      const ratDate  = parseDate(getField(row, 'Ratified Date', 'ratified date'));
      const paDate   = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre approved date'));
      let lastReachedDate, lastReachedStage;
      if (stage.toLowerCase() === 'closed won' && disbDate) { lastReachedDate = disbDate; lastReachedStage = 'Closed Won'; }
      else if (ratDate) { lastReachedDate = ratDate; lastReachedStage = 'Ratified'; }
      else if (paDate)  { lastReachedDate = paDate;  lastReachedStage = 'Pre-Approval'; }
      else              { lastReachedDate = null;     lastReachedStage = '—'; }
      return [lnNum, fmtDate(oppCd), oppName, oppOwner, branch, lo, stage, fmtDate(lastReachedDate), lastReachedStage];
    })
  ];

  openModal(realtorName + ' — Full Profile', sub, '', bodyHtml, csvData);
}
