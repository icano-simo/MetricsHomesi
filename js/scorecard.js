import { state } from './state.js';
import { initials } from './utils.js';
import { BADGE } from './config.js';
import { visibleOwners, isOwnerVisible } from './visibility.js';

export function renderScorecard(owners) {
  // Display-only: limita a los BDs visibles del usuario (no cambia el cálculo).
  owners = visibleOwners(owners);
  const cats = Object.keys(BADGE).filter(k => k !== 'Inactive');

  const medEl = document.getElementById('sc-filter-med');
  const ownEl = document.getElementById('sc-filter-own');
  const prevMeds = Array.from(medEl.selectedOptions).map(o => o.value);
  const prevOwns = Array.from(ownEl.selectedOptions).map(o => o.value);

  medEl.innerHTML = cats.map(c => '<option value="' + c + '">' + c + '</option>').join('');
  ownEl.innerHTML = owners.filter(o => o && o.trim() !== '').map(o => '<option value="' + o + '">' + o + '</option>').join('');

  Array.from(medEl.options).forEach(o => { if (prevMeds.includes(o.value)) o.selected = true; });
  Array.from(ownEl.options).forEach(o => { if (prevOwns.includes(o.value)) o.selected = true; });

  const scMeds = Array.from(medEl.selectedOptions).map(o => o.value).filter(Boolean);
  const scOwns = Array.from(ownEl.selectedOptions).map(o => o.value).filter(Boolean);

  // Filas gateadas por owner visible (robusto, además de la lista ya filtrada).
  const filtOwners = (scOwns.length ? owners.filter(o => scOwns.includes(o)) : owners).filter(o => isOwnerVisible(o));

  document.getElementById('scorecard-grid').innerHTML = filtOwners.map(owner => {
    const mine = state.activeResults.filter(r => r.assignedOwner === owner);
    if (!mine.length) return '';
    const rows = cats
      .filter(c => !scMeds.length || scMeds.includes(c))
      .map(c => {
        const n = mine.filter(r => r.med === c).length;
        return n ? '<div class="sc-row"><span class="sc-cat">' + c + '</span><span class="sc-num clickable-num" data-owner="' + owner + '" data-med="' + c + '" title="View realtors">' + n + '</span></div>' : '';
      }).join('');
    if (!rows) return '';
    return '<div class="sc-card">' +
      '<div class="sc-head">' +
        '<div class="sc-avatar">' + initials(owner) + '</div>' +
        '<span class="sc-name">' + owner + '</span>' +
        '<span class="sc-total">' + mine.length + '</span>' +
      '</div>' +
      '<div class="sc-body">' + rows + '</div>' +
    '</div>';
  }).join('');

  renderRankings(filtOwners);
}

export function renderRankings(owners) {
  const data = owners.map(owner => ({
    owner,
    huntingCount: state.activeResults.filter(r => r.assignedOwner === owner && r.med.startsWith('Hunting')).length,
    farmingCount: state.activeResults.filter(r => r.assignedOwner === owner && r.med.startsWith('Farming')).length,
    total: state.activeResults.filter(r => r.assignedOwner === owner).length
  })).filter(d => d.total > 0);

  if (!data.length) {
    document.getElementById('rankings-section').classList.add('hidden');
    return;
  }

  const bdCount = data.length;
  const avgHunting = Math.round(data.reduce((s, d) => s + d.huntingCount, 0) / bdCount);
  const avgFarming = Math.round(data.reduce((s, d) => s + d.farmingCount, 0) / bdCount);

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
              '<span class="ranking-name">' + d.owner + '</span>' +
              '<div class="ranking-bar-wrap"><div class="ranking-bar-fill ' + barClass + '" style="width:' + pct + '%"></div></div>' +
              '<span class="ranking-chip ' + cls + '">' + d[key] + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  renderCol('ranking-hunting', 'New Realtors', 'Hunting', 'huntingCount', avgHunting, 'hunting');
  renderCol('ranking-farming', 'Pre-Existing Relations', 'Farming', 'farmingCount', avgFarming, 'farming');
  document.getElementById('rankings-section').classList.remove('hidden');
}

export function refreshScorecard() {
  const owners = visibleOwners(document.getElementById('owners-list').value.split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== ''));
  renderScorecard(owners);
}

export function clearScorecardFilters() {
  Array.from(document.getElementById('sc-filter-med').options).forEach(o => o.selected = false);
  Array.from(document.getElementById('sc-filter-own').options).forEach(o => o.selected = false);
  refreshScorecard();
}
