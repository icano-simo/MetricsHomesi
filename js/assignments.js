import { state } from './state.js';
import { norm, fmtDate, fmtDB, parseDate, getField, fmtNow, initials } from './utils.js';
import { BADGE } from './config.js';
import { sbFetch } from './supabase.js';
import { renderSummary } from './ui.js';
import { renderLog } from './log.js';

export function loadSfReference(inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  const statusEl = document.getElementById('sf-ref-status');
  if (statusEl) statusEl.textContent = 'Reading…';
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const wb = XLSX.read(ev.target.result, { type: 'binary', cellDates: false });
      const sn = wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: null });
      console.log('[upload realtor map] sample row:', JSON.stringify(rows[0]));
      // Deduplicate by realtor_key — last occurrence wins
      const dedupMap = new Map();
      for (const row of rows) {
        const name = getField(row, 'Opportunity Name', 'opportunity name', 'Opp Name', 'opp name', 'Realtor', 'realtor', 'Name', 'name');
        const owner = getField(row, 'Opportunity Owner', 'opportunity owner', 'Opp Owner', 'opp owner', 'Owner', 'owner', 'BD', 'bd');
        if (name && owner) {
          const key = norm(String(name));
          dedupMap.set(key, {
            realtor_key: key, realtor_name: String(name).trim(), owner: String(owner).trim(),
            meeting_attended_date: fmtDB(parseDate(getField(row, 'Meeting Attended Date', 'meeting attended date'))) || null,
            invite_sent_date: fmtDB(parseDate(getField(row, 'Invite Sent Date', 'invite sent date'))) || null,
            nppm: getField(row, 'NPPM', 'nppm') === true || String(getField(row, 'NPPM', 'nppm')).toLowerCase() === 'true',
            last_referral_date: fmtDB(parseDate(getField(row, 'Realtor Last Referral Date', 'realtor last referral date'))) || null,
            branch: String(getField(row, 'Branch', 'branch') || '').trim() || null,
            loan_officers: String(getField(row, 'Loan Officers', 'loan officers', 'Loan Officer', 'loan officer') || '').trim() || null
          });
        }
      }
      state.realtorOwnerMap = new Map([...dedupMap.entries()].map(([k, r]) => [k, { owner: r.owner, name: r.realtor_name, meeting_attended_date: r.meeting_attended_date, invite_sent_date: r.invite_sent_date, nppm: r.nppm, last_referral_date: r.last_referral_date }]));
      const dbRows = [...dedupMap.values()];
      // Refresh table immediately so SF Suggestion column appears right away
      renderUnassigned();
      if (statusEl) statusEl.textContent = '⏳ Saving ' + dbRows.length + ' records to Supabase…';
      // Save to Supabase — handled separately so a network error doesn't hide the column
      try {
        const batchSize = 200;
        for (let i = 0; i < dbRows.length; i += batchSize) {
          await sbFetch('realtor_owner_map?on_conflict=realtor_key', {
            method: 'POST',
            prefer: 'return=minimal,resolution=merge-duplicates',
            headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
            body: JSON.stringify(dbRows.slice(i, i + batchSize))
          });
        }
        // Save metadata to upload_meta (same pattern as leads/opp uploads)
        try {
          await sbFetch('upload_meta?file_type=eq.realtor_map', { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } });
          await sbFetch('upload_meta', { method: 'POST', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ file_type: 'realtor_map', file_name: file.name, row_count: state.realtorOwnerMap.size }) });
        } catch (_) { /* non-critical */ }
        // Persistent success — never cleared
        const today = fmtDate(new Date());
        if (statusEl) statusEl.innerHTML =
          '<span style="color:#1A9E5A;font-weight:700">Uploaded ✓</span>' +
          ' &nbsp;' + file.name + ' &nbsp;·&nbsp; ' + state.realtorOwnerMap.size + ' rows &nbsp;·&nbsp; ' + today;
      } catch (e) {
        if (statusEl) statusEl.textContent = '⚠ Saved in memory but Supabase error: ' + e.message;
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = '⚠ Error reading file: ' + e.message;
    }
  };
  reader.readAsBinaryString(file);
}

