import { state } from './state.js';
import { fmtDate } from './utils.js';
import { BADGE } from './config.js';

export function renderSummary(_w, filtActive, filtInactive, cutoffDate, floorDate, inactFrom) {
  const src = filtActive || state.activeResults;
  const srcInact = (filtInactive || state.inactiveResults).filter(r => r.assignedOwner && r.assignedOwner !== '');
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
  document.getElementById('summary-cards').innerHTML =
    card('mc-total', 'Active Realtors', total,
      'realtors with leads from ' + fd + ' to ' + cd,
      'Realtors who shared at least 1 lead between ' + fd + ' and ' + cd) +
    card('mc-total', 'Inactive Realtors', inact,
      'active ' + id + ' → ' + fd + ', no leads after ' + fd,
      'Realtors who were active between ' + id + ' and ' + fd + ' but have not shared any lead after ' + fd) +
    card('mc-breakdown', 'Hunting Realtors', h,
      Math.round(h / (total || 1) * 100) + '% of active · first lead after ' + fd,
      'Realtors whose first ever lead was shared within the selected window (' + fd + ' to ' + cd + '). New to the team pipeline.') +
    card('mc-breakdown', 'Farming Realtors', f,
      Math.round(f / (total || 1) * 100) + '% of active · first lead before ' + fd,
      'Realtors whose first lead was shared before ' + fd + '. Known realtors with existing history.') +
    card('mc-info', 'With Closing', clos,
      'realtors with Closed Won in period',
      'Active realtors with at least one Closed Won opportunity with disbursement date between ' + fd + ' and ' + cd);
}

export function onModeSelect(val) {
  const isActive = val === 'active';
  const cfgActive = document.getElementById('cfg-active-window');
  const cfgInact = document.getElementById('cfg-inactive-from');
  if (cfgActive) { cfgActive.style.opacity = isActive ? '1' : '0.4'; cfgActive.style.pointerEvents = isActive ? 'auto' : 'none'; }
  if (cfgInact) { cfgInact.style.opacity = isActive ? '0.4' : '1'; cfgInact.style.pointerEvents = isActive ? 'none' : 'auto'; }
  if (state.activeResults.length > 0 || state.inactiveResults.length > 0) setMode(val);
}

export function setMode(mode) {
  state.currentMode = mode;
  document.getElementById('filter-med').innerHTML = '<option value="">All Ratings</option>' +
    [...new Set(mode === 'active' ? state.activeResults.map(r => r.med) : ['Inactive'])].sort().map(m => '<option value="' + m + '">' + m + '</option>').join('');
  renderTable();
}

export function populateFilters(owners) {
  const cleanOwners = owners.filter(o => o && o.trim() !== '');
  document.getElementById('filter-own').innerHTML = '<option value="">All Owners</option>' + cleanOwners.map(o => '<option value="' + o + '">' + o + '</option>').join('');
  const branches = [...new Set([...state.activeResults, ...state.inactiveResults].map(r => r.assignedBranch).filter(b => b && b.trim() !== ''))].sort();
  document.getElementById('filter-branch').innerHTML = '<option value="">All Branches</option>' + branches.map(b => '<option value="' + b + '">' + b + '</option>').join('');
  document.getElementById('assign-filter-owner').innerHTML = cleanOwners.map(o => '<option value="' + o + '">' + o + '</option>').join('');
  document.getElementById('assign-filter-branch').innerHTML = branches.map(b => '<option value="' + b + '">' + b + '</option>').join('');
}

