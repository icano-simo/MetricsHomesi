import { state } from './state.js';
import { bus } from './events.js';
import { sbFetch, uploadToSupabase, uploadCalls, uploadLoReference, uploadZoomMeetings, loadCallsData, loadZoomData, loadDataFromSupabase } from './supabase.js';
import { runCalc } from './calc.js';
import { setMode, renderTable, populateFilters, renderSummary, srt, onModeSelect, showTab } from './ui.js';
import { renderScorecard, refreshScorecard, clearScorecardFilters, renderRankings } from './scorecard.js';
import { renderAssignCards, clearAssignFilters, confirmAssign, unconfirm, updateAssign, saveAllAssignments, showAssignView, renderUnassigned, saveUnassigned, loadSfReference, applyUaSuggestion } from './assignments.js';
import { renderLog } from './log.js';
import { exportCSV, exportMasterCSV, exportLog, exportManualAssignments, dl } from './export.js';
import { showScorecardDetail, showLeadDetail, showOppDetail, showAllLeadsForRealtor, showConvertedLeadsDetail, openModal, closeModal } from './modal.js';
import { initPipeline, renderPipeline, renderClosedWon, clearPipelineFilters, clearClosedWonFilters, showPipelineStageDetail, downloadCwOwnerCsv } from './pipeline.js';
import { initTrends, renderTrends } from './trends.js';
import { initPerformance, renderPerformance, loadKpiSettings, saveKpiSettings, saveOwnersList } from './performance.js';
// LO Metrics modules
import { runLoCalc } from './lo-calc.js';
import { setLoMode, renderLoTable, populateLoFilters, renderLoSummary, srtLo, onLoModeSelect, showLoTab } from './lo-ui.js';
import { renderLoScorecard, refreshLoScorecard, clearLoScorecardFilters } from './lo-scorecard.js';
import { renderLoAssignCards, clearLoAssignFilters, confirmLoAssign, unconfirmLo, updateLoAssign, saveAllLoAssignments, showLoAssignView, renderLoUnassigned, saveLoUnassigned } from './lo-assignments.js';
import { initLoPipeline, renderLoPipeline, renderLoCwSection, clearLoPipelineFilters, clearLoCwFilters } from './lo-pipeline.js';
import { initLoTrends, renderLoTrends } from './lo-trends.js';
import { initLoPerformance, renderLoPerformance } from './lo-performance.js';
import { initMeetingsReview, renderMeetingsReview, clearMrFilters, markMeetingParticipant, loadMeetingReviews, saveParticipantLabel, toggleDoesNotCount } from './meetings-review.js';
import { signIn, signOut, getSession, getCurrentUser, mustChangePassword, updatePassword } from './auth.js';

let _zoomLoading = false;

// card-id suffix for each file type (used for progress bars and status labels)
const TYPE_TO_CARD = {
  leads: 'leads',
  opp: 'opp',
  calls: 'calls',
  lo_reference: 'loref',
  zoom: 'zoom'
};

function setStatus(t, msg) {
  const bar = document.getElementById('status-bar');
  bar.className = 'status-bar ' + (t === 'ok' ? 'sb-ok' : t === 'err' ? 'sb-err' : t === 'warn' ? 'sb-warn' : 'sb-load');
  document.getElementById('status-text').textContent = msg;
}

function setProgress(cardId, pct) {
  const pf = document.getElementById('pf-' + cardId);
  if (pf) pf.style.width = pct + '%';
  if (pct >= 100) setTimeout(() => {
    const pb = document.getElementById('pb-' + cardId);
    if (pb) pb.classList.add('hidden');
  }, 800);
}

bus.on('status', ({ type, msg }) => setStatus(type, msg));

bus.on('calc:complete', ({ windowDays, cutoff, floorDate, inactFloor, allowedOwners }) => {
  populateFilters(allowedOwners);
  renderSummary(windowDays, null, null, cutoff, floorDate, inactFloor);
  setMode(state.currentMode);
  renderScorecard(allowedOwners);
  renderAssignCards();
  renderLog();
  initPipeline();
  initTrends();
  initPerformance();
  document.getElementById('results').classList.remove('hidden');
});

