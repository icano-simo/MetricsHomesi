import { state } from './state.js';
import { norm, fmtDate, parseDate, getField, fmtNow, initials, normalizeLO } from './utils.js';
import { BADGE } from './config.js';
import { sbFetch } from './supabase.js';
import { renderLoSummary } from './lo-ui.js';

function getAllowedLOs() {
  return document.getElementById('lo-list').value
    .split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== '');
}

function getLoAssignStatus(key) {
  const m = state.loMasterMap.get(key);
  if (!m || !m.loan_officer) return 'unassigned';
  if (m.confirmed === true || m.confirmed === 'true') return 'confirmed';
  return 'pending';
}

export function clearLoAssignFilters() {
  ['lo-assign-filter-owner', 'lo-assign-filter-branch', 'lo-assign-filter-med'].forEach(id => {
    const el = document.getElementById(id);
    if (el) Array.from(el.options).forEach(o => o.selected = false);
  });
  const status = document.getElementById('lo-assign-filter-status');
  if (status) status.value = '';
  renderLoAssignCards();
}

export function renderLoAssignCards() {
  const search = document.getElementById('lo-assign-search').value.toLowerCase();
  const filterStatus = document.getElementById('lo-assign-filter-status').value;
  const filterOwners = Array.from(document.getElementById('lo-assign-filter-owner').selectedOptions).map(o => o.value).filter(Boolean);
  const los = getAllowedLOs();
  const allResults = [...state.loActiveResults, ...state.loInactiveResults];

  const leadCountMap = new Map();
  for (const row of (state.leadsData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (ref) { const k = norm(String(ref)); leadCountMap.set(k, (leadCountMap.get(k) || 0) + 1); }
  }
  const oppCountMap = new Map();
  for (const row of (state.oppData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (ref) { const k = norm(String(ref)); oppCountMap.set(k, (oppCountMap.get(k) || 0) + 1); }
  }

  const branchEl = document.getElementById('lo-assign-filter-branch');
  const prevBranches = Array.from(branchEl.selectedOptions).map(o => o.value);
  const availBranches = [...new Set(allResults.map(r => r.assignedBranch).filter(b => b && b.trim() !== ''))].sort();
  branchEl.innerHTML = availBranches.map(b => '<option value="' + b + '"' + (prevBranches.includes(b) ? ' selected' : '') + '>' + b + '</option>').join('');
  const filterBranches = Array.from(branchEl.selectedOptions).map(o => o.value).filter(Boolean);

  const medEl = document.getElementById('lo-assign-filter-med');
  const prevMeds = Array.from(medEl.selectedOptions).map(o => o.value);
  const activeMeds = [...new Set(state.loActiveResults.map(r => r.med))].sort();
  const medOpts = [...activeMeds, ...(state.loInactiveResults.length ? ['Inactive'] : [])];
  medEl.innerHTML = medOpts.map(m => '<option value="' + m + '"' + (prevMeds.includes(m) ? ' selected' : '') + '>' + m + '</option>').join('');
  const filterMeds = Array.from(medEl.selectedOptions).map(o => o.value).filter(Boolean);

  let items = allResults.filter(r => {
    if (search && !r.name.toLowerCase().includes(search)) return false;
    const st = getLoAssignStatus(r.key);
    if (filterStatus === 'active' && r.med === 'Inactive') return false;
    if (filterStatus === 'inactive' && r.med !== 'Inactive') return false;
    if (['confirmed', 'pending', 'unassigned'].includes(filterStatus) && st !== filterStatus) return false;
    if (filterOwners.length && !filterOwners.includes(r.assignedOwner)) return false;
    if (filterBranches.length && !filterBranches.includes(r.assignedBranch)) return false;
    if (filterMeds.length && !filterMeds.includes(r.med)) return false;
    return true;
  });

  const total = allResults.length;
  const confirmed = allResults.filter(r => getLoAssignStatus(r.key) === 'confirmed').length;
  const pending = allResults.filter(r => getLoAssignStatus(r.key) === 'pending').length;
  const unassigned = allResults.filter(r => getLoAssignStatus(r.key) === 'unassigned').length;

  const loPendingBadge = document.getElementById('lo-pending-badge');
  if (loPendingBadge) loPendingBadge.textContent = pending + unassigned;
  const loUnasgnBadge = document.getElementById('lo-unassigned-count-badge');
  if (loUnasgnBadge) loUnasgnBadge.textContent = state.loUnassignedResults.length;

  document.getElementById('lo-assign-stats').innerHTML = [
    ['ti-users', 'Total', total],
    ['ti-circle-check', 'Confirmed', confirmed],
    ['ti-clock', 'Pending', pending],
    ['ti-alert-circle', 'No LO', state.loUnassignedResults.length],
  ].map(([ic, l, v]) => '<div class="astat"><i class="ti ' + ic + ' astat-icon"></i><div><div class="astat-val">' + v + '</div><div class="astat-lbl">' + l + '</div></div></div>').join('');

  const filtActive = state.loActiveResults.filter(r =>
    (!filterOwners.length || filterOwners.includes(r.assignedOwner)) &&
    (!filterBranches.length || filterBranches.includes(r.assignedBranch))
  );
  const filtInactive = state.loInactiveResults.filter(r =>
    (!filterOwners.length || filterOwners.includes(r.assignedOwner)) &&
    (!filterBranches.length || filterBranches.includes(r.assignedBranch))
  );
  const _co = document.getElementById('lo-cutoff-date').value;
  const _wd = parseInt(document.getElementById('lo-window-days').value) || 60;
  const _cutoff = new Date(_co + 'T23:59:59Z');
  const _floor = new Date(_cutoff); _floor.setUTCDate(_floor.getUTCDate() - _wd); _floor.setUTCHours(0, 0, 0, 0);
  const _inact = new Date(document.getElementById('lo-inactive-from').value + 'T00:00:00Z');
  renderLoSummary(_wd, filtActive, filtInactive, _cutoff, _floor, _inact);

  if (!items.length) {
    document.getElementById('lo-assign-cards').innerHTML = '<div class="empty-state" style="grid-column:1/-1">No realtors to display</div>';
    return;
  }

  items.sort((a, b) => {
    const order = { unassigned: 0, pending: 1, confirmed: 2 };
    return order[getLoAssignStatus(a.key)] - order[getLoAssignStatus(b.key)];
  });

  document.getElementById('lo-assign-cards').innerHTML = items.map(r => {
    const st = getLoAssignStatus(r.key);
    const m = state.loMasterMap.get(r.key) || { loan_officer: '', branch: '' };
    const loOpts = los.map(o => '<option value="' + o + '"' + (o === m.loan_officer ? ' selected' : '') + '>' + o + '</option>').join('');
    const statusChip = st === 'confirmed'
      ? '<span class="status-chip chip-confirmed"><i class="ti ti-circle-check"></i> Confirmed</span>'
      : st === 'pending'
        ? '<span class="status-chip chip-pending"><i class="ti ti-clock"></i> Pending</span>'
        : '<span class="status-chip chip-unassigned"><i class="ti ti-alert-circle"></i> No LO</span>';
    const confirmBtn = st === 'confirmed'
      ? '<button class="confirm-btn btn-confirmed" disabled><i class="ti ti-circle-check"></i> Confirmed</button><button class="confirm-btn btn-edit" onclick="unconfirmLo(\'' + r.key + '\')"><i class="ti ti-edit"></i> Edit</button>'
      : '<button class="confirm-btn btn-confirm" onclick="confirmLoAssign(\'' + r.key + '\')"><i class="ti ti-check"></i> Confirm</button>';
    const safeId = r.key.replace(/[^a-z0-9]/g, '_');
    return '<div class="acard ' + st + '" id="lo-acard-' + safeId + '">' +
      '<div class="acard-top">' +
        '<div class="acard-avatar">' + initials(r.name) + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="acard-name"><span class="clickable-num" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" onclick="showAllLeadsForRealtor(\'' + encodeURIComponent(r.key) + '\',\'' + (r.name || r.key).replace(/'/g, "\\'") + '\')" title="Ver todos los leads de este realtor">' + (r.name || r.key) + '</span></div>' +
          '<div class="acard-med"><span class="badge ' + (BADGE[r.med] || 'b-sin') + '" style="font-size:8px">' + r.med + '</span>' +
            (m.source === 'manual' ? '&nbsp;<span class="manual-assign-chip">&#9733; Manual</span>' : '') + '</div>' +
          '<div style="font-size:9px;color:#8899BB;margin-top:3px">&#128203; ' + (leadCountMap.get(r.key) || 0) + ' leads &middot; ' + (oppCountMap.get(r.key) || 0) + ' opps.</div>' +
        '</div>' +
        '<div class="acard-status">' + statusChip + '</div>' +
      '</div>' +
      '<div class="acard-fields">' +
        '<div class="afield"><label class="afield-label">Assigned Loan Officer</label>' +
          '<select id="lo-ao_' + safeId + '" onchange="updateLoAssign(\'' + r.key + '\',\'lo\',this.value)" ' + (st === 'confirmed' ? 'disabled' : '') + '>' + loOpts + '</select>' +
        '</div>' +
        '<div class="afield"><label class="afield-label">Branch</label>' +
          '<input type="text" id="lo-ab_' + safeId + '" value="' + (m.branch || '') + '" placeholder="Branch" onchange="updateLoAssign(\'' + r.key + '\',\'branch\',this.value)" ' + (st === 'confirmed' ? 'disabled' : '') + '/>' +
        '</div>' +
      '</div>' +
      '<div class="acard-actions">' + confirmBtn + '</div>' +
    '</div>';
  }).join('');
}

export function updateLoAssign(key, field, value) {
  const m = state.loMasterMap.get(key) || { name: key, loan_officer: '', branch: '', source: 'auto', updatedAt: fmtNow(), confirmed: false };
  if (field === 'lo') m.loan_officer = value;
  if (field === 'branch') m.branch = value;
  m.source = 'manual'; m.updatedAt = fmtNow(); m.confirmed = false;
  state.loMasterMap.set(key, m);
  for (const r of [...state.loActiveResults, ...state.loInactiveResults]) {
    if (r.key === key) { r.assignedOwner = m.loan_officer; r.assignedBranch = m.branch; }
  }
}

export function confirmLoAssign(key) {
  const m = state.loMasterMap.get(key) || { name: key, loan_officer: '', branch: '', source: 'manual', updatedAt: fmtNow(), confirmed: false };
  const safeKey = key.replace(/[^a-z0-9]/g, '_');
  const loEl = document.getElementById('lo-ao_' + safeKey);
  const branchEl = document.getElementById('lo-ab_' + safeKey);
  if (loEl) m.loan_officer = loEl.value;
  if (branchEl) m.branch = branchEl.value;
  m.confirmed = true; m.source = 'manual'; m.updatedAt = fmtNow();
  state.loMasterMap.set(key, m);
  sbFetch('lo_master_assignments?on_conflict=realtor_key', {
    method: 'POST',
    prefer: 'return=minimal,resolution=merge-duplicates',
    headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify([{ realtor_key: key, realtor_name: m.name || '', loan_officer: m.loan_officer || '', branch: m.branch || '', source: 'manual', updated_at: m.updatedAt, confirmed: true }])
  }).catch(() => {});
  for (const r of [...state.loActiveResults, ...state.loInactiveResults]) {
    if (r.key === key) { r.assignedOwner = m.loan_officer; r.assignedBranch = m.branch; r.confirmed = true; }
  }
  renderLoAssignCards();
}

export function unconfirmLo(key) {
  const m = state.loMasterMap.get(key);
  if (m) { m.confirmed = false; state.loMasterMap.set(key, m); }
  for (const r of [...state.loActiveResults, ...state.loInactiveResults]) { if (r.key === key) r.confirmed = false; }
  renderLoAssignCards();
}

export function renderLoUnassigned() {
  const container = document.getElementById('lo-unassigned-content');
  if (!container) return;
  const prevSearch = (document.getElementById('lo-ua-search') || {}).value || '';
  const los = getAllowedLOs();
  const allItems = state.loUnassignedResults;
  const badge = document.getElementById('lo-unassigned-count-badge');
  if (badge) badge.textContent = allItems.length;
  if (!allItems.length) {
    container.innerHTML = '<div class="empty-state" style="margin-top:16px">All realtors have a Loan Officer assigned.</div>';
    return;
  }
  const searchLc = prevSearch.toLowerCase();
  const items = allItems.filter(r => !searchLc || r.name.toLowerCase().includes(searchLc));
  const toolbar = '<div class="ua-toolbar">' +
    '<div class="ua-search-wrap"><i class="ti ti-search ua-search-icon"></i>' +
    '<input type="text" id="lo-ua-search" class="ua-search" placeholder="Search realtor…" value="' + prevSearch.replace(/"/g, '&quot;') + '" oninput="renderLoUnassigned()"></div>' +
    '<span class="ua-count">' + items.length + ' / ' + allItems.length + '</span></div>';
  const loOpts = '<option value="">— Select LO —</option>' + los.map(o => '<option value="' + o + '">' + o + '</option>').join('');
  const rows = items.map(r => {
    const safeId = r.key.replace(/[^a-z0-9]/g, '_');
    const statusChip = r.isActive
      ? '<span class="status-chip chip-confirmed" style="font-size:9px;padding:2px 7px">Active</span>'
      : '<span class="status-chip chip-unassigned" style="font-size:9px;padding:2px 7px">Inactive</span>';
    return '<tr>' +
      '<td style="font-weight:600;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + r.name + '">' + r.name + '</td>' +
      '<td>' + statusChip + '</td>' +
      '<td class="dt" style="white-space:nowrap">' + (r.lastDate ? fmtDate(r.lastDate) : '—') + '</td>' +
      '<td style="text-align:center;font-weight:700;color:var(--hs-navy)">' + r.allTimeCount + '</td>' +
      '<td style="font-size:11px;color:#667799;min-width:220px;white-space:normal">' + (r.leadOwnersSeen.join(', ') || '—') + '</td>' +
      '<td><select id="lo-uao_' + safeId + '" class="uassign-sel">' + loOpts + '</select></td>' +
      '<td><input type="text" id="lo-uab_' + safeId + '" class="uassign-inp" placeholder="Branch"/></td>' +
      '<td><button class="btn-sm btn-primary" onclick="saveLoUnassigned(\'' + r.key + '\')" style="font-size:10px;padding:4px 10px"><i class="ti ti-check"></i> Save</button></td>' +
    '</tr>';
  }).join('');
  container.innerHTML = toolbar +
    '<div class="unassigned-wrap"><table class="unassigned-table">' +
    '<thead><tr><th>Realtor</th><th>Status</th><th>Last Lead</th><th>All-time Leads</th><th>LOs Seen</th><th>Assign LO</th><th>Branch</th><th></th></tr></thead>' +
    '<tbody>' + (rows || '<tr><td colspan="8" style="text-align:center;padding:20px;color:#8899BB;font-size:12px">No realtors match.</td></tr>') + '</tbody>' +
    '</table></div>';
  if (prevSearch) {
    const searchEl = document.getElementById('lo-ua-search');
    if (searchEl) { searchEl.focus(); searchEl.setSelectionRange(searchEl.value.length, searchEl.value.length); }
  }
}

export function saveLoUnassigned(key) {
  const safeKey = key.replace(/[^a-z0-9]/g, '_');
  const loEl = document.getElementById('lo-uao_' + safeKey);
  const branchEl = document.getElementById('lo-uab_' + safeKey);
  const lo = (loEl && loEl.value) ? loEl.value : '';
  const branch = branchEl ? (branchEl.value || '') : '';
  if (!lo) return;
  const uEntry = state.loUnassignedResults.find(r => r.key === key);
  state.loUnassignedResults = state.loUnassignedResults.filter(r => r.key !== key);
  const now = fmtNow();
  const name = (uEntry && uEntry.name) || key;
  state.loMasterMap.set(key, { name, loan_officer: lo, branch, source: 'manual', updatedAt: now, confirmed: true });
  sbFetch('lo_master_assignments?on_conflict=realtor_key', {
    method: 'POST',
    prefer: 'return=minimal,resolution=merge-duplicates',
    headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify([{ realtor_key: key, realtor_name: name, loan_officer: lo, branch, source: 'manual', updated_at: now, confirmed: true }])
  }).catch(() => {});
  renderLoUnassigned();
  renderLoAssignCards();
}

export function showLoAssignView(view) {
  const avAssigned   = document.getElementById('lo-assign-view-assigned');
  const avUnassigned = document.getElementById('lo-assign-view-unassigned');
  const btnA = document.getElementById('lo-assign-tab-assigned');
  const btnU = document.getElementById('lo-assign-tab-unassigned');
  if (!avAssigned) return;
  if (view === 'unassigned') {
    avAssigned.classList.add('hidden');
    avUnassigned.classList.remove('hidden');
    if (btnA) btnA.classList.remove('active');
    if (btnU) btnU.classList.add('active');
    renderLoUnassigned();
  } else {
    avAssigned.classList.remove('hidden');
    avUnassigned.classList.add('hidden');
    if (btnA) btnA.classList.add('active');
    if (btnU) btnU.classList.remove('active');
  }
}

export async function saveAllLoAssignments() {
  const st = document.getElementById('lo-assign-save-status');
  if (st) st.textContent = 'Saving...';
  try {
    const rows = [...state.loMasterMap.entries()].map(([key, m]) => ({
      realtor_key: key, realtor_name: m.name || '', loan_officer: m.loan_officer || '',
      branch: m.branch || '', source: m.source || 'auto', updated_at: m.updatedAt || '',
      confirmed: m.confirmed || false
    }));
    await sbFetch('lo_master_assignments?on_conflict=realtor_key', {
      method: 'POST',
      prefer: 'return=minimal,resolution=merge-duplicates',
      headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify(rows)
    });
    if (st) st.textContent = '✅ Saved ' + fmtNow();
  } catch (e) { if (st) st.textContent = '⚠ Error: ' + e.message; }
}