export function renderTable() {
  const fm = Array.from(document.getElementById('filter-med').selectedOptions).map(o => o.value).filter(Boolean);
  const fo = Array.from(document.getElementById('filter-own').selectedOptions).map(o => o.value).filter(Boolean);
  const fb = Array.from(document.getElementById('filter-branch').selectedOptions).map(o => o.value).filter(Boolean);
  const rows = (state.currentMode === 'active' ? state.activeResults : state.inactiveResults)
    .filter(r => (!fm.length || fm.includes(r.med)) && (!fo.length || fo.includes(r.assignedOwner)) && (!fb.length || fb.includes(r.assignedBranch)));

  const filtActive = state.activeResults.filter(r => (!fm.length || fm.includes(r.med)) && (!fo.length || fo.includes(r.assignedOwner)) && (!fb.length || fb.includes(r.assignedBranch)));
  const filtInactive = state.inactiveResults.filter(r => (!fo.length || fo.includes(r.assignedOwner)) && (!fb.length || fb.includes(r.assignedBranch)));
  const cutoffStr = document.getElementById('cutoff-date').value;
  const windowDays = parseInt(document.getElementById('window-days').value) || 60;
  const cutoff = new Date(cutoffStr + 'T23:59:59Z');
  const floorDate = new Date(cutoff);
  floorDate.setUTCDate(floorDate.getUTCDate() - windowDays);
  floorDate.setUTCHours(0, 0, 0, 0);
  const inactFrom = new Date(document.getElementById('inactive-from').value + 'T00:00:00Z');
  renderSummary(windowDays, filtActive, filtInactive, cutoff, floorDate, inactFrom);

  rows.sort((a, b) => {
    let av = a[state.sortCol], bv = b[state.sortCol];
    if (av instanceof Date) av = av.getTime();
    if (bv instanceof Date) bv = bv.getTime();
    if (av == null) av = state.sortDir > 0 ? Infinity : -Infinity;
    if (bv == null) bv = state.sortDir > 0 ? Infinity : -Infinity;
    if (typeof av === 'string') return state.sortDir * av.localeCompare(bv);
    return state.sortDir * (av - bv);
  });

  const yy = '<span class="bool-y">&#10003;</span>';
  const nn = '<span class="bool-n">&#8211;</span>';
  const th = document.getElementById('table-head');
  const tb = document.getElementById('table-body');

  if (state.currentMode === 'active') {
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
      '<th class="sticky-col sticky-col-0 sticky-shadow" onclick="srt(String.fromCharCode(110,97,109,101))">Realtor &#8597;</th>',
      '<th class="sticky-col sticky-col-1" onclick="srt(String.fromCharCode(97,115,115,105,103,110,101,100,79,119,110,101,114))">Owner &#8597;</th>',
      '<th class="sticky-col sticky-col-2" onclick="srt(String.fromCharCode(97,115,115,105,103,110,101,100,66,114,97,110,99,104))">Branch &#8597;</th>',
      '<th class="sticky-col sticky-col-3 sticky-shadow" style="min-width:170px">Rating</th>',
      '<th style="min-width:90px" onclick="srt(String.fromCharCode(99,110,116))" title="Total leads in the selected time window">Period Leads &#8597;</th>',
      '<th style="min-width:110px" onclick="srt(String.fromCharCode(99,111,110,118,101,114,116,101,100,67,111,117,110,116))" title="Leads marked as Converted within the selected window">Converted to Opp. &#8597;</th>',
      '<th style="min-width:80px" onclick="srt(String.fromCharCode(102,105,114,115,116,68,97,116,101))">1st Lead &#8597;</th>',
      '<th style="min-width:90px" onclick="srt(String.fromCharCode(112,101,110,117,108,116))" title="Date of the second most recent lead shared by this realtor — helps identify reactivation patterns">Prior Lead Date &#8597;</th>',
      '<th style="min-width:110px" onclick="srt(String.fromCharCode(112,97))" title="Leads that reached Pre-Approval in window (used in rating)">Leads w/ Pre-Appr &#8597;</th>',
      '<th style="min-width:110px" onclick="srt(String.fromCharCode(114,97,116))" title="Leads that reached Ratified in window (used in rating)">Leads w/ Ratified &#8597;</th>',
      '<th style="min-width:120px" onclick="srt(String.fromCharCode(99,119))" title="Leads closed (Closed Won) in window (used in rating)">Leads Closed Won &#8597;</th>',
      '<th style="min-width:120px;font-style:italic;background:#1a3a5c" onclick="srt(String.fromCharCode(99,117,114,80,97))" title="Opportunities currently in Pre-Approval (exclusive, excludes Closed Lost)">Curr. Pre-Approval &#8597;</th>',
      '<th style="min-width:120px;font-style:italic;background:#1a3a5c" onclick="srt(String.fromCharCode(99,117,114,82,97,116))" title="Opportunities currently in Ratified (exclusive)">Curr. Ratified &#8597;</th>',
      '<th style="min-width:120px;font-style:italic;background:#1a3a5c" onclick="srt(String.fromCharCode(99,117,114,67,119))" title="Opportunities currently in Closed Won (exclusive)">Curr. Closed Won &#8597;</th>',
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

    window._resultMap = window._resultMap || {};
    rows.forEach(r => { window._resultMap[r.key] = r; });

    tb.innerHTML = rows.map(r => {
      const k = encodeURIComponent(r.key);
      return [
        '<tr>',
        '<td class="sticky-col sticky-col-0 sticky-shadow" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;max-width:140px" title="' + r.name + '">' + r.name + (r.confirmed ? '<span style="color:#1D9E75;font-size:9px;margin-left:3px">&#10003;</span>' : '') + '</td>',
        '<td class="sticky-col sticky-col-1"><span class="ot">' + (r.assignedOwner || '&#8211;') + '</span></td>',
        '<td class="sticky-col sticky-col-2"><span class="ot">' + (r.assignedBranch || '&#8211;') + '</span></td>',
        '<td class="sticky-col sticky-col-3 sticky-shadow"><span class="badge ' + (BADGE[r.med] || 'b-sin') + '">' + r.med + '</span></td>',
        '<td style="text-align:center"><span class="clickable-num" data-rkey="' + k + '" data-dtype="leads" title="View ' + r.cnt + ' period leads">' + r.cnt + '</span></td>',
        '<td style="text-align:center;font-weight:700">' + (r.convertedCount ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="converted" title="View converted leads">' + r.convertedCount + '</span>' : '&#8211;') + '</td>',
        '<td class="dt">' + fmtDate(r.firstDate) + '</td>',
        '<td class="dt">' + fmtDate(r.penult) + '</td>',
        '<td style="text-align:center;color:' + (r.pa ? '#185FA5' : '#CCD5E0') + '">' + (r.pa ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="pa" style="color:#185FA5" title="View Pre-Approval detail">' + r.pa + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.rat ? '#3C3489' : '#CCD5E0') + '">' + (r.rat ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="rat" style="color:#3C3489" title="View Ratified detail">' + r.rat + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.cw ? '#085041' : '#CCD5E0') + ';font-weight:' + (r.cw ? '700' : '400') + '">' + (r.cw ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="cw" style="color:#085041" title="View Closed Won detail">' + r.cw + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.curPa ? '#185FA5' : '#CCD5E0') + ';font-style:italic;background:rgba(230,241,251,0.45)">' + (r.curPa ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="curPa" style="color:#185FA5" title="View curr. Pre-Appr opps">' + r.curPa + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.curRat ? '#3C3489' : '#CCD5E0') + ';font-style:italic;background:rgba(238,237,254,0.45)">' + (r.curRat ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="curRat" style="color:#3C3489" title="View curr. Ratified opps">' + r.curRat + '</span>' : '&#8211;') + '</td>',
        '<td style="text-align:center;color:' + (r.curCw ? '#085041' : '#CCD5E0') + ';font-style:italic;font-weight:' + (r.curCw ? '700' : '400') + ';background:rgba(225,245,238,0.45)">' + (r.curCw ? '<span class="clickable-num" data-rkey="' + k + '" data-dtype="curCw" style="color:#085041" title="View curr. Closed Won opps">' + r.curCw + '</span>' : '&#8211;') + '</td>',
        '</tr>'
      ].join('');
    }).join('');

  } else {
    th.innerHTML = [
      '<tr>',
      '<th style="min-width:140px" onclick="srt(String.fromCharCode(110,97,109,101))">Realtor &#8597;</th>',
      '<th style="min-width:90px" onclick="srt(String.fromCharCode(108,97,115,116,68,97,116,101))">Last Lead &#8597;</th>',
      '<th style="min-width:90px" onclick="srt(String.fromCharCode(100,97,121,115,83,105,110,99,101,76,97,115,116))">Inactive Days &#8597;</th>',
      '<th style="min-width:80px" onclick="srt(String.fromCharCode(99,110,116))">Period Leads &#8597;</th>',
      '<th style="min-width:80px" onclick="srt(String.fromCharCode(102,105,114,115,116,68,97,116,101))">1st Lead &#8597;</th>',
      '<th style="min-width:100px" onclick="srt(String.fromCharCode(99,119))">Closed Won &#8597;</th>',
      '<th style="min-width:90px" onclick="srt(String.fromCharCode(112,97))">Pre-Appr &#8597;</th>',
      '<th style="min-width:80px" onclick="srt(String.fromCharCode(114,97,116))">Ratified &#8597;</th>',
      '<th style="min-width:110px" onclick="srt(String.fromCharCode(97,115,115,105,103,110,101,100,79,119,110,101,114))">Owner &#8597;</th>',
      '<th style="min-width:90px" onclick="srt(String.fromCharCode(97,115,115,105,103,110,101,100,66,114,97,110,99,104))">Branch &#8597;</th>',
      '<th>Status</th>',
      '</tr>'
    ].join('');

    tb.innerHTML = rows.map(r => [
      '<tr>',
      '<td style="font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis" title="' + r.name + '">' + r.name + '</td>',
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

export function srt(col) {
  if (state.sortCol === col) state.sortDir *= -1;
  else { state.sortCol = col; state.sortDir = -1; }
  renderTable();
}

export function showTab(t) {
  const ts = ['med', 'sc', 'pipeline', 'perf', 'trends', 'assign'];
  document.querySelectorAll('.tab').forEach((el, i) => el.classList.toggle('active', ts[i] === t));
  ts.forEach(id => document.getElementById('tab-' + id).classList.toggle('hidden', id !== t));
}