bus.on('lo-calc:complete', ({ windowDays, cutoff, floorDate, inactFloor, allowedOwners }) => {
  // Guarda los LOs efectivos (para fallback cuando el textarea lo-list está vacío / auto-discover)
  state.loAllowedOwners = allowedOwners;

  // Siempre renderiza lo esencial (Ratings)
  populateLoFilters(allowedOwners);
  renderLoSummary(windowDays, state.loActiveResults, state.loInactiveResults, cutoff, floorDate, inactFloor);
  setLoMode(state.loCurrentMode);

  // Marca todas las pestañas (excepto Ratings) como pendientes de render
  state.loPendingRender = new Set(['sc', 'pipeline', 'perf', 'trends', 'assign']);

  // Renderiza solo la pestaña activa
  renderLoActiveTab();

  document.getElementById('lo-results').classList.remove('hidden');
});

function getAllowedLoOwners() {
  const el = document.getElementById('lo-list');
  const fromInput = el
    ? el.value.split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').trim()).filter(s => s !== '')
    : [];
  return fromInput.length ? fromInput : (state.loAllowedOwners || []);
}

function renderLoActiveTab() {
  const active = state.loCurrentTab || 'med';

  if (active === 'sc' && state.loPendingRender?.has('sc')) {
    renderLoScorecard(getAllowedLoOwners());
    state.loPendingRender.delete('sc');
  }
  if (active === 'pipeline' && state.loPendingRender?.has('pipeline')) {
    initLoPipeline();
    state.loPendingRender.delete('pipeline');
  }
  if (active === 'perf' && state.loPendingRender?.has('perf')) {
    initLoPerformance();
    state.loPendingRender.delete('perf');
  }
  if (active === 'trends' && state.loPendingRender?.has('trends')) {
    initLoTrends();
    state.loPendingRender.delete('trends');
  }
  if (active === 'assign' && state.loPendingRender?.has('assign')) {
    renderLoAssignCards();
    state.loPendingRender.delete('assign');
  }
}

// Disparado por showLoTab (lo-ui.js) al cambiar de pestaña LO
bus.on('lo-tab:shown', renderLoActiveTab);

function handleFile(e, type) {
  const file = e.target.files[0]; if (!file) return;
  const cardId = TYPE_TO_CARD[type];
  const uz = document.getElementById('uz-' + cardId);
  if (uz) uz.classList.add('uploading');
  const pb = document.getElementById('pb-' + cardId);
  if (pb) pb.classList.remove('hidden');

  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const wb = XLSX.read(ev.target.result, { type: 'binary', cellDates: false });
      let data;

      if (type === 'leads') {
        const sn = wb.SheetNames.find(n => /lead|refer/i.test(n)) || wb.SheetNames[0];
        data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: null });
        state.leadsData = data;
      } else if (type === 'opp') {
        const sn = wb.SheetNames.find(n => /opp/i.test(n)) || wb.SheetNames[1] || wb.SheetNames[0];
        data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: null });
        state.oppData = data;
      } else if (type === 'calls') {
        const sn = wb.SheetNames[0];
        data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: null });
      } else if (type === 'lo_reference') {
        const sn = wb.SheetNames[0];
        data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: null });
      } else if (type === 'zoom') {
        const sn = wb.SheetNames[0];
        data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: null });
      }

      setProgress(cardId, 15);

      if (state.dbConnected) {
        if (type === 'leads' || type === 'opp') {
          await uploadToSupabase(type, data, file.name, {
            onProgress: (t, pct) => setProgress(cardId, pct),
            onStatus: setStatus
          });
        } else if (type === 'calls') {
          await uploadCalls(data, file.name, {
            onProgress: (t, pct) => setProgress(cardId, pct),
            onStatus: setStatus
          });
        } else if (type === 'lo_reference') {
          await uploadLoReference(data, file.name, {
            onProgress: (t, pct) => setProgress(cardId, pct),
            onStatus: setStatus
          });
          await loadLoReferenceMap();
        } else if (type === 'zoom') {
          const year = document.getElementById('zoom-upload-year').value;
          const month = document.getElementById('zoom-upload-month').value;
          const monthKey = year + '-' + month;
          await uploadZoomMeetings(data, monthKey, file.name, {
            onProgress: (t, pct) => setProgress(cardId, pct),
            onStatus: setStatus
          });
        }
      }

      setProgress(cardId, 100);
      if (uz) { uz.classList.remove('uploading'); uz.classList.add('ok'); }
      const lbl = document.getElementById('uz-' + cardId + '-lbl');
      if (lbl) lbl.textContent = '' + file.name + ' (' + (data ? data.length : 0) + ' rows)';
      const saved = document.getElementById('uz-' + cardId + '-saved');
      if (saved) {
        saved.textContent = '💾 Saved ' + new Date().toLocaleDateString('es-CO');
        saved.classList.remove('hidden');
      }
      if (state.leadsData || state.oppData) document.getElementById('run-btn').disabled = false;
      setStatus('ok', '' + file.name + ' saved to Supabase (' + (data ? data.length : 0) + ' rows)');
    } catch (err) {
      if (uz) uz.classList.remove('uploading');
      setStatus('err', '❌ Error: ' + err.message);
    }
  };
  reader.readAsBinaryString(file);
}

