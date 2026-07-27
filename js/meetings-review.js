import { state } from './state.js';
import { norm, getField, parseDate } from './utils.js';
import { sbFetch } from './supabase.js';

// ── Internal state ────────────────────────────────────────────────────────────
// "participantName|meetingId" → { isRealtor: bool, confirmedRealtorName: string|null }
const _reviewData = new Map();
// norm(participantName) after first "Not Realtor" click — shows LO prompt
const _pendingLOPrompt = new Set();
let _delegationSetup = false;

// ── Private utilities ─────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseZoomTime(s) {
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  return null;
}

const _MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(d) {
  if (!d) return '';
  return _MO[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}

function isDeviceName(name) {
  const nn = norm(name);
  const deviceWords = ['iphone','ipad','android','galaxy','samsung','pixel','tablet','fold',
    'phone','kindle','surface','chromebook'];
  if (deviceWords.some(w => nn.includes(w))) return true;
  if (!name.includes(' ') && name.trim().length > 8) return true;
  return false;
}

// ── Match logic ───────────────────────────────────────────────────────────────

const _SKIP = new Set(['de','la','el','the','del','las','los','y','e','a','of','en']);

function _titleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function _minDate(rows) {
  let min = null;
  for (const row of rows) {
    const d = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (d && (!min || d < min)) min = d;
  }
  return min;
}

function _maxDate(rows) {
  let max = null;
  for (const row of rows) {
    const d = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
    if (d && (!max || d > max)) max = d;
  }
  return max;
}

// Returns { level: 'found'|'salesforce'|'none'|'skip', ...fields }
export function findRealtorMatch(participantName, hostName) {
  const rom = state.realtorOwnerMap || new Map();
  const leads = state.leadsData || [];
  const nPart = norm(participantName);
  const nHost = norm(hostName || '');

  // PASO 1: saved label
  const saved = (state.zoomParticipantLabels || new Map()).get(nPart);
  if (saved && (saved.label === 'not_realtor' || saved.label === 'lo')) {
    return { level: 'skip' };
  }
  let searchName = participantName;
  if (saved && saved.canonical_name) searchName = saved.canonical_name;
  const nSearch = norm(searchName);

  // PASO 2: find realtorKey in map (exact → partial word match)
  let realtorKey = null;
  if (rom.has(nSearch)) {
    realtorKey = nSearch;
  } else {
    const pWds = nSearch.split(/\s+/).filter(w => w.length >= 3 && !_SKIP.has(w));
    if (pWds.length >= 1) {
      for (const rk of rom.keys()) {
        const kWds = rk.split(/\s+/).filter(w => w.length >= 3 && !_SKIP.has(w));
        if (pWds.every(w => kWds.includes(w))) { realtorKey = rk; break; }
      }
    }
  }
  if (!realtorKey) return { level: 'none' };

  const canonicalName = _titleCase(realtorKey);
  const _romO = rom.get(realtorKey);
  const owner = (_romO && typeof _romO === 'object' ? _romO.owner : _romO) || '';

  // PASO 3: count leads via realtorKey → norm(Referred By)
  const matchedLeads = leads.filter(row =>
    norm(String(getField(row, 'Referred By', 'referred by') || '').trim()) === realtorKey
  );

  if (matchedLeads.length > 0) {
    const ownerMatch = matchedLeads.some(row =>
      norm(String(getField(row, 'Lead Owner', 'lead owner') || '').trim()) === nHost
    );
    return {
      level: 'found',
      count: matchedLeads.length,
      firstDate: _minDate(matchedLeads),
      lastDate: _maxDate(matchedLeads),
      ownerMatch,
      canonicalName,
      owner
    };
  }

  return { level: 'salesforce', canonicalName, owner };
}

// ── Manual search ─────────────────────────────────────────────────────────────

function searchInDatabase(searchText) {
  const words = norm(searchText).split(/\s+/).filter(w => w.length >= 3 && !_SKIP.has(w));
  if (!words.length) return [];

  const exactResults = [];
  const partialResults = [];
  const leads = state.leadsData || [];

  for (const [rk, ownerValue] of (state.realtorOwnerMap || new Map()).entries()) {
    const exactPass = words.every(w => rk.includes(w));
    const partialPass = !exactPass && words.some(w => w.length >= 4 && rk.split(' ').some(rkW => rkW.includes(w)));
    if (!exactPass && !partialPass) continue;

    const owner = typeof ownerValue === 'string' ? ownerValue : (ownerValue?.owner || '');
    const displayName = _titleCase(rk);
    let count = 0, lastDate = null;
    for (const row of leads) {
      if (norm(String(getField(row, 'Referred By', 'referred by') || '').trim()) !== rk) continue;
      count++;
      const d = parseDate(getField(row, 'Created Date', 'created date', 'Create Date', 'create date'));
      if (d && (!lastDate || d > lastDate)) lastDate = d;
    }
    const entry = { rk, displayName, owner, count, lastDate, matchType: exactPass ? 'exact' : 'partial' };
    if (exactPass) exactResults.push(entry); else partialResults.push(entry);
  }

  const byCount = (a, b) => b.count - a.count;
  exactResults.sort(byCount);
  partialResults.sort(byCount);
  return [...exactResults, ...partialResults].slice(0, 8);
}

// ── Search UI ─────────────────────────────────────────────────────────────────

function _runSearch(container, participantName) {
  const inputEl = container && container.querySelector('.mr-pipeline-input');
  const searchText = (inputEl ? inputEl.value : '').trim();
  if (!searchText) return;
  const resultEl = container && container.querySelector('.mr-pipeline-result');
  if (!resultEl) return;

  const results = searchInDatabase(searchText);
  if (!results.length) {
    resultEl.innerHTML = '<span style="color:#C0392B;font-size:10px">No match found for &ldquo;' + escHtml(searchText) + '&rdquo;</span>';
    return;
  }

  const items = results.map(r => {
    const isPartial = r.matchType === 'partial';
    const countPart = r.count > 0
      ? r.count + ' lead' + (r.count !== 1 ? 's' : '') + (r.lastDate ? ' &middot; last: ' + fmtDate(r.lastDate) : '')
      : 'no leads yet';
    const prefix = isPartial
      ? '<span style="color:#AABBCC;font-style:italic;margin-right:4px">possible:</span>'
      : '';
    const lbl = prefix +
      '<span style="color:' + (isPartial ? '#6677AA' : 'inherit') + '">' + escHtml(r.displayName) + '</span>' +
      ' <span style="color:#8899BB">&middot; Owner: ' + escHtml(r.owner) + ' &middot; ' + countPart + '</span>';
    const btnStyle = 'display:block;width:100%;text-align:left;font-size:10px;padding:4px 8px;margin-bottom:2px' +
      (isPartial ? ';background:#F5F7FA;border-top:1px dashed #D0DAF0' : '');
    return '<button class="mr-btn" style="' + btnStyle + '" ' +
      'data-mr-action="confirm-search-match" ' +
      'data-participant="' + escHtml(participantName) + '" ' +
      'data-canonical="' + escHtml(r.displayName) + '" ' +
      'data-realtor-key="' + escHtml(r.rk) + '">' + lbl + '</button>';
  }).join('');
  resultEl.innerHTML = '<div style="border:1px solid #D0DAF0;border-radius:4px;padding:4px;background:#F8FAFF">' + items + '</div>';
}

// ── Event delegation ──────────────────────────────────────────────────────────

function setupDelegation() {
  if (_delegationSetup) return;
  _delegationSetup = true;

  document.addEventListener('click', e => {
    const markBtn = e.target.closest('[data-mr-action="mark-participant"]');
    if (markBtn) {
      markMeetingParticipant(
        markBtn.dataset.participant || '',
        markBtn.dataset.email || '',
        markBtn.dataset.host || '',
        markBtn.dataset.meetingId || '',
        markBtn.dataset.date || '',
        markBtn.dataset.isRealtor === 'true'
      );
      return;
    }

    const dncBtn = e.target.closest('[data-mr-action="toggle-no-count"]');
    if (dncBtn) {
      toggleDoesNotCount(dncBtn.dataset.meetingId || '', dncBtn.dataset.host || '', dncBtn.dataset.current === 'true');
      return;
    }

    const loYesBtn = e.target.closest('[data-mr-action="lo-prompt-yes"]');
    if (loYesBtn) {
      saveParticipantLabel(loYesBtn.dataset.pkey || '', loYesBtn.dataset.name || '', 'lo');
      return;
    }

    const loNoBtn = e.target.closest('[data-mr-action="lo-prompt-no"]');
    if (loNoBtn) {
      saveParticipantLabel(loNoBtn.dataset.pkey || '', loNoBtn.dataset.name || '', 'not_realtor');
      return;
    }

    const toggleSearchBtn = e.target.closest('[data-mr-action="toggle-manual-search"]');
    if (toggleSearchBtn) {
      const sc = toggleSearchBtn.closest('.mr-participant')?.querySelector('[data-pipeline-search-container]');
      if (sc) sc.style.display = sc.style.display === 'none' ? '' : 'none';
      return;
    }

    const pipelineBtn = e.target.closest('[data-mr-action="pipeline-search"]');
    if (pipelineBtn) {
      _runSearch(pipelineBtn.closest('[data-pipeline-search-container]'), pipelineBtn.dataset.participant || '');
      return;
    }

    const searchMatchBtn = e.target.closest('[data-mr-action="confirm-search-match"]');
    if (searchMatchBtn) {
      const pn = searchMatchBtn.dataset.participant || '';
      const cn = searchMatchBtn.dataset.canonical || '';
      if (pn && cn) {
        const resultEl = searchMatchBtn.closest('.mr-pipeline-result');
        if (resultEl) resultEl.innerHTML = '<span style="color:#1A9E5A;font-weight:700;font-size:10px">&#10003; Saved &mdash; applied to all meetings</span>';
        confirmSearchMatch(pn, cn);
      }
      return;
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const inp = e.target.closest('.mr-pipeline-input');
    if (inp) {
      e.preventDefault();
      const container = inp.closest('[data-pipeline-search-container]');
      if (container) _runSearch(container, container.dataset.participant || '');
    }
  });
}

// ── Exported public functions ─────────────────────────────────────────────────

export async function loadMeetingReviews() {
  try {
    const rows = await sbFetch('meeting_participants_review?select=participant_name,meeting_id,is_realtor,confirmed_realtor_name,does_not_count');
    _reviewData.clear();
    state.doNotCountMeetings = new Set();
    for (const r of (rows || [])) {
      if (r.participant_name === '_meeting_') {
        if (r.does_not_count) state.doNotCountMeetings.add(r.meeting_id || '');
      } else {
        _reviewData.set(
          (r.participant_name || '') + '|' + (r.meeting_id || ''),
          { isRealtor: r.is_realtor, confirmedRealtorName: r.confirmed_realtor_name ?? null }
        );
      }
    }
  } catch (_) {}
}

export async function markMeetingParticipant(name, email, host, meetingId, date, isRealtor) {
  const key = name + '|' + meetingId;
  const existing = _reviewData.get(key) || {};
  _reviewData.set(key, { isRealtor, confirmedRealtorName: existing.confirmedRealtorName ?? null });
  const pKey = norm(name);
  if (!isRealtor && !(state.zoomParticipantLabels || new Map()).has(pKey)) {
    _pendingLOPrompt.add(pKey);
  } else if (isRealtor) {
    _pendingLOPrompt.delete(pKey);
  }
  try {
    await sbFetch('meeting_participants_review?on_conflict=participant_name,meeting_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        participant_name: name,
        participant_email: email || null,
        meeting_id: meetingId,
        meeting_date: date || null,
        host_name: host || null,
        is_realtor: isRealtor
      })
    });
  } catch (_) {}
  renderMeetingsReview();
}

