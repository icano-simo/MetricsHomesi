import { SB_URL, SB_KEY } from './config.js';
import { getField, parseDate, fmtDB, norm } from './utils.js';
import { state } from './state.js';

export async function sbFetch(path, opts = {}) {
  const headers = {
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY,
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

export async function uploadToSupabase(type, data, fileName, { onProgress = () => {}, onStatus = () => {} } = {}) {
  const tbl = type === 'leads' ? 'leads' : 'opportunities';
  try {
    await sbFetch(tbl + '?id=neq.0', { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } });
  } catch (e) {
    console.log('Delete note:', e.message);
  }
  onProgress(type, 30);
  const rows = data.map(row => {
    if (type === 'leads') return {
      referred_by: getField(row, 'Referred By', 'referred by') || null,
      lead_owner: String(getField(row, 'Lead Owner', 'lead owner', 'owner') || '').trim() || null,
      branch: String(getField(row, 'Branch', 'branch') || '').trim() || null,
      create_date: fmtDB(parseDate(getField(row, 'Created Date', 'Create Date', 'created date', 'create date'))),
      first_name: String(getField(row, 'First Name', 'first name') || '').trim() || null,
      last_name: String(getField(row, 'Last Name', 'last name') || '').trim() || null,
      lead_status: String(getField(row, 'Lead Status', 'lead status') || '').trim() || null,
      converted: (() => { const v = getField(row, 'Converted', 'converted'); return v === true || String(v || '').trim().toLowerCase() === 'true'; })()
    };
    return {
      referred_by: getField(row, 'Referred By', 'referred by') || null,
      stage: String(getField(row, 'Stage', 'stage') || '').trim() || null,
      current_status: String(getField(row, 'Current Status', 'current status', 'current_status') || '').trim() || null,
      current_milestone: String(getField(row, 'Current Milestone', 'current milestone') || '').trim() || null,
      disbursement_date: fmtDB(parseDate(getField(row, 'Disbursement Date', 'disbursement date'))),
      pre_approved_date: fmtDB(parseDate(getField(row, 'Pre-Approved Date', 'pre-approved date', 'pre approved date'))),
      pre_qualified_date: fmtDB(parseDate(getField(row, 'Pre-Qualified Doc requested Date', 'pre-qualified doc requested date', 'pre_qualified_date'))) || null,
      ratified_date: fmtDB(parseDate(getField(row, 'Ratified Date', 'ratified date'))),
      est_closing_date: fmtDB(parseDate(getField(row, 'Est. Closing Date', 'est. closing date', 'Estimated Closing Date', 'estimated closing date', 'Close Date', 'close date'))),
      opportunity_owner: String(getField(row, 'Opportunity Owner', 'opportunity owner') || '').trim() || null,
      opportunity_name: String(getField(row, 'Opportunity Name', 'opportunity name') || '').trim() || null,
      loan_number: String(getField(row, 'Loan #', 'loan #') || '').trim() || null,
      loan_officer: String(getField(row, 'Loan Officers', 'Loan Officer', 'loan officers', 'loan officer') || '').trim() || null,
      loan_amount: getField(row, 'Loan Amount', 'loan amount') || null,
      loan_status: String(getField(row, 'Loan Status', 'loan status') || '').trim() || null,
      loan_folder: String(getField(row, 'Loan Folder', 'loan folder') || '').trim() || null,
      branch: String(getField(row, 'Branch', 'branch') || '').trim() || null,
      account_name: String(getField(row, 'Account Name', 'account name') || '').trim() || null,
      opportunity_team: String(getField(row, 'Opportunity Team', 'opportunity team') || '').trim() || null,
      lender: String(getField(row, 'Lender', 'lender') || '').trim() || null,
      strategy: String(getField(row, 'Strategy', 'strategy') || '').trim() || null,
      healthiness: String(getField(row, 'Healthiness', 'healthiness') || '').trim() || null,
      created_date: fmtDB(parseDate(getField(row, 'Created Date', 'created date')))
    };
  }).filter(r => r.referred_by);
  onProgress(type, 50);
  const batchSize = 200;
  const totalBatches = Math.ceil(rows.length / batchSize);
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    onStatus('load', '⏳ Uploading ' + type + ': batch ' + batchNum + ' of ' + totalBatches + ' (' + rows.length + ' rows)...');
    try {
      await sbFetch(tbl, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(batch) });
    } catch (e) {
      throw new Error('Error in batch ' + batchNum + ': ' + e.message);
    }
    onProgress(type, 50 + Math.round((i / rows.length) * 45));
  }
  await sbFetch('upload_meta?file_type=eq.' + type, { method: 'DELETE', prefer: 'return=minimal' });
  await sbFetch('upload_meta', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ file_type: type, file_name: fileName, row_count: rows.length }) });
  onProgress(type, 95);
}