function openSettings() {
  document.getElementById('settings-panel').classList.add('open');
  document.getElementById('settings-overlay').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-panel').classList.remove('open');
  document.getElementById('settings-overlay').classList.remove('open');
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const wrap = document.getElementById('app-wrap');
  sidebar.classList.toggle('collapsed');
  wrap.classList.toggle('sidebar-collapsed');
  localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed') ? '1' : '0');
}

function _refreshMeetingsIfOpen() {
  const el = document.getElementById('view-meetings-review');
  if (el && !el.classList.contains('hidden')) initMeetingsReview();
}

function showView(viewId) {
  ['view-bd-metrics', 'view-data-upload', 'view-lo-metrics', 'view-meetings-review'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== 'view-' + viewId);
  });
  document.querySelectorAll('.sidebar-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === viewId);
  });
  if (viewId === 'meetings-review') {
    if (_zoomLoading) {
      const content = document.getElementById('mr-content');
      if (content) content.innerHTML = '<div class="empty-state" style="display:flex;align-items:center;gap:10px;padding:32px"><span style="font-size:18px">&#9203;</span><span>Loading meetings…</span></div>';
    } else {
      initMeetingsReview();
    }
  }
}

async function saveLoList() {
  const el = document.getElementById('lo-list-settings');
  const el2 = document.getElementById('lo-list');
  const val = el ? el.value : (el2 ? el2.value : '');
  const statusEl = document.getElementById('lo-list-save-status');
  if (statusEl) statusEl.textContent = 'Saving…';
  try {
    await sbFetch('kpi_settings?on_conflict=key', {
      method: 'POST',
      prefer: 'return=minimal,resolution=merge-duplicates',
      headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify([{ key: 'lo_list', text_value: val }])
    });
    if (statusEl) { statusEl.textContent = 'Saved'; setTimeout(() => { statusEl.textContent = ''; }, 3000); }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}

function syncLoList(source) {
  const settings = document.getElementById('lo-list-settings');
  const lo = document.getElementById('lo-list');
  if (source === 'settings' && settings && lo) lo.value = settings.value;
  else if (source === 'lo' && settings && lo) settings.value = lo.value;
}

async function loadLoReferenceMap() {
  try {
    const rows = await sbFetch('lo_reference?select=alias,canonical_name');
    state.loReferenceMap = new Map();
    for (const r of (rows || [])) {
      if (r.alias && r.canonical_name) state.loReferenceMap.set(r.alias, r.canonical_name);
    }
  } catch (_) {}
}

async function loadLoMasterMap() {
  try {
    const rows = await sbFetch('lo_master_assignments?select=*');
    for (const m of (rows || [])) {
      if (m.source === 'manual') {
        state.loMasterMap.set(m.realtor_key, {
          name: m.realtor_name, loan_officer: m.loan_officer, branch: m.branch,
          source: m.source, updatedAt: m.updated_at,
          confirmed: m.confirmed === true || m.confirmed === 'true'
        });
      }
    }
  } catch (_) {}
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-rkey]');
  if (!el) return;
  const key = decodeURIComponent(el.getAttribute('data-rkey') || '');
  const dtype = el.getAttribute('data-dtype') || '';
  if (!key || !dtype) return;
  const allR = state.activeResults.concat(state.inactiveResults)
    .concat(state.loActiveResults).concat(state.loInactiveResults);
  const r = allR.find(x => x.key === key);
  if (!r) return;
  if (dtype === 'leads') showLeadDetail(key, r.name);
  else if (dtype === 'converted') showConvertedLeadsDetail(key, r.name);
  else showOppDetail(key, r.name, dtype);
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-owner][data-med]');
  if (!el) return;
  showScorecardDetail(el.getAttribute('data-owner'), el.getAttribute('data-med'));
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-pl-owner][data-pl-stage]');
  if (!el) return;
  showPipelineStageDetail(el.getAttribute('data-pl-owner'), el.getAttribute('data-pl-stage'));
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-cw-owner]');
  if (!el) return;
  downloadCwOwnerCsv(el.getAttribute('data-cw-owner'));
});

