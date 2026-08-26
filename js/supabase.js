// ─────────────────────────────────────────────────────────────────────────────
// Origen de datos (a partir del cambio a tablas _v2)
//
// Las tablas leads_v2, opportunities_v2, calls_daily y realtor_owner_map_v2 las
// llena solas el job `simo-sync` desde BigQuery cada día a las 08:00 UTC.
// Ya no hay cargas manuales de estos datos.
//
// La clave anon (SB_KEY) tiene únicamente permiso de SELECT sobre las tablas _v2:
// cualquier intento de escritura (INSERT/UPDATE/DELETE) desde el cliente fallará
// por permisos. Solo lectura desde aquí.
//
// zoom_meetings sigue siendo carga manual (uploadZoomMeetings).
// ─────────────────────────────────────────────────────────────────────────────
import { SB_URL, SB_KEY } from './config.js';
import { getField, parseDate, fmtDB, norm } from './utils.js';
import { state } from './state.js';
import { getAccessToken } from './auth.js';

export async function sbFetch(path, opts = {}) {
  // CAMBIO 1: leer con la sesión del usuario (JWT), no con la anon key, para
  // que RLS pueda filtrar por auth.jwt(). Cae a la anon key si no hay sesión.
  const token = (await getAccessToken()) || SB_KEY;
  const headers = {
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Accept-Profile': 'b2b_metrics'
  };
  if (opts.method && opts.method !== 'GET') {
    headers['Content-Profile'] = 'b2b_metrics';
  }
  if (opts.prefer) headers['Prefer'] = opts.prefer;
  const res = await fetch(SB_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) }
  });
  if (!res.ok) {
    const e = await res.text();
    let msg = e;
    try { const j = JSON.parse(e); msg = j.message || j.error || e; } catch (_) {}
    throw new Error(msg || 'HTTP ' + res.status);
  }
  const text = await res.text();
  if (!text || text.trim() === '') return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

export async function uploadZoomMeetings(data, monthKey, fileName, { onProgress = () => {}, onStatus = () => {} } = {}) {
  try {
    await sbFetch('zoom_meetings?month_key=eq.' + monthKey, { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } });
  } catch (e) { console.log('zoom delete:', e.message); }
  onProgress('zoom', 30);
  const rows = data.filter(row => Object.values(row).some(v => v !== null && String(v).trim() !== ''))
    .map(row => ({
      month_key: monthKey,
      meeting_id: String(getField(row, 'ID', 'id') || '').trim() || null,
      host_name: String(getField(row, 'Host name', 'host name') || '').trim() || null,
      host_email: String(getField(row, 'Host email', 'host email') || '').trim() || null,
      start_time: String(getField(row, 'Start time', 'start time') || '').trim() || null,
      duration_minutes: (() => { const v = getField(row, 'Duration (minutes)', 'duration (minutes)'); return v === null || v === undefined ? null : parseFloat(v) || null; })(),
      participant_name: String(getField(row, 'Name (original name)', 'name (original name)') || '').trim() || null,
      participant_email: String(getField(row, 'Email', 'email') || '').trim() || null,
      is_guest: String(getField(row, 'Guest', 'guest') || '').trim() || null,
      topic: String(getField(row, 'Topic', 'topic') || '').trim() || null
    }));
  const batchSize = 200;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    onStatus('load', '⏳ Uploading zoom: batch ' + batchNum + ' of ' + Math.ceil(rows.length / batchSize));
    await sbFetch('zoom_meetings', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows.slice(i, i + batchSize)) });
    onProgress('zoom', 50 + Math.round((i / rows.length) * 45));
  }
  await sbFetch('upload_meta?file_type=eq.zoom_meetings', { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } });
  await sbFetch('upload_meta', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ file_type: 'zoom_meetings', file_name: fileName, row_count: rows.length }) });
  onProgress('zoom', 95);
  return rows.length;
}