export async function toggleDoesNotCount(meetingId, hostName, currentValue) {
  const newVal = !currentValue;
  if (!state.doNotCountMeetings) state.doNotCountMeetings = new Set();
  if (newVal) { state.doNotCountMeetings.add(meetingId); } else { state.doNotCountMeetings.delete(meetingId); }
  try {
    await sbFetch('meeting_participants_review?on_conflict=participant_name,meeting_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        participant_name: '_meeting_',
        meeting_id: meetingId,
        host_name: hostName || null,
        does_not_count: newVal,
        is_realtor: null
      })
    });
  } catch (_) {
    if (newVal) { state.doNotCountMeetings.delete(meetingId); } else { state.doNotCountMeetings.add(meetingId); }
  }
  renderMeetingsReview();
}

export async function saveParticipantLabel(participantKey, participantName, label, canonicalName = null) {
  _pendingLOPrompt.delete(participantKey);
  if (!state.zoomParticipantLabels) state.zoomParticipantLabels = new Map();
  const canonical = canonicalName !== null ? canonicalName : (label === 'lo' ? participantName : null);
  // 1. Update state optimistically
  state.zoomParticipantLabels.set(participantKey, { label, canonical_name: canonical });
  try {
    // 2. Persist to Supabase
    await sbFetch('zoom_participant_labels?on_conflict=participant_key', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ participant_key: participantKey, participant_name: participantName, label, canonical_name: canonical })
    });
    if (label === 'lo') {
      if (!state.loReferenceMap) state.loReferenceMap = new Map();
      state.loReferenceMap.set(participantKey, participantName);
      try {
        await sbFetch('lo_reference?on_conflict=alias', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({ alias: participantKey, canonical_name: participantName })
        });
      } catch (_) {}
    }
    // 3. Re-render only after successful save
    renderMeetingsReview();
  } catch (_) {
    // Rollback state — do NOT re-render (chip stays as-is until user retries)
    state.zoomParticipantLabels.delete(participantKey);
  }
}