async function initApp() {
  setStatus('load', '⏳ Connecting to Supabase...');

  // Restore sidebar state from localStorage
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('app-wrap').classList.add('sidebar-collapsed');
  }

  // Restore calc params visibility
  if (localStorage.getItem('calcParamsVisible') === '0') {
    const extra = document.getElementById('calc-params-extra');
    const btn = document.getElementById('calc-params-toggle');
    if (extra) extra.classList.add('hidden');
    if (btn) btn.textContent = 'Show Parameters';
  }

  // Populate zoom year selector
  const zoomYearSel = document.getElementById('zoom-upload-year');
  if (zoomYearSel) {
    const curYear = new Date().getFullYear();
    for (let y = curYear; y >= curYear - 3; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      zoomYearSel.appendChild(opt);
    }
    // Default zoom month to current month
    const curMonth = String(new Date().getMonth() + 1).padStart(2, '0');
    const zoomMonthSel = document.getElementById('zoom-upload-month');
    if (zoomMonthSel) {
      Array.from(zoomMonthSel.options).forEach(o => { o.selected = o.value === curMonth; });
    }
  }

  try {
    const meta = await sbFetch('upload_meta?select=file_type,file_name,row_count,uploaded_at');
    state.dbConnected = true;

    // map file_type → card id suffix
    const typeToCard = {
      leads: 'leads', opp: 'opp', calls: 'calls',
      lo_reference: 'loref', zoom_meetings: 'zoom'
    };
    let hasData = false;

    for (const m of (meta || [])) {
      const type = m.file_type;
      if (type === 'realtor_map') {
        const statusEl = document.getElementById('sf-ref-status');
        if (statusEl) statusEl.innerHTML =
          '<span style="color:#1A9E5A;font-weight:700">Uploaded &#10003;</span>' +
          ' &nbsp;' + m.file_name + ' &nbsp;·&nbsp; ' + m.row_count + ' rows &nbsp;·&nbsp; ' +
          new Date(m.uploaded_at).toLocaleDateString('es-CO');
        continue;
      }
      const cardId = typeToCard[type];
      if (!cardId) continue;
      const uzEl = document.getElementById('uz-' + cardId);
      if (uzEl) uzEl.classList.add('ok');
      const lblEl = document.getElementById('uz-' + cardId + '-lbl');
      if (lblEl) lblEl.textContent = '' + m.file_name + ' (' + m.row_count + ' rows)';
      const savedEl = document.getElementById('uz-' + cardId + '-saved');
      if (savedEl) {
        savedEl.textContent = '💾 Saved ' + new Date(m.uploaded_at).toLocaleDateString('es-CO');
        savedEl.classList.remove('hidden');
      }
      if (type === 'leads' || type === 'opp') hasData = true;
    }

    // GRUPO 1 — configuración y tablas independientes en paralelo
    setStatus('load', '⏳ Loading configuration...');
    try {
      await Promise.all([
        (async () => {
          const master = await sbFetch('master_assignments?select=*');
          for (const m of (master || [])) {
            if (m.source === 'manual') {
              state.masterMap.set(m.realtor_key, { name: m.realtor_name, owner: m.owner, branch: m.branch, source: m.source, updatedAt: m.updated_at, confirmed: m.confirmed === true || m.confirmed === 'true' });
            }
          }
        })().catch(e => console.warn('[initApp] master_assignments:', e.message)),
        (async () => {
          const logs = await sbFetch('change_log?select=*&order=created_at.desc&limit=200');
          state.changeLog = (logs || []).map(l => ({ date: l.change_date, realtor: l.realtor, from: l.from_assignment, to: l.to_assignment }));
        })().catch(e => console.warn('[initApp] change_log:', e.message)),
        (async () => {
          const PAGE = 1000;
          let offset = 0;
          state.realtorOwnerMap = new Map();
          while (true) {
            const rows = await sbFetch('realtor_owner_map?select=*&limit=' + PAGE + '&offset=' + offset);
            if (!rows || !rows.length) break;
            for (const r of rows) {
              if (r.realtor_key && r.owner) state.realtorOwnerMap.set(r.realtor_key, { owner: r.owner, name: r.realtor_name, branch: r.branch, loan_officers: r.loan_officers, meeting_attended_date: r.meeting_attended_date, invite_sent_date: r.invite_sent_date, nppm: r.nppm, last_referral_date: r.last_referral_date, opportunity_record_type: r.opportunity_record_type, stage: r.stage, created_date: r.created_date });
            }
            if (rows.length < PAGE) break;
            offset += PAGE;
          }
        })().catch(e => console.warn('[initApp] realtor_owner_map:', e.message)),
        loadLoReferenceMap(),
        loadLoMasterMap(),
        loadKpiSettings().catch(e => console.warn('[initApp] kpi:', e.message)),
        loadCallsData().catch(e => console.warn('[initApp] calls:', e.message)),
        loadMeetingReviews().catch(e => console.warn('[initApp] meetingReviews:', e.message)),
        (async () => {
          const PAGE = 1000;
          let offset = 0;
          state.zoomParticipantLabels = new Map();
          while (true) {
            const rows = await sbFetch('zoom_participant_labels?select=participant_key,label,canonical_name&limit=' + PAGE + '&offset=' + offset);
            if (!rows || !rows.length) break;
            for (const r of rows) {
              if (r.participant_key) state.zoomParticipantLabels.set(r.participant_key, { label: r.label, canonical_name: r.canonical_name || null });
            }
            if (rows.length < PAGE) break;
            offset += PAGE;
          }
        })().catch(e => console.warn('[initApp] zoom_participant_labels:', e.message))
      ]);
    } catch (e) {
      console.warn('[initApp] config group failed:', e.message);
    }

    // GRUPO 2 — datos pesados en paralelo entre sí
    setStatus('load', '⏳ Loading data...');
    try {
      _zoomLoading = true;
      const zoomPromise = loadZoomData()
        .then(() => { _zoomLoading = false; _refreshMeetingsIfOpen(); })
        .catch(() => { _zoomLoading = false; _refreshMeetingsIfOpen(); });
      const needLeads = !state.leadsData || !state.leadsData.length;
      const [dataRes] = await Promise.all([
        needLeads ? loadDataFromSupabase() : Promise.resolve(null),
        zoomPromise
      ]);
      if (dataRes) {
        state.leadsData = dataRes.leadsData;
        state.oppData = dataRes.oppData;
      }
    } catch (e) {
      console.warn('[initApp] data group failed:', e.message);
    }

    if (hasData) {
      setStatus('ok', 'Supabase connected — saved data available. Press Calculate to view results.');
      document.getElementById('run-btn').disabled = false;
    } else {
      setStatus('ok', 'Supabase connected — upload your files to get started.');
    }
  } catch (e) {
    setStatus('err', '❌ Error: ' + e.message);
  }
}

