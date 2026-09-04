// Turn a comparison result into things people read: an Excel workbook (Summary, Findings, Users,
// Baseline/eCW coverage), a plain-text summary for the terminal, and CSV.
import { buildXlsx, STYLE } from './xlsx.js';
import { perUser } from './validate.js';

const FILL = { high: STYLE.red, medium: STYLE.amber, low: STYLE.blue, info: STYLE.grey };
export const TYPE_LABEL = {
  ok: 'OK', excess: 'Excess access', missing: 'Missing access', different: 'Different level',
  'user-not-in-baseline': 'User not in baseline', 'user-not-in-ecw': 'User not in eCW',
  'permission-not-in-baseline': 'Setting not in baseline', 'permission-not-in-ecw': 'Setting not in eCW',
};

export function reportSheets(result, meta = {}) {
  const when = meta.when || new Date().toISOString();
  const summary = [
    ['eCW security settings validation', ''],
    ['Result', result.pass ? 'PASS — no high or medium findings' : 'FAIL — see Findings'],
    ['Run at', when],
    ['Baseline file', meta.baseline || ''], ['Baseline sheet', meta.baselineSheet || ''], ['Baseline layout', meta.baselineLayout || ''],
    ['eCW export file', meta.actual || ''], ['eCW sheet', meta.actualSheet || ''], ['eCW layout', meta.actualLayout || ''],
    [],
    ['Users in baseline', result.users.baseline], ['Users in eCW export', result.users.ecw], ['Users in both', result.users.both],
    ['Settings in baseline', result.permissions.baseline], ['Settings in eCW export', result.permissions.ecw], ['Settings in both', result.permissions.both],
    ['(user, setting) pairs compared', result.compared],
    [],
    ['Findings by severity', ''], ['High', result.bySeverity.high], ['Medium', result.bySeverity.medium], ['Low', result.bySeverity.low], ['Info', result.bySeverity.info],
    [],
    ['Findings by type', ''],
    ...Object.entries(result.counts).filter(([t]) => t !== 'ok').map(([t, n]) => [TYPE_LABEL[t] || t, n]),
    ['Matching pairs', result.counts.ok],
    [],
    ['How to read this', 'High = access eCW grants that the baseline does not (remove it, or approve it in the baseline). Medium = access the baseline requires that eCW lacks, a level mismatch, or a baseline user eCW does not list. Low/Info = coverage gaps between the two documents.'],
  ];
  const findings = [
    ['Severity', 'Type', 'User', 'Security setting', 'Expected (baseline)', 'Actual (eCW)', 'Note', 'Baseline row', 'eCW row'],
    ...result.findings.map(f => [f.severity.toUpperCase(), TYPE_LABEL[f.type] || f.type, f.user, f.permission, f.expected, f.actual, f.note, f.baselineRow ?? '', f.actualRow ?? '']),
  ];
  const users = [['User', 'High', 'Medium', 'Low', 'Info', 'Excess', 'Missing', 'Different', 'Other'], ...perUser(result).map(u => [u.user, u.high, u.medium, u.low, u.info, u.excess, u.missing, u.different, u.other])];
  return [
    { name: 'Summary', rows: summary, widths: [34, 90], freeze: false, styles: (r, c) => (r === 0 || (c === 0 && summary[r]?.length === 2 && summary[r][1] === '') ? STYLE.header : r === 1 ? (result.pass ? STYLE.green : STYLE.red) : 0) },
    { name: 'Findings', rows: findings, widths: [10, 24, 26, 48, 22, 22, 70, 12, 10], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 0 ? FILL[result.findings[r - 1].severity] : 0) },
    { name: 'Users', rows: users, widths: [30, 8, 8, 8, 8, 8, 8, 10, 8], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 1 && users[r][1] > 0 ? STYLE.red : c === 2 && users[r][2] > 0 ? STYLE.amber : 0) },
  ];
}

export const buildReport = (result, meta) => buildXlsx(reportSheets(result, meta));

export function textSummary(result, meta = {}) {
  const L = [];
  L.push(`eCW security settings validation — ${result.pass ? 'PASS' : 'FAIL'}`);
  if (meta.baseline) L.push(`  baseline: ${meta.baseline}${meta.baselineSheet ? ` [${meta.baselineSheet}, ${meta.baselineLayout}]` : ''}`);
  if (meta.actual) L.push(`  eCW export: ${meta.actual}${meta.actualSheet ? ` [${meta.actualSheet}, ${meta.actualLayout}]` : ''}`);
  L.push(`  users: ${result.users.baseline} in baseline, ${result.users.ecw} in eCW, ${result.users.both} in both`);
  L.push(`  settings: ${result.permissions.baseline} in baseline, ${result.permissions.ecw} in eCW, ${result.permissions.both} in both`);
  L.push(`  compared ${result.compared} user/setting pairs: ${result.counts.ok} match`);
  L.push(`  findings: ${result.bySeverity.high} high, ${result.bySeverity.medium} medium, ${result.bySeverity.low} low, ${result.bySeverity.info} info`);
  const shown = result.findings.filter(f => f.severity !== 'info').slice(0, meta.limit ?? 40);
  if (shown.length) {
    L.push('');
    const w = Math.min(28, Math.max(4, ...shown.map(f => f.user.length)));
    for (const f of shown) L.push(`  ${f.severity.toUpperCase().padEnd(6)} ${(TYPE_LABEL[f.type] || f.type).padEnd(24)} ${f.user.slice(0, w).padEnd(w)}  ${f.permission}${f.expected || f.actual ? `  [expected ${f.expected || '—'} | eCW ${f.actual || '—'}]` : ''}`);
    const more = result.findings.filter(f => f.severity !== 'info').length - shown.length;
    if (more > 0) L.push(`  … ${more} more (see the report)`);
  }
  return L.join('\n');
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function findingsCsv(result) {
  const rows = [['severity', 'type', 'user', 'setting', 'expected', 'actual', 'note', 'baseline_row', 'ecw_row'], ...result.findings.map(f => [f.severity, f.type, f.user, f.permission, f.expected, f.actual, f.note, f.baselineRow ?? '', f.actualRow ?? ''])];
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