export async function loadCallsData() {
  const all = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const page = await sbFetch('calls_daily?select=*&limit=' + pageSize + '&offset=' + from + '&order=call_date.asc,bd_id.asc,record_type.asc');
    if (!page || !page.length) break;
    all.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  state.callsData = all;
}

export async function loadZoomData() {
  const all = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const page = await sbFetch('zoom_meetings?select=*&limit=' + pageSize + '&offset=' + from + '&order=id.asc');
    if (!page || !page.length) break;
    all.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  state.zoomData = all;
}

export async function loadDataFromSupabase({ onStatus = () => {} } = {}) {
  onStatus('load', '⏳ Querying Supabase...');
  async function fetchAll(table, orderCol) {
    const pageSize = 1000;

    // PASO 1 — Obtener el total de filas con una sola request
    const token = (await getAccessToken()) || SB_KEY;
    const countRes = await fetch(
      SB_URL + '/rest/v1/' + table + '?select=*&limit=1',
      {
        headers: {
          'apikey': SB_KEY,
          'Authorization': 'Bearer ' + token,
          'Accept-Profile': 'b2b_metrics',
          'Prefer': 'count=exact'
        }
      }
    );

    const contentRange = countRes.headers.get('content-range');
    // content-range formato: "0-999/23456"
    const total = contentRange ? parseInt(contentRange.split('/')[1]) : null;

    // Si no se pudo obtener el total, cae al método secuencial original
    if (!total || isNaN(total)) {
      return fetchAllSequential(table, orderCol);
    }

    // PASO 2 — Calcular todos los offsets
    const offsets = [];
    for (let i = 0; i < total; i += pageSize) {
      offsets.push(i);
    }

    // PASO 3 — Disparar todas las páginas en paralelo
    const pages = await Promise.all(
      offsets.map(offset =>
        sbFetch(table + '?select=*&limit=' + pageSize + '&offset=' + offset + '&order=' + orderCol + '.asc')
      )
    );

    // PASO 4 — Combinar resultados en orden
    return pages.flat().filter(Boolean);
  }

  // Fallback secuencial (el original) renombrado
  async function fetchAllSequential(table, orderCol) {
    const all = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const page = await sbFetch(table + '?select=*&limit=' + pageSize + '&offset=' + from + '&order=' + orderCol + '.asc');
      if (!page || !page.length) break;
      all.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }
  const [leads, opps] = await Promise.all([fetchAll('leads_v2', 'lead_id'), fetchAll('opportunities_v2', 'opportunity_id')]);
  onStatus('load', '⏳ Processing ' + leads.length + ' leads and ' + opps.length + ' opportunities...');
  const leadsData = leads.map(r => ({
    'Referred By': r.referred_by, 'Lead Owner': r.lead_owner, 'Branch': r.branch,
    'Created Date': r.create_date, 'Create Date': r.create_date,
    'First Name': r.first_name, 'Last Name': r.last_name, 'Lead Status': r.lead_status,
    'Converted': r.converted
  }));
  const oppData = opps.map(r => ({
    'Referred By': r.referred_by, 'Stage': r.stage,
    'Current Status': r.current_status, 'Current Milestone': r.current_milestone,
    'Disbursement Date': r.disbursement_date, 'Pre-Approved Date': r.pre_approved_date,
    'Ratified Date': r.ratified_date, 'Est. Closing Date': r.est_closing_date,
    'Opportunity Owner': r.opportunity_owner, 'Opportunity Name': r.opportunity_name,
    'Loan #': r.loan_number, 'Loan Officers': r.loan_officer, 'Loan Officer': r.loan_officer,
    'Loan Amount': r.loan_amount, 'Loan Status': r.loan_status, 'Loan Folder': r.loan_folder,
    'Branch': r.branch, 'Account Name': r.account_name,
    'Opportunity Team': r.opportunity_team, 'Lender': r.lender, 'Strategy': r.strategy,
    'Pre-Qualified Doc requested Date': r.pre_qualified_date, 'Healthiness': r.healthiness,
    'Created Date': r.created_date
  }));
  return { leadsData, oppData };
}