function toggleCalcParams() {
  const extra = document.getElementById('calc-params-extra');
  const btn = document.getElementById('calc-params-toggle');
  if (!extra) return;
  const nowHidden = extra.classList.toggle('hidden');
  if (btn) btn.textContent = nowHidden ? 'Show Parameters' : 'Hide Parameters';
  localStorage.setItem('calcParamsVisible', nowHidden ? '0' : '1');
}

// Expose functions needed by inline HTML onclick handlers
Object.assign(window, {
  runCalc, openSettings, closeSettings, onModeSelect, renderTable, showTab, srt,
  toggleCalcParams,
  clearScorecardFilters, refreshScorecard, renderRankings,
  renderAssignCards, saveAllAssignments, clearAssignFilters, confirmAssign, unconfirm, updateAssign,
  showAssignView, renderUnassigned, saveUnassigned, loadSfReference, applyUaSuggestion,
  exportCSV, exportMasterCSV, exportLog, exportManualAssignments, dl,
  closeModal, showAllLeadsForRealtor,
  handleFile,
  renderPipeline, renderClosedWon, clearPipelineFilters, clearClosedWonFilters, showPipelineStageDetail, renderTrends,
  renderPerformance, saveKpiSettings, saveOwnersList,
  toggleSidebar, showView, saveLoList, syncLoList,
  renderMeetingsReview, clearMrFilters, markMeetingParticipant, saveParticipantLabel, toggleDoesNotCount,
  // LO Metrics
  runLoCalc, renderLoTable, setLoMode, showLoTab, srtLo, onLoModeSelect,
  renderLoScorecard, refreshLoScorecard, clearLoScorecardFilters,
  renderLoAssignCards, saveAllLoAssignments, clearLoAssignFilters,
  confirmLoAssign, unconfirmLo, updateLoAssign, showLoAssignView, renderLoUnassigned, saveLoUnassigned,
  renderLoPipeline, renderLoCwSection, clearLoPipelineFilters, clearLoCwFilters,
  renderLoTrends, renderLoPerformance,
  exportLoCsv: () => {
    const { exportCsvRaw } = dl ? { exportCsvRaw: dl } : {};
    const results = state.loCurrentMode === 'active' ? state.loActiveResults : state.loInactiveResults;
    const rows = [
      ['Realtor', 'Branch', 'LO', 'Rating', 'Period Leads', 'Converted', 'Closed Won', 'Pre-Approval', 'Ratified'],
      ...results.map(r => [r.name, r.assignedBranch || '', r.assignedOwner || '', r.med, r.cnt, r.convertedCount || 0, r.cw || 0, r.pa || 0, r.rat || 0])
    ];
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'lo-metrics.csv'; a.click();
    URL.revokeObjectURL(url);
  }
});

