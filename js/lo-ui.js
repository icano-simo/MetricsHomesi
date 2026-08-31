import { state } from './state.js';
import { bus } from './events.js';
import { fmtDate } from './utils.js';
import { BADGE } from './config.js';
import { matchesStrategy } from './strategy.js';

// NPPM badge (contracted/referred, and by which NPPM) — same as the B2B section.
// English UI copy; referred badge shows the referrer name (referred_by_nppm).
function stratBadge(r) {
  if (!r || r.strategy !== 'NPPM') return '';
  const referred = r.isNppmReferred && !r.isNppmContracted;
  const by = r.referredByNppm ? String(r.referredByNppm) : '';
  const label = referred ? ('NPPM &#8592; ' + (by || 'referred')) : 'NPPM';
  const title = referred
    ? ('NPPM strategy — referred by ' + (by || 'an NPPM'))
    : 'NPPM strategy — contracted';
  return '<span title="' + title + '" style="display:inline-block;margin-left:4px;font-size:8px;font-weight:700;color:#4C1D95;background:#EDE9FE;border-radius:3px;padding:1px 4px;vertical-align:middle;letter-spacing:.3px">' + label + '</span>';
}

export function renderLoSummary(_w, filtActive, filtInactive, cutoffDate, floorDate, inactFrom) {
  const src = (filtActive || state.loActiveResults).filter(matchesStrategy);
  const srcInact = (filtInactive || state.loInactiveResults).filter(r => r.assignedOwner && r.assignedOwner !== '' && matchesStrategy(r));
  const total = src.length, inact = srcInact.length;
  const h = src.filter(r => r.med.startsWith('Hunting')).length;
  const f = src.filter(r => r.med.startsWith('Farming')).length;
  const clos = src.filter(r => r.med.includes('Closing')).length;
  const fd = floorDate ? fmtDate(floorDate) : '';
  const cd = cutoffDate ? fmtDate(cutoffDate) : '';
  const id = inactFrom ? fmtDate(inactFrom) : '';
  function card(level, label, value, sub, tip) {
    return '<div class="mc ' + level + '"><div class="mc-l">' + label + '<span class="mc-hint" title="' + tip + '">ⓘ</span></div><div class="mc-v">' + value + '</div><div class="mc-s">' + sub + '</div></div>';
  }
  document.getElementById('lo-summary-cards').innerHTML =
    card('mc-total', 'Active Realtors', total,
      'realtors with leads from ' + fd + ' to ' + cd,
      'Realtors who shared at least 1 lead between ' + fd + ' and ' + cd) +
    card('mc-total', 'Inactive Realtors', inact,
      'active ' + id + ' → ' + fd + ', no leads after ' + fd,
      'Realtors inactive since ' + fd) +
    card('mc-breakdown', 'Hunting Realtors', h,
      Math.round(h / (total || 1) * 100) + '% of active · first lead after ' + fd,
      'Realtors whose first ever lead was within the selected window') +
    card('mc-breakdown', 'Farming Realtors', f,
      Math.round(f / (total || 1) * 100) + '% of active · first lead before ' + fd,
      'Realtors with history prior to the window') +
    card('mc-info', 'With Closing', clos,
      'realtors with Closed Won in period',
      'Active realtors with at least one Closed Won with disbursement date in window');
}

export function onLoModeSelect(val) {
  const isActive = val === 'active';
  const cfgActive = document.getElementById('lo-cfg-active-window');
  const cfgInact = document.getElementById('lo-cfg-inactive-from');
  if (cfgActive) { cfgActive.style.opacity = isActive ? '1' : '0.4'; cfgActive.style.pointerEvents = isActive ? 'auto' : 'none'; }
  if (cfgInact) { cfgInact.style.opacity = isActive ? '0.4' : '1'; cfgInact.style.pointerEvents = isActive ? 'none' : 'auto'; }
  if (state.loActiveResults.length > 0 || state.loInactiveResults.length > 0) setLoMode(val);
}

export function setLoMode(mode) {
  state.loCurrentMode = mode;
  document.getElementById('lo-filter-med').innerHTML = '<option value="">All Ratings</option>' +
    [...new Set(mode === 'active' ? state.loActiveResults.map(r => r.med) : ['Inactive'])].sort().map(m => '<option value="' + m + '">' + m + '</option>').join('');
  renderLoTable();
}