export function applyUaSuggestion(safeId, owner) {
  const el = document.getElementById('uao_' + safeId);
  if (el) el.value = owner;
}

export function clearAssignFilters() {
  ['assign-filter-owner', 'assign-filter-branch', 'assign-filter-med'].forEach(id => {
    const el = document.getElementById(id);
    if (el) Array.from(el.options).forEach(o => o.selected = false);
  });
  const status = document.getElementById('assign-filter-status');
  if (status) status.value = '';
  renderAssignCards();
}

function getAssignStatus(key) {
  const m = state.masterMap.get(key);
  if (!m || !m.owner) return 'unassigned';
  if (m.confirmed === true || m.confirmed === 'true') return 'confirmed';
  return 'pending';
}

export function renderAssignCards() {
  const search = document.getElementById('assign-search').value.toLowerCase();
  const filterStatus = document.getElementById('assign-filter-status').value;
  const filterOwners = Array.from(document.getElementById('assign-filter-owner').selectedOptions).map(o => o.value).filter(Boolean);
  const owners = document.getElementById('owners-list').value.split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== '');
  const allResults = [...state.activeResults, ...state.inactiveResults];

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

  const branchEl = document.getElementById('assign-filter-branch');
  const prevBranches = Array.from(branchEl.selectedOptions).map(o => o.value);
  const availBranches = [...new Set(allResults.map(r => r.assignedBranch).filter(b => b && b.trim() !== ''))].sort();
  branchEl.innerHTML = availBranches.map(b => '<option value="' + b + '"' + (prevBranches.includes(b) ? ' selected' : '') + '>' + b + '</option>').join('');
  const filterBranches = Array.from(branchEl.selectedOptions).map(o => o.value).filter(Boolean);

  const medEl = document.getElementById('assign-filter-med');
  const prevMeds = Array.from(medEl.selectedOptions).map(o => o.value);
  const activeMeds = [...new Set(state.activeResults.map(r => r.med))].sort();
  const medOpts = [...activeMeds, ...(state.inactiveResults.length ? ['Inactive'] : [])];
  medEl.innerHTML = medOpts.map(m => '<option value="' + m + '"' + (prevMeds.includes(m) ? ' selected' : '') + '>' + m + '</option>').join('');
  const filterMeds = Array.from(medEl.selectedOptions).map(o => o.value).filter(Boolean);

  let items = allResults.filter(r => {
    if (search && !r.name.toLowerCase().includes(search)) return false;
    const st = getAssignStatus(r.key);
    if (filterStatus === 'active' && r.med === 'Inactive') return false;
    if (filterStatus === 'inactive' && r.med !== 'Inactive') return false;
    if (['confirmed', 'pending', 'unassigned'].includes(filterStatus) && st !== filterStatus) return false;
    if (filterOwners.length && !filterOwners.includes(r.assignedOwner)) return false;
    if (filterBranches.length && !filterBranches.includes(r.assignedBranch)) return false;
    if (filterMeds.length && !filterMeds.includes(r.med)) return false;
    return true;
  });

  const total = allResults.length;
  const confirmed = allResults.filter(r => getAssignStatus(r.key) === 'confirmed').length;
  const pending = allResults.filter(r => getAssignStatus(r.key) === 'pending').length;
  const unassigned = allResults.filter(r => getAssignStatus(r.key) === 'unassigned').length;
  document.getElementById('pending-badge').textContent = pending + unassigned;
  const unasgnBadge = document.getElementById('unassigned-count-badge');
  if (unasgnBadge) unasgnBadge.textContent = state.unassignedResults.length;
  document.getElementById('assign-stats').innerHTML = [
    ['ti-users', 'Total', total, ''],
    ['ti-circle-check', 'Confirmed', confirmed, 'chip-confirmed'],
    ['ti-clock', 'Pending', pending, 'chip-pending'],
    ['ti-alert-circle', 'No Owner', state.unassignedResults.length, 'chip-unassigned'],
  ].map(([ic, l, v]) => '<div class="astat"><i class="ti ' + ic + ' astat-icon"></i><div><div class="astat-val">' + v + '</div><div class="astat-lbl">' + l + '</div></div></div>').join('');

  const filtActive = state.activeResults.filter(r =>
    (!filterOwners.length || filterOwners.includes(r.assignedOwner)) &&
    (!filterBranches.length || filterBranches.includes(r.assignedBranch))
  );
  const filtInactive = state.inactiveResults.filter(r =>
    (!filterOwners.length || filterOwners.includes(r.assignedOwner)) &&
    (!filterBranches.length || filterBranches.includes(r.assignedBranch))
  );
  const _co = document.getElementById('cutoff-date').value;
  const _wd = parseInt(document.getElementById('window-days').value) || 60;
  const _cutoff = new Date(_co + 'T23:59:59Z');
  const _floor = new Date(_cutoff); _floor.setUTCDate(_floor.getUTCDate() - _wd); _floor.setUTCHours(0, 0, 0, 0);
  const _inact = new Date(document.getElementById('inactive-from').value + 'T00:00:00Z');
  renderSummary(_wd, filtActive, filtInactive, _cutoff, _floor, _inact);

  if (!items.length) {
    document.getElementById('assign-cards').innerHTML = '<div class="empty-state" style="grid-column:1/-1">No realtors to display</div>';
    return;
  }

  items.sort((a, b) => {
    const order = { unassigned: 0, pending: 1, confirmed: 2 };
    return order[getAssignStatus(a.key)] - order[getAssignStatus(b.key)];
  });

  document.getElementById('assign-cards').innerHTML = items.map(r => {
    const st = getAssignStatus(r.key);
    const m = state.masterMap.get(r.key) || { owner: '', branch: '' };
    const ownerOpts = owners.map(o => '<option value="' + o + '"' + (o === m.owner ? ' selected' : '') + '>' + o + '</option>').join('');
    const statusChip = st === 'confirmed'
      ? '<span class="status-chip chip-confirmed"><i class="ti ti-circle-check"></i> Confirmed</span>'
      : st === 'pending'
        ? '<span class="status-chip chip-pending"><i class="ti ti-clock"></i> Pending</span>'
        : '<span class="status-chip chip-unassigned"><i class="ti ti-alert-circle"></i> No Owner</span>';
    const confirmBtn = st === 'confirmed'
      ? '<button class="confirm-btn btn-confirmed" disabled><i class="ti ti-circle-check"></i> Confirmed</button><button class="confirm-btn btn-edit" onclick="unconfirm(\'' + r.key + '\')"><i class="ti ti-edit"></i> Edit</button>'
      : '<button class="confirm-btn btn-confirm" onclick="confirmAssign(\'' + r.key + '\')"><i class="ti ti-check"></i> Confirm</button>';
    const safeId = r.key.replace(/[^a-z0-9]/g, '_');
    return '<div class="acard ' + st + '" id="acard-' + safeId + '">' +
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
        '<div class="afield"><label class="afield-label">Assigned Owner</label>' +
          '<select id="ao_' + safeId + '" onchange="updateAssign(\'' + r.key + '\',\'owner\',this.value)" ' + (st === 'confirmed' ? 'disabled' : '') + '>' + ownerOpts + '</select>' +
        '</div>' +
        '<div class="afield"><label class="afield-label">Branch</label>' +
          '<input type="text" id="ab_' + safeId + '" value="' + (m.branch || '') + '" placeholder="Branch" onchange="updateAssign(\'' + r.key + '\',\'branch\',this.value)" ' + (st === 'confirmed' ? 'disabled' : '') + '/>' +
        '</div>' +
      '</div>' +
      '<div class="acard-actions">' + confirmBtn + '</div>' +
    '</div>';
  }).join('');
}

