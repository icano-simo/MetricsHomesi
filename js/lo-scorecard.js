import { state } from './state.js';
import { initials, fmtDate } from './utils.js';
import { BADGE } from './config.js';
import { openModal } from './modal.js';
import { matchesStrategy } from './strategy.js';

function getAllowedLOs() {
  return document.getElementById('lo-list').value
    .split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== '');
}

export function showLoScorecardDetail(lo, med) {
  const rows = state.loActiveResults.filter(r => r.assignedOwner === lo && r.med === med && matchesStrategy(r));
  if (!rows.length) return;
  const cutoffStr = document.getElementById('lo-cutoff-date').value;
  const windowDays = parseInt(document.getElementById('lo-window-days').value) || 60;
  const cutoff = new Date(cutoffStr + 'T23:59:59Z');
  const floorDate = new Date(cutoff); floorDate.setUTCDate(floorDate.getUTCDate() - windowDays); floorDate.setUTCHours(0, 0, 0, 0);
  const head = '<tr>' +
    '<th>#</th><th>Realtor</th><th>Branch</th>' +
    '<th>Period Leads</th><th>Converted to Opp.</th>' +
    '<th>1st Lead</th><th>2nd to Last Lead</th>' +
    '<th>Leads w/ Pre-Appr</th><th>Leads w/ Ratified</th><th>Leads Closed Won</th>' +
    '<th>Curr. Pre-Approval</th><th>Curr. Ratified</th><th>Curr. Closed Won</th>' +
    '</tr>';
  const body = rows.map((r, i) =>
    '<tr>' +
    '<td style="color:#8899BB;font-size:10px">' + (i + 1) + '</td>' +
    '<td style="font-weight:600">' + r.name + '</td>' +
    '<td>' + (r.assignedBranch || '—') + '</td>' +
    '<td style="text-align:center"><span class="clickable-num" data-rkey="' + encodeURIComponent(r.key) + '" data-dtype="leads">' + r.cnt + '</span></td>' +
    '<td style="text-align:center;font-weight:700">' + (r.convertedCount ? '<span class="clickable-num" data-rkey="' + encodeURIComponent(r.key) + '" data-dtype="converted">' + r.convertedCount + '</span>' : '&#8211;') + '</td>' +
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
     'Leads w/ Pre-Appr', 'Leads w/ Ratified', 'Leads Closed Won', 'Curr. Pre-Approval', 'Curr. Ratified', 'Curr. Closed Won'],
    ...rows.map((r, i) => [i + 1, r.name, r.assignedBranch || '', r.cnt, r.convertedCount || 0,
      fmtDate(r.firstDate), fmtDate(r.penult), r.pa || 0, r.rat || 0, r.cw || 0, r.curPa || 0, r.curRat || 0, r.curCw || 0])
  ];
  openModal(
    lo + ' — ' + med,
    rows.length + ' realtor' + (rows.length !== 1 ? 's' : '') + ' · window: ' + fmtDate(floorDate) + ' → ' + fmtDate(cutoff),
    head, body, csvData
  );
}

export function renderLoScorecard(los) {
  const cats = Object.keys(BADGE).filter(k => k !== 'Inactive');
  const medEl = document.getElementById('lo-sc-filter-med');
  const ownEl = document.getElementById('lo-sc-filter-own');
  const prevMeds = Array.from(medEl.selectedOptions).map(o => o.value);
  const prevOwns = Array.from(ownEl.selectedOptions).map(o => o.value);
  medEl.innerHTML = cats.map(c => '<option value="' + c + '">' + c + '</option>').join('');
  ownEl.innerHTML = los.filter(o => o && o.trim() !== '').map(o => '<option value="' + o + '">' + o + '</option>').join('');
  Array.from(medEl.options).forEach(o => { if (prevMeds.includes(o.value)) o.selected = true; });
  Array.from(ownEl.options).forEach(o => { if (prevOwns.includes(o.value)) o.selected = true; });
  const scMeds = Array.from(medEl.selectedOptions).map(o => o.value).filter(Boolean);
  const scOwns = Array.from(ownEl.selectedOptions).map(o => o.value).filter(Boolean);
  const filtLos = scOwns.length ? los.filter(o => scOwns.includes(o)) : los;

  document.getElementById('lo-scorecard-grid').innerHTML = filtLos.map(lo => {
    const mine = state.loActiveResults.filter(r => r.assignedOwner === lo && matchesStrategy(r));
    if (!mine.length) return '';
    const rows = cats.filter(c => !scMeds.length || scMeds.includes(c)).map(c => {
      const n = mine.filter(r => r.med === c).length;
      return n ? '<div class="sc-row"><span class="sc-cat">' + c + '</span><span class="sc-num clickable-num" data-lo-owner="' + lo + '" data-lo-med="' + c + '" title="View realtors">' + n + '</span></div>' : '';
    }).join('');
    if (!rows) return '';
    return '<div class="sc-card">' +
      '<div class="sc-head">' +
        '<div class="sc-avatar">' + initials(lo) + '</div>' +
        '<span class="sc-name">' + lo + '</span>' +
        '<span class="sc-total">' + mine.length + '</span>' +
      '</div>' +
      '<div class="sc-body">' + rows + '</div>' +
    '</div>';
  }).join('');

  renderLoRankings(filtLos);
}