export function populateLoFilters(los) {
  const cleanLos = los.filter(o => o && o.trim() !== '');
  document.getElementById('lo-filter-own').innerHTML = '<option value="">All Loan Officers</option>' + cleanLos.map(o => '<option value="' + o + '">' + o + '</option>').join('');
  const branches = [...new Set([...state.loActiveResults, ...state.loInactiveResults].map(r => r.assignedBranch).filter(b => b && b.trim() !== ''))].sort();
  document.getElementById('lo-filter-branch').innerHTML = '<option value="">All Branches</option>' + branches.map(b => '<option value="' + b + '">' + b + '</option>').join('');
  document.getElementById('lo-assign-filter-owner').innerHTML = cleanLos.map(o => '<option value="' + o + '">' + o + '</option>').join('');
  document.getElementById('lo-assign-filter-branch').innerHTML = branches.map(b => '<option value="' + b + '">' + b + '</option>').join('');
}

export function renderLoTable() {
  const fm = Array.from(document.getElementById('lo-filter-med').selectedOptions).map(o => o.value).filter(Boolean);
  const fo = Array.from(document.getElementById('lo-filter-own').selectedOptions).map(o => o.value).filter(Boolean);
  const fb = Array.from(document.getElementById('lo-filter-branch').selectedOptions).map(o => o.value).filter(Boolean);
  const rows = (state.loCurrentMode === 'active' ? state.loActiveResults : state.loInactiveResults)
    .filter(r => matchesStrategy(r) && (!fm.length || fm.includes(r.med)) && (!fo.length || fo.includes(r.assignedOwner)) && (!fb.length || fb.includes(r.assignedBranch)));

  const filtActive = state.loActiveResults.filter(r => matchesStrategy(r) && (!fm.length || fm.includes(r.med)) && (!fo.length || fo.includes(r.assignedOwner)) && (!fb.length || fb.includes(r.assignedBranch)));
  const filtInactive = state.loInactiveResults.filter(r => matchesStrategy(r) && (!fo.length || fo.includes(r.assignedOwner)) && (!fb.length || fb.includes(r.assignedBranch)));
  const cutoffStr = document.getElementById('lo-cutoff-date').value;
  const windowDays = parseInt(document.getElementById('lo-window-days').value) || 60;
  const cutoff = new Date(cutoffStr + 'T23:59:59Z');
  const floorDate = new Date(cutoff); floorDate.setUTCDate(floorDate.getUTCDate() - windowDays); floorDate.setUTCHours(0, 0, 0, 0);
  const inactFrom = new Date(document.getElementById('lo-inactive-from').value + 'T00:00:00Z');
  renderLoSummary(windowDays, filtActive, filtInactive, cutoff, floorDate, inactFrom);

  rows.sort((a, b) => {
    let av = a[state.loSortCol], bv = b[state.loSortCol];
    if (av instanceof Date) av = av.getTime();
    if (bv instanceof Date) bv = bv.getTime();
    if (av == null) av = state.loSortDir > 0 ? Infinity : -Infinity;
    if (bv == null) bv = state.loSortDir > 0 ? Infinity : -Infinity;
    if (typeof av === 'string') return state.loSortDir * av.localeCompare(bv);
    return state.loSortDir * (av - bv);
  });

  const yy = '<span class="bool-y">&#10003;</span>';
  const nn = '<span class="bool-n">&#8211;</span>';
  const th = document.getElementById('lo-table-head');
  const tb = document.getElementById('lo-table-body');

  if (state.loCurrentMode === 'active') {
    const totCnt = rows.reduce((s, r) => s + r.cnt, 0);
    const totConverted = rows.reduce((s, r) => s + (r.convertedCount || 0), 0);
    const totPa = rows.reduce((s, r) => s + r.pa, 0);
    const totRat = rows.reduce((s, r) => s + r.rat, 0);
    const totCw = rows.reduce((s, r) => s + r.cw, 0);
    const totCurPa = rows.reduce((s, r) => s + r.curPa, 0);
    const totCurRat = rows.reduce((s, r) => s + r.curRat, 0);
    const totCurCw = rows.reduce((s, r) => s + r.curCw, 0);
    const tS = 'background:#0D2B5E;color:white;font-weight:700;font-size:10px;text-align:center;padding:7px 10px';
    const tL = 'background:#0D2B5E;color:white;font-weight:700;font-size:10px;padding:7px 10px;letter-spacing:.4px;text-transform:uppercase';
    const tE = 'background:#0D2B5E';
    th.innerHTML = [
      '<tr>',
      '<th class="sticky-col sticky-col-0 sticky-shadow" onclick="srtLo(\'name\')">Realtor &#8597;</th>',
      '<th class="sticky-col sticky-col-1" onclick="srtLo(\'assignedOwner\')">Loan Officer &#8597;</th>',
      '<th class="sticky-col sticky-col-2" onclick="srtLo(\'assignedBranch\')">Branch &#8597;</th>',
      '<th class="sticky-col sticky-col-3 sticky-shadow" style="min-width:170px">Rating</th>',
      '<th style="min-width:90px" onclick="srtLo(\'cnt\')" title="Total leads in the selected time window">Period Leads &#8597;</th>',
      '<th style="min-width:110px" onclick="srtLo(\'convertedCount\')" title="Leads marked as Converted within the selected window">Converted to Opp. &#8597;</th>',
      '<th style="min-width:80px" onclick="srtLo(\'firstDate\')">1st Lead &#8597;</th>',
      '<th style="min-width:90px" onclick="srtLo(\'penult\')" title="Date of the second most recent lead">Prior Lead Date &#8597;</th>',
      '<th style="min-width:110px" onclick="srtLo(\'pa\')" title="Leads that reached Pre-Approval in window">Leads w/ Pre-Appr &#8597;</th>',
      '<th style="min-width:110px" onclick="srtLo(\'rat\')" title="Leads that reached Ratified in window">Leads w/ Ratified &#8597;</th>',
      '<th style="min-width:120px" onclick="srtLo(\'cw\')" title="Leads closed (Closed Won) in window">Leads Closed Won &#8597;</th>',
      '<th style="min-width:120px;font-style:italic;background:#1a3a5c" onclick="srtLo(\'curPa\')" title="Opportunities currently in Pre-Approval">Curr. Pre-Approval &#8597;</th>',
      '<th style="min-width:120px;font-style:italic;background:#1a3a5c" onclick="srtLo(\'curRat\')" title="Opportunities currently in Ratified">Curr. Ratified &#8597;</th>',
      '<th style="min-width:120px;font-style:italic;background:#1a3a5c" onclick="srtLo(\'curCw\')" title="Opportunities currently in Closed Won">Curr. Closed Won &#8597;</th>',
      '</tr>',
      '<tr>',
      '<th style="' + tL + '">TOTAL</th>',
      '<th style="' + tE + '"></th>',
      '<th style="' + tE + '"></th>',
      '<th style="' + tE + '"></th>',
      '<th style="' + tS + '">' + totCnt + '</th>',
      '<th style="' + tS + '">' + totConverted + '</th>',
      '<th style="' + tE + '"></th>',
      '<th style="' + tE + '"></th>',
      '<th style="' + tS + '">' + totPa + '</th>',
      '<th style="' + tS + '">' + totRat + '</th>',
      '<th style="' + tS + '">' + totCw + '</th>',
      '<th style="' + tS + ';font-style:italic">' + totCurPa + '</th>',
      '<th style="' + tS + ';font-style:italic">' + totCurRat + '</th>',
      '<th style="' + tS + ';font-style:italic">' + totCurCw + '</th>',
      '</tr>'
    ].join('');

    tb.innerHTML = rows.map(r => {
      const k = encodeURIComponent(r.key);
      return [
        '<tr>',
        '<td class="sticky-col sticky-col-0 sticky-shadow" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;max-width:140px" title="' + r.name + '">' + r.name + (r.confirmed ? '<span style="color:#1D9E75;font-size:9px;margin-left:3px">&#10003;</span>' : '') + stratBadge(r) + '</td>',
        '<td class="sticky-col sticky-col-1"><span class="ot">' + (r.assignedOwner || '&#8211;') + '</span></td>',
        '<td class="sticky-col sticky-col-2"><span class="ot">' + (r.assignedBranch || '&#8211;') + '</span></td>',
        '<td class="sticky-col sticky-col-3 sticky-shadow"><span class="badge ' + (BADGE[r.med] || 'b-sin') + '">' + r.med + '</span></td>',
        '<td style="text-align:center"><span class="clickable-num" data-rkey="' + k + '" data-dtype="leads" title="View ' + r.cnt + ' period leads">' + r.cnt + '</span></td>',
        '<td style="text-align:center;font-weight:700">' + (r.convertedCount ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="converted" title="View converted leads">' + r.convertedCount + '</span>' : '&#8211;') + '</td>',
        '<td class="dt">' + fmtDate(r.firstDate) + '</td>',
        '<td class="dt">' + fmtDate(r.penult) + '</td>',
        '<td style="text-align:center;color:' + (r.pa ? '#185FA5' : '#CCD5E0') + '">' + (r.pa ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="pa" style="color:#185FA5">' + r.pa + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.rat ? '#3C3489' : '#CCD5E0') + '">' + (r.rat ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="rat" style="color:#3C3489">' + r.rat + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.cw ? '#085041' : '#CCD5E0') + ';font-weight:' + (r.cw ? '700' : '400') + '">' + (r.cw ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="cw" style="color:#085041">' + r.cw + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.curPa ? '#185FA5' : '#CCD5E0') + ';font-style:italic;background:rgba(230,241,251,0.45)">' + (r.curPa ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="curPa" style="color:#185FA5">' + r.curPa + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.curRat ? '#3C3489' : '#CCD5E0') + ';font-style:italic;background:rgba(238,237,254,0.45)">' + (r.curRat ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="curRat" style="color:#3C3489">' + r.curRat + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.curCw ? '#085041' : '#CCD5E0') + ';font-style:italic;font-weight:' + (r.curCw ? '700' : '400') + ';background:rgba(225,245,238,0.45)">' + (r.curCw ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="curCw" style="color:#085041">' + r.curCw + '</span>' : '&#8211;') + '</td>',
        '</tr>'
      ].join('');
    }).join('');

  } else {
    th.innerHTML = [
      '<tr>',
      '<th style="min-width:140px" onclick="srtLo(\'name\')">Realtor &#8597;</th>',
      '<th style="min-width:90px" onclick="srtLo(\'lastDate\')">Last Lead &#8597;</th>',
      '<th style="min-width:90px" onclick="srtLo(\'daysSinceLast\')">Inactive Days &#8597;</th>',
      '<th style="min-width:80px" onclick="srtLo(\'cnt\')">Period Leads &#8597;</th>',
      '<th style="min-width:80px" onclick="srtLo(\'firstDate\')">1st Lead &#8597;</th>',
      '<th style="min-width:100px" onclick="srtLo(\'cw\')">Closed Won &#8597;</th>',
      '<th style="min-width:90px" onclick="srtLo(\'pa\')">Pre-Appr &#8597;</th>',
      '<th style="min-width:80px" onclick="srtLo(\'rat\')">Ratified &#8597;</th>',
      '<th style="min-width:110px" onclick="srtLo(\'assignedOwner\')">Loan Officer &#8597;</th>',
      '<th style="min-width:90px" onclick="srtLo(\'assignedBranch\')">Branch &#8597;</th>',
      '<th>Status</th>',
      '</tr>'
    ].join('');

    tb.innerHTML = rows.map(r => [
      '<tr>',
      '<td style="font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis" title="' + r.name + '">' + r.name + stratBadge(r) + '</td>',
      '<td class="dt">' + fmtDate(r.lastDate) + '</td>',
      '<td style="text-align:center;font-weight:700;color:#B8960C">' + (r.daysSinceLast != null ? r.daysSinceLast + 'd' : '&#8211;') + '</td>',
      '<td style="text-align:center">' + (r.cnt || '&#8211;') + '</td>',
      '<td class="dt">' + fmtDate(r.firstDate) + '</td>',
      '<td style="text-align:center">' + (r.cw || '&#8211;') + '</td>',
      '<td style="text-align:center">' + (r.pa || '&#8211;') + '</td>',
      '<td style="text-align:center">' + (r.rat || '&#8211;') + '</td>',
      '<td><span class="ot">' + (r.assignedOwner || '&#8211;') + '</span></td>',
      '<td><span class="ot">' + (r.assignedBranch || '&#8211;') + '</span></td>',
      '<td><span class="badge b-inactive">Inactive</span></td>',
      '</tr>'
    ].join('')).join('');
  }
}

export function srtLo(col) {
  if (state.loSortCol === col) state.loSortDir *= -1;
  else { state.loSortCol = col; state.loSortDir = -1; }
  renderLoTable();
}

export function showLoTab(t) {
  const ts = ['med', 'sc', 'pipeline', 'perf', 'trends', 'assign'];
  document.querySelectorAll('.lo-tab').forEach((el, i) => el.classList.toggle('active', ts[i] === t));
  ts.forEach(id => document.getElementById('lo-tab-' + id).classList.toggle('hidden', id !== t));

  // Actualiza la pestaña activa en state y renderiza si está pendiente (lazy render)
  state.loCurrentTab = t;
  bus.emit('lo-tab:shown');
}