export function updateAssign(key, field, value) {
  const m = state.masterMap.get(key) || { name: key, owner: '', branch: '', source: 'auto', updatedAt: fmtNow(), confirmed: false };
  if (field === 'owner') m.owner = value;
  if (field === 'branch') m.branch = value;
  m.source = 'manual'; m.updatedAt = fmtNow(); m.confirmed = false;
  state.masterMap.set(key, m);
  for (const r of [...state.activeResults, ...state.inactiveResults]) {
    if (r.key === key) { r.assignedOwner = m.owner; r.assignedBranch = m.branch; }
  }
}

export function confirmAssign(key) {
  const m = state.masterMap.get(key) || { name: key, owner: '', branch: '', source: 'manual', updatedAt: fmtNow(), confirmed: false };
  const safeKey = key.replace(/[^a-z0-9]/g, '_');
  const ownerEl = document.getElementById('ao_' + safeKey);
  const branchEl = document.getElementById('ab_' + safeKey);
  if (ownerEl) m.owner = ownerEl.value;
  if (branchEl) m.branch = branchEl.value;
  const old = state.masterMap.get(key) || {};
  if (old.owner !== m.owner || old.branch !== m.branch) {
    const entry = { date: fmtNow(), realtor: m.name || key, from: (old.owner || '–') + ' / ' + (old.branch || '–'), to: m.owner + ' / ' + m.branch };
    state.changeLog.unshift(entry);
    sbFetch('change_log', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ change_date: entry.date, realtor: entry.realtor, from_assignment: entry.from, to_assignment: entry.to }) }).catch(() => {});
  }
  m.confirmed = true; m.source = 'manual'; m.updatedAt = fmtNow();
  state.masterMap.set(key, m);
  sbFetch('master_assignments?on_conflict=realtor_key', {
    method: 'POST',
    prefer: 'return=minimal,resolution=merge-duplicates',
    headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify([{ realtor_key: key, realtor_name: m.name || '', owner: m.owner || '', branch: m.branch || '', source: 'manual', updated_at: m.updatedAt, confirmed: true }])
  }).catch(() => {});
  for (const r of [...state.activeResults, ...state.inactiveResults]) {
    if (r.key === key) { r.assignedOwner = m.owner; r.assignedBranch = m.branch; r.confirmed = true; }
  }
  renderAssignCards();
  renderLog();
}

