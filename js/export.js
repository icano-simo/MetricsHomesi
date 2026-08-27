import { state } from './state.js';
import { fmtDate } from './utils.js';
import { sbFetch } from './supabase.js';

export function dl(rows, fn) {
  const csv = rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = fn;
  a.click();
}

export async function exportManualAssignments() {
  let rows;
  try {
    rows = await sbFetch('master_assignments?source=eq.manual&select=realtor_key,realtor_name,owner,branch,confirmed,updated_at&order=owner.asc,realtor_name.asc');
  } catch (e) {
    alert('Error exporting manual assignments: ' + e.message);
    return;
  }
  if (!rows || !rows.length) {
    alert('No manual assignments found to export.');
    return;
  }
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const cols = ['realtor_key', 'realtor_name', 'owner', 'branch', 'confirmed', 'updated_at'];
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [
    '# Homesi B2B Metrics — Manual Assignments Backup',
    '# Exported: ' + now.toISOString(),
    '# DO NOT EDIT realtor_key column — it is',
    '# the primary key used for matching',
    '# source=manual rows only',
    cols.join(','),
    ...rows.map(r => cols.map(c => esc(r[c])).join(','))
  ];
  const csv = lines.join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'manual_assignments_' + today + '.csv';
  a.click();
}

export function exportCSV() {
  const fm = document.getElementById('filter-med').value;
  const fo = document.getElementById('filter-own').value;
  const fb = document.getElementById('filter-branch').value;
  const rows = (state.currentMode === 'active' ? state.activeResults : state.inactiveResults)
    .filter(r => (!fm || r.med === fm) && (!fo || r.assignedOwner === fo) && (!fb || r.assignedBranch === fb));
  let h, d;
  if (state.currentMode === 'active') {
    h = ['Realtor', 'Period Leads', 'Converted to Opp.', '1st Lead', '2nd to Last Lead', 'Leads w/ Pre-Approval', 'Leads w/ Ratified', 'Leads Closed Won', 'Curr. Pre-Approval', 'Curr. Ratified', 'Curr. Closed Won', 'Owner', 'Branch', 'Rating', 'Confirmed'];
    d = rows.map(r => [r.name, r.cnt, r.convertedCount || 0, fmtDate(r.firstDate), fmtDate(r.penult), r.pa, r.rat, r.cw, r.curPa, r.curRat, r.curCw, r.assignedOwner, r.assignedBranch, r.med, r.confirmed ? 'Yes' : 'No']);
  } else {
    h = ['Realtor', 'Last Lead', 'Inactive Days', '1st Lead', 'Closed Won', 'Pre-Approval', 'Ratified', 'Closings (all-time)', 'Owner', 'Branch'];
    d = rows.map(r => [r.name, fmtDate(r.lastDate), r.daysSinceLast || '', fmtDate(r.firstDate), r.cw, r.pa, r.rat, r.cwAll || 0, r.assignedOwner, r.assignedBranch]);
  }
  dl([h, ...d], 'realtors_' + state.currentMode + '.csv');
}

export function exportMasterCSV() {
  dl(
    [
      ['Realtor', 'Owner', 'Branch', 'Source', 'Updated', 'Confirmed'],
      ...[...state.masterMap.entries()].map(([, m]) => [m.name, m.owner, m.branch, m.source, m.updatedAt, m.confirmed ? 'Yes' : 'No'])
    ],
    'asignaciones.csv'
  );
}

export function exportLog() {
  dl(
    [
      ['Date', 'Realtor', 'Before', 'After'],
      ...state.changeLog.map(e => [e.date, e.realtor, e.from, e.to])
    ],
    'historial.csv'
  );
}