export async function confirmSearchMatch(participantName, canonicalName) {
  await saveParticipantLabel(norm(participantName), participantName, 'realtor', canonicalName);
}

export function initMeetingsReview() {
  setupDelegation();
  const yearSel  = document.getElementById('mr-year');
  const monthSel = document.getElementById('mr-month');
  const hostSel  = document.getElementById('mr-host');
  if (!yearSel) return;

  const allowedOwners = (document.getElementById('owners-list') || { value: '' }).value
    .split(',').map(s => s.trim()).filter(s => s !== '' && s !== '""' && s.replace(/[",\s]/g, '') !== '');
  const ownersNorm = new Set(allowedOwners.map(o => norm(o)));

  const MS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const yearsSet  = new Set();
  const monthsSet = new Set();
  const hostsSet  = new Set();
  for (const r of (state.zoomData || [])) {
    if (r.month_key) {
      yearsSet.add(Number(r.month_key.slice(0, 4)));
      monthsSet.add(r.month_key.slice(5, 7));
    }
    if (r.host_name && ownersNorm.has(norm(r.host_name.trim()))) hostsSet.add(r.host_name.trim());
  }

  const prevYear = yearSel.value;
  yearSel.innerHTML = '<option value="">All Years</option>' +
    [...yearsSet].sort((a, b) => b - a).map(y =>
      '<option value="' + y + '"' + (String(y) === prevYear ? ' selected' : '') + '>' + y + '</option>'
    ).join('');

  const prevMonth = monthSel.value;
  monthSel.innerHTML = '<option value="">All Months</option>' +
    [...monthsSet].sort().map(mm => {
      const lbl = MS_FULL[parseInt(mm, 10) - 1] || mm;
      return '<option value="' + mm + '"' + (mm === prevMonth ? ' selected' : '') + '>' + lbl + '</option>';
    }).join('');

  const prevHost = hostSel.value;
  hostSel.innerHTML = '<option value="">All BDs</option>' +
    [...hostsSet].sort().map(h =>
      '<option value="' + h + '"' + (h === prevHost ? ' selected' : '') + '>' + h + '</option>'
    ).join('');

  renderMeetingsReview();
}

export function clearMrFilters() {
  const yearSel  = document.getElementById('mr-year');
  const monthSel = document.getElementById('mr-month');
  const hostSel  = document.getElementById('mr-host');
  if (yearSel)  yearSel.value  = '';
  if (monthSel) monthSel.value = '';
  if (hostSel)  hostSel.value  = '';
  renderMeetingsReview();
}

export function renderMeetingsReview() {
  const content = document.getElementById('mr-content');
  if (!content) return;

  const yearVal  = (document.getElementById('mr-year')  || {}).value || '';
  const monthVal = (document.getElementById('mr-month') || {}).value || '';
  const hostVal  = (document.getElementById('mr-host')  || {}).value || '';

  const allowedOwners = (document.getElementById('owners-list') || { value: '' }).value
    .split(',').map(s => s.trim()).filter(s => s !== '' && s !== '""' && s.replace(/[",\s]/g, '') !== '');
  const ownersNorm = new Set(allowedOwners.map(o => norm(o)));

  // ── Build meeting groups ──
  const meetingMap = new Map();
  for (const r of (state.zoomData || [])) {
    if (!ownersNorm.has(norm((r.host_name || '').trim()))) continue;
    const mk = r.month_key || '';
    if (yearVal  && mk.slice(0, 4) !== yearVal)  continue;
    if (monthVal && mk.slice(5, 7) !== monthVal) continue;
    if (hostVal  && (r.host_name || '').trim() !== hostVal) continue;
    const key = (r.meeting_id || '') + '|' + mk + '|' + (r.start_time || '');
    if (!meetingMap.has(key)) {
      meetingMap.set(key, {
        meeting_id: r.meeting_id || '',
        host_name: (r.host_name || '').trim(),
        start_time: parseZoomTime(r.start_time),
        duration: r.duration_minutes,
        topic: (r.topic || '').trim() || null,
        rows: []
      });
    }
    meetingMap.get(key).rows.push(r);
  }

  if (!meetingMap.size) {
    content.innerHTML = '<div class="empty-state">No meetings found for the selected filters.</div>';
    return;
  }

  const doNotCount  = state.doNotCountMeetings || new Set();
  const globalLabels = state.zoomParticipantLabels || new Map();

  const meetings = [...meetingMap.values()]
    .filter(m => m.rows.some(r => r.is_guest === 'Yes'))
    .sort((a, b) => (b.start_time || 0) - (a.start_time || 0));

  // ── Per-meeting card renderer ──
  const rendered = meetings.map(m => {
    const isDNC = doNotCount.has(m.meeting_id);

    const dateStr = m.start_time
      ? _MO[m.start_time.getMonth()] + ' ' + m.start_time.getDate() + ', ' + m.start_time.getFullYear()
      : '—';
    const timeStr = (() => {
      if (!m.start_time) return '';
      const h = m.start_time.getHours(), mi = String(m.start_time.getMinutes()).padStart(2, '0');
      return (h % 12 || 12) + ':' + mi + ' ' + (h >= 12 ? 'PM' : 'AM');
    })();

    const allRows = m.rows.filter(r => r.participant_name && r.participant_name.trim());
    const nHost   = norm(m.host_name);

    // ── Deduplicate externals ──
    const rawExternals = allRows.filter(r => r.is_guest === 'Yes');
    const extKey = n => norm(n.trim().split(/\s+/).slice(0, 2).join(' '));
    const extDeduped = [];
    const extSeen = new Map();
    for (const p of rawExternals) {
      const n = (p.participant_name || '').trim();
      const k = extKey(n);
      if (!extSeen.has(k)) {
        extSeen.set(k, extDeduped.length);
        extDeduped.push(p);
      } else {
        const idx = extSeen.get(k);
        const prev = (extDeduped[idx].participant_name || '').trim();
        if (isDeviceName(prev) && !isDeviceName(n)) extDeduped[idx] = p;
      }
    }

    const loLabeledExternals = extDeduped.filter(p =>
      globalLabels.get(norm((p.participant_name || '').trim()))?.label === 'lo'
    );
    const filteredExternals = extDeduped.filter(p =>
      globalLabels.get(norm((p.participant_name || '').trim()))?.label !== 'lo'
    );
    const allInternals = allRows.filter(r => r.is_guest !== 'Yes').concat(loLabeledExternals);

    // ── Render internal participant ──
    const renderInternal = p => {
      const name  = (p.participant_name || '').trim();
      const email = (p.participant_email || '').trim();
      const nn    = norm(name);
      const isHost = nn === nHost;
      const isLO   = (state.loReferenceMap || new Map()).has(nn);
      const badge  = isLO
        ? '<span class="mr-badge-lo">LO</span>'
        : isHost
          ? '<span class="mr-badge-internal" style="background:#E8EEF8;color:#334466">Host</span>'
          : '<span class="mr-badge-internal">Internal</span>';
      return '<div class="mr-participant">' +
        '<span class="mr-participant-name">' + escHtml(name) +
          (email ? ' <span class="mr-participant-email">' + escHtml(email) + '</span>' : '') +
        '</span>' + badge + '</div>';
    };

    // ── Render external participant ──
    const renderExternal = p => {
      const name  = (p.participant_name || '').trim();
      const email = (p.participant_email || '').trim();
      const pKey  = norm(name);
      const globalLabel = globalLabels.get(pKey);

      const nameHtml = '<span class="mr-participant-name">' + escHtml(name) +
        (email ? ' <span class="mr-participant-email">' + escHtml(email) + '</span>' : '') + '</span>';

      // LO prompt — after first "Not Realtor" click, before label is saved
      if (_pendingLOPrompt.has(pKey)) {
        return '<div class="mr-participant"><div style="width:100%">' +
          '<div class="mr-participant-top">' + nameHtml +
            '<span class="mr-status-not">&#10007; Not Realtor</span>' +
          '</div>' +
          '<div style="margin-top:6px;padding:8px 10px;background:#FFF9E6;border:1px solid #E8D59A;border-radius:6px;font-size:11px">' +
            '<div style="font-weight:600;color:#854D0E;margin-bottom:6px">Is this person a Loan Officer?</div>' +
            '<div style="display:flex;gap:6px">' +
              '<button class="mr-btn mr-btn-realtor" data-mr-action="lo-prompt-yes" data-pkey="' + escHtml(pKey) + '" data-name="' + escHtml(name) + '">&#10003; Yes, mark as LO</button>' +
              '<button class="mr-btn mr-btn-not" data-mr-action="lo-prompt-no" data-pkey="' + escHtml(pKey) + '" data-name="' + escHtml(name) + '">No, just not a realtor</button>' +
            '</div>' +
          '</div>' +
        '</div></div>';
      }

      // Not realtor — badge only, no actions
      if (globalLabel?.label === 'not_realtor') {
        return '<div class="mr-participant">' + nameHtml +
          '<span class="mr-status-not" style="font-size:10px">&#10007; Not a realtor</span>' +
          '</div>';
      }

      // ── Match chip ──
      const match = findRealtorMatch(name, m.host_name);
      let chip;
      if (match.level === 'found') {
        const cls = 'mr-chip-pipeline' + (match.ownerMatch ? ' mr-chip-pipeline-strong' : '');
        const dates = (match.firstDate || match.lastDate)
          ? ' &middot; first: ' + fmtDate(match.firstDate) + (match.lastDate ? ' &middot; last: ' + fmtDate(match.lastDate) : '')
          : '';
        chip = '<span class="' + cls + '">&#10003; ' + escHtml(match.canonicalName) +
          ' &middot; ' + match.count + ' lead' + (match.count !== 1 ? 's' : '') + dates + '</span>';
      } else if (match.level === 'salesforce') {
        chip = '<span style="display:inline-flex;align-items:center;font-size:10px;font-weight:600;color:#1E4D7B;background:#EBF4FF;border:1px solid #BFDBFE;border-radius:20px;padding:2px 8px">' +
          'In Salesforce &middot; ' + escHtml(match.canonicalName) + ' &middot; no leads yet' +
          (match.owner ? ' &middot; Owner: ' + escHtml(match.owner) : '') + '</span>';
      } else {
        // level === 'none' or unexpected 'skip' (safety net)
        chip = '<span class="mr-chip-nopipeline">Not found in database</span>';
      }

      const changeBtn = match.level !== 'none'
        ? ' <button style="font-size:10px;color:#5577CC;background:none;border:none;padding:0;cursor:pointer;text-decoration:underline" data-mr-action="toggle-manual-search">[Change]</button>'
        : '';

      // ── Per-meeting review state ──
      const revEntry = _reviewData.get(name + '|' + m.meeting_id);
      const isRealtor = revEntry ? revEntry.isRealtor : undefined;
      const mDate = m.start_time
        ? m.start_time.getFullYear() + '-' +
          String(m.start_time.getMonth() + 1).padStart(2, '0') + '-' +
          String(m.start_time.getDate()).padStart(2, '0')
        : '';
      const dataAttrs =
        ' data-mr-action="mark-participant"' +
        ' data-participant="' + escHtml(name) + '"' +
        ' data-email="' + escHtml(email) + '"' +
        ' data-host="' + escHtml(m.host_name) + '"' +
        ' data-meeting-id="' + escHtml(m.meeting_id) + '"' +
        ' data-date="' + escHtml(mDate) + '"';

      let status = '';
      if (revEntry && isRealtor === true)  status = '<span class="mr-status-realtor">&#10003; Realtor</span>';
      if (revEntry && isRealtor === false) status = '<span class="mr-status-not">&#10007; Not Realtor</span>';

      let actions;
      if (revEntry && isRealtor === true) {
        actions = '<button class="mr-btn mr-btn-secondary"' + dataAttrs + ' data-is-realtor="false">&#10007; Not Realtor</button>';
      } else if (revEntry && isRealtor === false) {
        actions = '<button class="mr-btn mr-btn-secondary"' + dataAttrs + ' data-is-realtor="true">&#10003; Realtor</button>';
      } else {
        actions = '<button class="mr-btn mr-btn-realtor"' + dataAttrs + ' data-is-realtor="true">&#10003; Realtor</button>' +
                  '<button class="mr-btn mr-btn-not"' + dataAttrs + ' data-is-realtor="false">&#10007; Not Realtor</button>';
      }

      // ── Search container ──
      const showSearch = match.level === 'none' || isDeviceName(name);
      const searchContainer =
        '<div data-pipeline-search-container data-participant="' + escHtml(name) + '" data-host="' + escHtml(m.host_name) + '"' +
        (!showSearch ? ' style="display:none"' : '') + '>' +
        '<div style="display:flex;gap:4px;align-items:center">' +
        '<input type="text" class="mr-pipeline-input" placeholder="Search in database by name" style="font-size:10px;padding:3px 8px;border:1px solid #D0DAF0;border-radius:4px;flex:1;min-width:0">' +
        '<button class="mr-btn" data-mr-action="pipeline-search" data-participant="' + escHtml(name) + '" data-host="' + escHtml(m.host_name) + '" style="font-size:10px;padding:2px 8px">&#128269; Search</button>' +
        '</div>' +
        '<div class="mr-pipeline-result" style="margin-top:4px"></div>' +
        '</div>';

      return '<div class="mr-participant">' +
        '<div style="width:100%;display:flex;flex-direction:column;gap:5px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">' +
            nameHtml + (status ? '<span>' + status + '</span>' : '') +
          '</div>' +
          '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">' + chip + changeBtn + '</div>' +
          '<div><span class="mr-participant-actions">' + actions + '</span></div>' +
          searchContainer +
        '</div>' +
        '</div>';
    };

    // ── DNC button ──
    const dncStyle = 'font-size:10px;font-weight:600;border:1.5px solid ' +
      (isDNC ? '#D4A000' : '#D0DAF0') + ';border-radius:5px;padding:2px 8px;cursor:pointer;background:' +
      (isDNC ? '#FFFBEB' : 'white') + ';color:' + (isDNC ? '#854D0E' : '#8899BB') + ';white-space:nowrap;flex-shrink:0';
    const dncBtnHtml = '<button data-mr-action="toggle-no-count" data-meeting-id="' + escHtml(m.meeting_id) +
      '" data-host="' + escHtml(m.host_name) + '" data-current="' + isDNC + '" style="' + dncStyle + '">' +
      (isDNC ? '&#8856; No cuenta' : '&#8856; Marcar &ldquo;No cuenta&rdquo;') + '</button>';

    const html = '<div class="mr-card" style="' + (isDNC ? 'border-color:#E8D59A' : '') + '">' +
      '<div class="mr-card-header">' +
        (m.topic ? '<div class="mr-card-topic">' + escHtml(m.topic) + '</div>' : '') +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">' +
          '<div class="mr-card-meta">' +
            '<span class="mr-meta-date">' + escHtml(dateStr) + '</span>' +
            (timeStr ? ' <span class="mr-meta-time">' + escHtml(timeStr) + '</span>' : '') +
            ' &nbsp;&middot;&nbsp; <span class="mr-meta-host">' + escHtml(m.host_name) + '</span>' +
            (m.duration ? ' &nbsp;&middot;&nbsp; <span class="mr-meta-duration">' + m.duration + ' min</span>' : '') +
            ' &nbsp;&middot;&nbsp; <span class="mr-meta-count">' + allRows.length + ' participant' + (allRows.length !== 1 ? 's' : '') + '</span>' +
          '</div>' +
          dncBtnHtml +
        '</div>' +
      '</div>' +
      (allInternals.length
        ? '<div class="mr-section"><div class="mr-section-title">Internal Participants</div>' +
          '<div class="mr-participants-list">' + allInternals.map(renderInternal).join('') + '</div></div>'
        : '') +
      (filteredExternals.length
        ? '<div class="mr-section"><div class="mr-section-title">External Participants</div>' +
          '<div class="mr-participants-list">' + filteredExternals.map(renderExternal).join('') + '</div></div>'
        : '') +
      '</div>';

    return { isDNC, html };
  });

  const activeHtml    = rendered.filter(r => !r.isDNC).map(r => r.html).join('');
  const dncItems      = rendered.filter(r =>  r.isDNC);
  const dncSectionHtml = dncItems.length
    ? '<details style="margin-top:16px"><summary style="cursor:pointer;font-size:12px;font-weight:700;color:#854D0E;padding:6px 2px;list-style:none;display:flex;align-items:center;gap:6px;user-select:none"><span>&#9654;</span> Follow-up meetings (not counted) &mdash; ' + dncItems.length + '</summary><div style="margin-top:8px">' + dncItems.map(r => r.html).join('') + '</div></details>'
    : '';

  content.innerHTML = activeHtml + dncSectionHtml;
}