export function unconfirm(key) {
  const m = state.masterMap.get(key);
  if (m) { m.confirmed = false; state.masterMap.set(key, m); }
  for (const r of [...state.activeResults, ...state.inactiveResults]) { if (r.key === key) r.confirmed = false; }
  renderAssignCards();
}

export function renderUnassigned() {
  const container = document.getElementById('unassigned-content');
  if (!container) return;

  // Preserve filter state across re-renders
  const prevSearch = (document.getElementById('ua-search') || {}).value || '';
  const prevSfFilter = (document.getElementById('ua-sf-filter') || {}).value || 'all';

  const owners = document.getElementById('owners-list').value
    .split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== '');

  const sfColVisible = state.realtorOwnerMap.size > 0;
  const allItems = state.unassignedResults;

  const badge = document.getElementById('unassigned-count-badge');
  if (badge) badge.textContent = allItems.length;

  if (!allItems.length) {
    container.innerHTML = '<div class="empty-state" style="margin-top:16px">All realtors have an owner assigned.</div>';
    return;
  }

  // Apply filters
  const searchLc = prevSearch.toLowerCase();
  const items = allItems.filter(r => {
    if (searchLc && !r.name.toLowerCase().includes(searchLc)) return false;
    if (sfColVisible && prevSfFilter !== 'all') {
      const hasSuggestion = state.realtorOwnerMap.has(norm(r.name));
      if (prevSfFilter === 'with' && !hasSuggestion) return false;
      if (prevSfFilter === 'without' && hasSuggestion) return false;
    }
    return true;
  });

  const sfFilterOpts = sfColVisible
    ? '<select id="ua-sf-filter" class="ua-sf-filter" onchange="renderUnassigned()" title="Filter by SF Suggestion">' +
        '<option value="all"' + (prevSfFilter === 'all' ? ' selected' : '') + '>All realtors</option>' +
        '<option value="with"' + (prevSfFilter === 'with' ? ' selected' : '') + '>With SF Suggestion</option>' +
        '<option value="without"' + (prevSfFilter === 'without' ? ' selected' : '') + '>Without SF Suggestion</option>' +
      '</select>'
    : '';

  const toolbar =
    '<div class="ua-toolbar">' +
      '<div class="ua-search-wrap">' +
        '<i class="ti ti-search ua-search-icon"></i>' +
        '<input type="text" id="ua-search" class="ua-search" placeholder="Search realtor…"' +
          ' value="' + prevSearch.replace(/"/g, '&quot;') + '" oninput="renderUnassigned()">' +
      '</div>' +
      sfFilterOpts +
      '<span class="ua-count">' + items.length + ' / ' + allItems.length + '</span>' +
    '</div>';

  const ownerOpts = '<option value="">— Select Owner —</option>' +
    owners.map(o => '<option value="' + o + '">' + o + '</option>').join('');

  const rows = items.map(r => {
    const safeId = r.key.replace(/[^a-z0-9]/g, '_');
    const statusChip = r.isActive
      ? '<span class="status-chip chip-confirmed" style="font-size:9px;padding:2px 7px">Active</span>'
      : '<span class="status-chip chip-unassigned" style="font-size:9px;padding:2px 7px">Inactive</span>';
    const topOwners = r.leadOwnersSeen.join(', ') || '—';

    let sfCell = '';
    if (sfColVisible) {
      const _sug = state.realtorOwnerMap.get(norm(r.name));
      const suggestion = (_sug && typeof _sug === 'object') ? _sug.owner : _sug;
      if (!suggestion) {
        sfCell = '<td style="color:#AAB4CC;font-size:11px;text-align:center">—</td>';
      } else if (owners.includes(suggestion)) {
        const safeOwner = suggestion.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        sfCell = '<td><span class="sf-suggest-chip" title="Salesforce suggests this BD as owner. Click to apply or ignore." onclick="applyUaSuggestion(\'' + safeId + '\',\'' + safeOwner + '\')">✦ ' + suggestion + '</span></td>';
      } else {
        sfCell = '<td style="color:#AAB4CC;font-size:11px">' + suggestion + ' <span style="font-size:10px">(not in group)</span></td>';
      }
    }

    return '<tr>' +
      '<td style="font-weight:600;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + r.name + '">' + r.name + '</td>' +
      '<td>' + statusChip + '</td>' +
      '<td class="dt" style="white-space:nowrap">' + (r.lastDate ? fmtDate(r.lastDate) : '—') + '</td>' +
      '<td style="text-align:center;font-weight:700;color:var(--hs-navy)">' + r.allTimeCount + '</td>' +
      '<td style="font-size:11px;color:#667799;min-width:220px;white-space:normal">' + topOwners + '</td>' +
      sfCell +
      '<td><select id="uao_' + safeId + '" class="uassign-sel">' + ownerOpts + '</select></td>' +
      '<td><input type="text" id="uab_' + safeId + '" class="uassign-inp" placeholder="Branch"/></td>' +
      '<td><button class="btn-sm btn-primary" onclick="saveUnassigned(\'' + r.key + '\')" style="font-size:10px;padding:4px 10px"><i class="ti ti-check"></i> Save</button></td>' +
    '</tr>';
  }).join('');

  const emptyRow = items.length === 0
    ? '<tr><td colspan="' + (sfColVisible ? 9 : 8) + '" style="text-align:center;padding:20px;color:#8899BB;font-size:12px">No realtors match the current filter.</td></tr>'
    : '';

  container.innerHTML =
    toolbar +
    '<div class="unassigned-wrap">' +
      '<table class="unassigned-table">' +
        '<thead><tr>' +
          '<th>Realtor</th><th>Status</th><th>Last Lead</th><th>All-time Leads</th>' +
          '<th>Lead Owners Seen</th>' +
          (sfColVisible ? '<th>SF Suggestion</th>' : '') +
          '<th>Assign Owner</th><th>Assign Branch</th><th></th>' +
        '</tr></thead>' +
        '<tbody>' + (rows || emptyRow) + '</tbody>' +
      '</table>' +
    '</div>';

  // Restore focus on search if the user was typing
  if (prevSearch) {
    const searchEl = document.getElementById('ua-search');
    if (searchEl) { searchEl.focus(); searchEl.setSelectionRange(searchEl.value.length, searchEl.value.length); }
  }
}