export function renderLoRankings(los) {
  const data = los.map(lo => ({
    lo,
    huntingCount: state.loActiveResults.filter(r => r.assignedOwner === lo && matchesStrategy(r) && r.med.startsWith('Hunting')).length,
    farmingCount: state.loActiveResults.filter(r => r.assignedOwner === lo && matchesStrategy(r) && r.med.startsWith('Farming')).length,
    total: state.loActiveResults.filter(r => r.assignedOwner === lo && matchesStrategy(r)).length
  })).filter(d => d.total > 0);

  if (!data.length) {
    document.getElementById('lo-rankings-section').classList.add('hidden');
    return;
  }

  const loCount = data.length;
  const avgHunting = Math.round(data.reduce((s, d) => s + d.huntingCount, 0) / loCount);
  const avgFarming = Math.round(data.reduce((s, d) => s + d.farmingCount, 0) / loCount);

  function semaforo(value, avg) {
    if (value > avg + 1) return 'above';
    if (value < avg - 1) return 'below';
    return 'avg';
  }

  function renderCol(elId, title, subtitle, key, avg, barClass) {
    const sorted = [...data].sort((a, b) => b[key] - a[key]);
    const max = sorted[0] ? sorted[0][key] : 1;
    document.getElementById(elId).innerHTML =
      '<div class="ranking-block">' +
        '<div class="ranking-block-header">' +
          '<span class="ranking-block-title">' + title + '</span>' +
          '<span class="ranking-block-subtitle">' + subtitle + '</span>' +
          '<span class="ranking-avg-chip">Team avg: ' + avg + ' realtors</span>' +
        '</div>' +
        '<div class="ranking-list">' +
          sorted.map(d => {
            const pct = max > 0 ? Math.round((d[key] / max) * 100) : 0;
            const cls = semaforo(d[key], avg);
            return '<div class="ranking-row">' +
              '<span class="ranking-name">' + d.lo + '</span>' +
              '<div class="ranking-bar-wrap"><div class="ranking-bar-fill ' + barClass + '" style="width:' + pct + '%"></div></div>' +
              '<span class="ranking-chip ' + cls + '">' + d[key] + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  renderCol('lo-ranking-hunting', 'New Realtors', 'Hunting', 'huntingCount', avgHunting, 'hunting');
  renderCol('lo-ranking-farming', 'Pre-Existing Relations', 'Farming', 'farmingCount', avgFarming, 'farming');
  document.getElementById('lo-rankings-section').classList.remove('hidden');
}

export function refreshLoScorecard() {
  const los = getAllowedLOs();
  renderLoScorecard(los);
}

export function clearLoScorecardFilters() {
  Array.from(document.getElementById('lo-sc-filter-med').options).forEach(o => o.selected = false);
  Array.from(document.getElementById('lo-sc-filter-own').options).forEach(o => o.selected = false);
  refreshLoScorecard();
}

// Event delegation for LO scorecard cell clicks
document.addEventListener('click', e => {
  const el = e.target.closest('[data-lo-owner][data-lo-med]');
  if (!el) return;
  showLoScorecardDetail(el.getAttribute('data-lo-owner'), el.getAttribute('data-lo-med'));
});