// Set default date values and start app
const today = new Date();
const todayStr = today.toISOString().split('T')[0];
const infDate = new Date(today); infDate.setFullYear(infDate.getFullYear() - 1);
const infStr = infDate.toISOString().split('T')[0];

document.getElementById('cutoff-date').value = todayStr;
document.getElementById('inactive-from').value = infStr;
document.getElementById('lo-cutoff-date').value = todayStr;
document.getElementById('lo-inactive-from').value = infStr;

// ── Autenticación (Supabase Auth) ──
async function checkAuth() {
  const session = await getSession();
  if (!session) {
    document.getElementById('auth-overlay').style.display = 'flex';
    setupLoginForm();
    return false;
  }
  const email = (session.user && session.user.email) || '';
  if (!email.endsWith('@supremelending.com')) {
    await signOut();
    return false;
  }
  // Verifica si debe cambiar contraseña (primer login)
  const mustChange = await mustChangePassword();
  if (mustChange) {
    document.getElementById('auth-overlay').style.display = 'none';
    showChangePasswordOverlay();
    return false;
  }
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('app-container').style.display = '';
  showUserInHeader(email);
  return true;
}

function setupLoginForm() {
  const btn = document.getElementById('auth-submit');
  const emailInput = document.getElementById('auth-email');
  const passInput = document.getElementById('auth-password');
  passInput.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
  btn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passInput.value;
    if (!email || !password) { showAuthError('Please enter your email and password.'); return; }
    if (!email.endsWith('@supremelending.com')) { showAuthError('Only @supremelending.com accounts are authorized.'); return; }
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    try {
      await signIn(email, password);
      window.location.reload();
    } catch (err) {
      showAuthError(err.message === 'Invalid login credentials' ? 'Incorrect email or password.' : err.message);
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function showUserInHeader(email) {
  const header = document.querySelector('.topbar');
  if (!header || document.querySelector('.header-user')) return;
  const userDiv = document.createElement('div');
  userDiv.className = 'header-user';
  userDiv.innerHTML = '<span class="header-user-email">' + email + '</span>' +
    '<button class="header-logout-btn" id="logout-btn">Sign Out</button>';
  header.appendChild(userDiv);
  document.getElementById('logout-btn').addEventListener('click', async () => { await signOut(); });
}

function showChangePasswordOverlay() {
  document.getElementById('change-password-overlay').style.display = 'flex';

  const btn = document.getElementById('change-pw-submit');
  const newPw = document.getElementById('new-password');
  const confirmPw = document.getElementById('confirm-password');
  const errEl = document.getElementById('change-pw-error');

  confirmPw.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });

  btn.addEventListener('click', async () => {
    const pw1 = newPw.value;
    const pw2 = confirmPw.value;
    errEl.style.display = 'none';

    if (pw1.length < 8) {
      errEl.textContent = 'Password must be at least 8 characters.';
      errEl.style.display = 'block';
      return;
    }
    if (pw1 !== pw2) {
      errEl.textContent = 'Passwords do not match.';
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      await updatePassword(pw1);
      document.getElementById('change-password-overlay').style.display = 'none';
      document.getElementById('app-container').style.display = '';
      const user = await getCurrentUser();
      showUserInHeader(user.email);
      await initApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Set Password & Enter';
    }
  });
}

// Bootstrap: verifica sesión antes de iniciar la app
function bootApp() {
  checkAuth().then(authed => { if (authed) initApp(); });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}