function _computeResultFields(key, uEntry) {
  const cutoffStr = document.getElementById('cutoff-date').value;
  const windowDays = parseInt(document.getElementById('window-days').value) || 60;
  const reactDays = parseInt(document.getElementById('react-days').value) || 150;
  const cutoff = new Date(cutoffStr + 'T23:59:59Z');
  const floorDate = new Date(cutoff); floorDate.setUTCDate(floorDate.getUTCDate() - windowDays);
  const reactThreshold = new Date(cutoff); reactThreshold.setUTCDate(reactThreshold.getUTCDate() - reactDays);

  const allDates = [], recentDates = [], leadRows = [];
  let convertedCount = 0;
  for (const row of (state.leadsData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (!ref || norm(String(ref).trim()) !== key) continue;
    const cd = parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'));
    if (cd) {
      allDates.push(cd);
      if (cd >= floorDate && cd <= cutoff) {
        recentDates.push(cd);
        leadRows.push(row);
        const conv = getField(row, 'Converted', 'converted');
        if (conv === true || String(conv).trim().toLowerCase() === 'true') convertedCount++;
      }
    }
  }

  const uniqueDays = [], seenD = new Set();
  for (const d of [...allDates].sort((a, b) => a - b)) {
    const dk = d.toISOString().slice(0, 10);
    if (!seenD.has(dk)) { seenD.add(dk); uniqueDays.push(d); }
  }
  const firstDate = uniqueDays[0] || uEntry.firstDate;
  const lastDate = uniqueDays[uniqueDays.length - 1] || uEntry.lastDate;
  const penult = uniqueDays.length >= 2 ? uniqueDays[uniqueDays.length - 2] : null;
  const cnt = recentDates.length;

  let cw = 0, pa = 0, rat = 0, curCw = 0, curRat = 0, curPa = 0;
  const oppRows = [];
  for (const row of (state.oppData || [])) {
    const ref = getField(row, 'Referred By', 'referred by');
    if (!ref || norm(String(ref).trim()) !== key) continue;
    oppRows.push(row);
    const stage = String(getField(row, 'Stage', 'stage') || '').trim().toLowerCase();
    const disbDate = parseDate(getField(row, 'Disbursement Date', 'disbursement date'));
    const paDate = parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date'));
    const ratDate = parseDate(getField(row, 'Ratified Date', 'ratified date'));
    if (stage !== 'closed lost') {
      if (stage === 'closed won' && disbDate && disbDate >= floorDate && disbDate <= cutoff) cw++;
    }
    if (paDate && paDate >= floorDate && paDate <= cutoff) pa++;
    if (ratDate && ratDate >= floorDate && ratDate <= cutoff) rat++;
    if (stage === 'closed lost') continue;
    const isCW = stage === 'closed won' && disbDate && disbDate >= floorDate && disbDate <= cutoff;
    const isRat = !isCW && ratDate && ratDate >= floorDate && ratDate <= cutoff;
    const isPA = !isCW && !isRat && paDate && paDate >= floorDate && paDate <= cutoff;
    if (isCW) curCw++;
    else if (isRat) curRat++;
    else if (isPA) curPa++;
  }

  const c1 = cnt > 0;
  const c2 = firstDate ? firstDate >= floorDate : false;
  const c3 = firstDate ? firstDate < floorDate : false;
  const c4 = penult ? penult <= reactThreshold : false;
  const c5 = cw > 0, c6 = pa > 0, c7 = rat > 0;
  let med;
  if      (c1 && c2 && c5)  med = 'Hunting New - Closing';
  else if (c1 && c2 && c7)  med = 'Hunting New - Ratified';
  else if (c1 && c2 && c6)  med = 'Hunting New - Pre Approval';
  else if (c1 && c2)        med = 'Hunting New';
  else if (c1 && c4 && c5)  med = 'Hunting Rescued - Closing';
  else if (c1 && c4 && c7)  med = 'Hunting Rescued - Ratified';
  else if (c1 && c4 && c6)  med = 'Hunting Rescued - Pre Approval';
  else if (c1 && c4)        med = 'Hunting Rescued';
  else if (c1 && c3 && c5)  med = 'Farming Closing';
  else if (c1 && c3 && c7)  med = 'Farming Ratified';
  else if (c1 && c3 && c6)  med = 'Farming Pre Approval';
  else if (c1 && c3)        med = 'Farming Lead';
  else                      med = 'Sin medición';

  return { cnt, convertedCount, firstDate, lastDate, penult, c1, c2, c3, c4, cw, pa, rat, curCw, curRat, curPa, med, leadRows, oppRows, cutoff };
}

export function saveUnassigned(key) {
  const safeKey = key.replace(/[^a-z0-9]/g, '_');
  const ownerEl = document.getElementById('uao_' + safeKey);
  const branchEl = document.getElementById('uab_' + safeKey);
  const owner = (ownerEl && ownerEl.value) ? ownerEl.value : '';
  const branch = branchEl ? (branchEl.value || '') : '';
  if (!owner) return;

  const uEntry = state.unassignedResults.find(r => r.key === key);
  state.unassignedResults = state.unassignedResults.filter(r => r.key !== key);

  const now = fmtNow();
  const name = (uEntry && uEntry.name) || key;
  state.masterMap.set(key, { name, owner, branch, source: 'manual', updatedAt: now, confirmed: true });

  if (uEntry) {
    const f = _computeResultFields(key, uEntry);
    const base = {
      key, name,
      cnt: f.cnt, convertedCount: f.convertedCount,
      firstDate: f.firstDate, penult: f.penult, lastDate: f.lastDate,
      cw: f.cw, pa: f.pa, rat: f.rat, curCw: f.curCw, curRat: f.curRat, curPa: f.curPa,
      assignedOwner: owner, assignedBranch: branch, ownerSource: 'manual', confirmed: true,
      leadRows: f.leadRows, oppRows: f.oppRows
    };
    if (uEntry.isActive) {
      state.activeResults.push(Object.assign({}, base, { c1: f.c1, c2: f.c2, c3: f.c3, c4: f.c4, med: f.med }));
    } else {
      const daysSinceLast = f.lastDate ? Math.floor((f.cutoff - f.lastDate) / 86400000) : null;
      state.inactiveResults.push(Object.assign({}, base, { med: 'Inactive', daysSinceLast }));
    }
  }

  const logEntry = { date: now, realtor: name, from: 'Unassigned', to: owner + (branch ? ' / ' + branch : '') };
  state.changeLog.unshift(logEntry);
  sbFetch('change_log', {
    method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ change_date: logEntry.date, realtor: logEntry.realtor, from_assignment: logEntry.from, to_assignment: logEntry.to })
  }).catch(() => {});

  sbFetch('master_assignments?on_conflict=realtor_key', {
    method: 'POST',
    prefer: 'return=minimal,resolution=merge-duplicates',
    headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify([{ realtor_key: key, realtor_name: name, owner, branch, source: 'manual', updated_at: now, confirmed: true }])
  }).catch(() => {});

  renderUnassigned();
  renderAssignCards();
  renderLog();
}