export async function uploadCalls(data, fileName, { onProgress = () => {}, onStatus = () => {} } = {}) {
  try {
    await sbFetch('calls?id=neq.0', { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } });
  } catch (e) { console.log('calls delete:', e.message); }
  onProgress('calls', 30);
  const rows = data.map(row => ({
    call_date: fmtDB(parseDate(getField(row, 'Date', 'date'))),
    assigned_to: String(getField(row, 'Assigned', 'assigned') || '').trim() || null,
    effective: (() => { const v = getField(row, 'Effective Calls', 'effective calls'); return v === null || v === undefined ? null : parseFloat(v) || 0; })(),
    record_type: String(getField(row, 'RecordType related', 'recordtype related', 'RecordType Related', 'record_type') || '').trim() || null
  })).filter(r => r.call_date);
  const batchSize = 200;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    onStatus('load', '⏳ Uploading calls: batch ' + batchNum + ' of ' + Math.ceil(rows.length / batchSize));
    await sbFetch('calls', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows.slice(i, i + batchSize)) });
    onProgress('calls', 50 + Math.round((i / rows.length) * 45));
  }
  await sbFetch('upload_meta?file_type=eq.calls', { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } });
  await sbFetch('upload_meta', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ file_type: 'calls', file_name: fileName, row_count: rows.length }) });
  onProgress('calls', 95);
  return rows.length;
}

export async function uploadLoReference(data, fileName, { onProgress = () => {}, onStatus = () => {} } = {}) {
  try {
    await sbFetch('lo_reference?alias=not.is.null', { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } });
  } catch (e) { console.log('lo_reference delete:', e.message); }
  onProgress('loref', 30);
  const raw = data.map(row => ({
    alias: norm(String(getField(row, 'Name (original name)', 'name (original name)') || '').trim()),
    canonical_name: String(getField(row, 'LO', 'lo') || '').trim() || null
  })).filter(r => r.alias);
  const rows = [...new Map(raw.map(r => [r.alias, r])).values()];
  const batchSize = 200;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    onStatus('load', '⏳ Uploading LO reference: batch ' + batchNum + ' of ' + Math.ceil(rows.length / batchSize) + ' (' + rows.length + ' rows)...');
    await sbFetch('lo_reference', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows.slice(i, i + batchSize)) });
    onProgress('loref', 30 + Math.round((i / rows.length) * 60));
  }
  onStatus('load', '⏳ Saving LO reference metadata…');
  await sbFetch('upload_meta?file_type=eq.lo_reference', { method: 'DELETE', prefer: 'return=minimal', headers: { 'Prefer': 'return=minimal' } });
  await sbFetch('upload_meta', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ file_type: 'lo_reference', file_name: fileName, row_count: rows.length }) });
  onProgress('loref', 95);
  return rows.length;
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
    const page = await sbFetch('calls?select=*&limit=' + pageSize + '&offset=' + from + '&order=id.asc');
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
  async function fetchAll(table) {
    const pageSize = 1000;

    // PASO 1 — Obtener el total de filas con una sola request
    const countRes = await fetch(
      SB_URL + '/rest/v1/' + table + '?select=*&limit=1',
      {
        headers: {
          'apikey': SB_KEY,
          'Authorization': 'Bearer ' + SB_KEY,
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
      return fetchAllSequential(table);
    }

    // PASO 2 — Calcular todos los offsets
    const offsets = [];
    for (let i = 0; i < total; i += pageSize) {
      offsets.push(i);
    }

    // PASO 3 — Disparar todas las páginas en paralelo
    const pages = await Promise.all(
      offsets.map(offset =>
        sbFetch(table + '?select=*&limit=' + pageSize + '&offset=' + offset + '&order=id.asc')
      )
    );

    // PASO 4 — Combinar resultados en orden
    return pages.flat().filter(Boolean);
  }

  // Fallback secuencial (el original) renombrado
  async function fetchAllSequential(table) {
    const all = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const page = await sbFetch(table + '?select=*&limit=' + pageSize + '&offset=' + from + '&order=id.asc');
      if (!page || !page.length) break;
      all.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }
  const [leads, opps] = await Promise.all([fetchAll('leads'), fetchAll('opportunities')]);
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