export function showAssignView(view) {
  const avAssigned   = document.getElementById('assign-view-assigned');
  const avUnassigned = document.getElementById('assign-view-unassigned');
  const btnA = document.getElementById('assign-tab-assigned');
  const btnU = document.getElementById('assign-tab-unassigned');
  if (!avAssigned) return;
  if (view === 'unassigned') {
    avAssigned.classList.add('hidden');
    avUnassigned.classList.remove('hidden');
    if (btnA) btnA.classList.remove('active');
    if (btnU) btnU.classList.add('active');
    renderUnassigned();
  } else {
    avAssigned.classList.remove('hidden');
    avUnassigned.classList.add('hidden');
    if (btnA) btnA.classList.add('active');
    if (btnU) btnU.classList.remove('active');
  }
}

export async function saveAllAssignments() {
  const st = document.getElementById('assign-save-status');
  st.textContent = 'Saving...';
  try {
    const rows = [...state.masterMap.entries()].map(([key, m]) => ({
      realtor_key: key, realtor_name: m.name || '', owner: m.owner || '', branch: m.branch || '',
      source: m.source || 'auto', updated_at: m.updatedAt || '', confirmed: m.confirmed || false
    }));
    await sbFetch('master_assignments?on_conflict=realtor_key', {
      method: 'POST',
      prefer: 'return=minimal,resolution=merge-duplicates',
      headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify(rows)
    });
    st.textContent = '✅ Saved to Supabase ' + fmtNow();
  } catch (e) { st.textContent = '⚠ Save error: ' + e.message; }
}
