// Turn a comparison result into things people read: an Excel workbook (Summary, Actions, Findings,
// Side by side, Users, Settings, Matches), a plain-text summary for the terminal, and CSV.
import { buildXlsx, STYLE } from './xlsx.js';
import { perUser, TYPE_LABEL } from './validate.js';

export { TYPE_LABEL };
const FILL = { high: STYLE.red, medium: STYLE.amber, low: STYLE.blue, info: STYLE.grey };
const CELL = { ok: STYLE.green, excess: STYLE.red, missing: STYLE.amber, different: STYLE.amber, 'user-not-in-baseline': STYLE.blue, 'user-not-in-ecw': STYLE.blue, 'permission-not-in-baseline': STYLE.grey, 'permission-not-in-ecw': STYLE.grey };

export function reportSheets(result, meta = {}) {
  const when = meta.when || new Date().toISOString();
  const warnings = [...(meta.baselineWarnings || []).map(w => ['Baseline', w]), ...(meta.actualWarnings || []).map(w => ['eCW export', w])];
  const summary = [
    ['eCW security settings validation', ''],
    ['Result', result.pass ? 'PASS — no high or medium findings' : `FAIL — ${result.bySeverity.high} high, ${result.bySeverity.medium} medium (see Actions and Findings)`],
    ['Run at', when],
    ['Baseline file', meta.baseline || ''], ['Baseline sheet', meta.baselineSheet || ''], ['Baseline read as', meta.baselineLayout || ''],
    ['eCW export file', meta.actual || ''], ['eCW sheet', meta.actualSheet || ''], ['eCW read as', meta.actualLayout || ''],
    [],
    ['Users in baseline', result.users.baseline], ['Users in eCW export', result.users.ecw], ['Users in both', result.users.both],
    ['Settings in baseline', result.permissions.baseline], ['Settings in eCW export', result.permissions.ecw], ['Settings in both', result.permissions.both],
    ['(user, setting) pairs compared', result.compared], ['… of which match', result.counts.ok],
    [],
    ['Findings by severity', ''], ['High', result.bySeverity.high], ['Medium', result.bySeverity.medium], ['Low', result.bySeverity.low], ['Info', result.bySeverity.info],
    [],
    ['Findings by type', ''],
    ...Object.entries(result.counts).filter(([t]) => t !== 'ok').map(([t, n]) => [TYPE_LABEL[t] || t, n]),
    [],
    ['Settings matched by alias or name', result.matches.length],
    ...(result.catalog ? [[], ['eCW settings catalog', meta.catalog || ''], ['Catalog settings', result.catalog.total], ['… covered by the baseline', result.catalog.covered], ['… not covered but granted to someone in eCW', result.catalog.grantedUncovered], ['Baseline settings not in the catalog', result.catalog.unknown.length], ['eCW settings not in the catalog', result.catalog.ecwUnknown.length]] : []),
    [],
    ['Sheets', ''],
    ['Actions', 'per user: what to remove, grant or review in eCW'],
    ['Findings', 'every discrepancy, worst first, with the row numbers in both files'],
    ['Side by side', 'every user × setting: expected vs. actual, colour-coded'],
    ['Users / Settings', 'where the discrepancies concentrate'],
    ['Matches', 'settings and users the validator paired by alias or by name rather than exactly'],
    ...(result.catalog ? [['Coverage', 'every catalog setting: its group, what it controls, whether the baseline covers it, how many eCW users hold it'], ['Not in catalog', 'baseline (and eCW) setting names the catalog does not know — typos or renamed items, with the closest catalog name']] : []),
    [],
    ['How to read this', 'High = access eCW grants that the baseline does not (remove it, or approve it in the baseline). Medium = access the baseline requires that eCW lacks, a level mismatch, or a baseline user eCW does not list. Low/Info = coverage gaps between the two documents.'],
  ];
  if (warnings.length) summary.push([], ['Warnings while reading', ''], ...warnings);

  const actions = [['User', 'Role (baseline)', 'Remove in eCW (excess)', 'Grant in eCW (missing)', 'Review', 'User status']];
  const roleOf = new Map(result.detail.map(d => [d.user, d.role || '']));
  for (const a of result.actions) actions.push([a.user, roleOf.get(a.user) || '', a.remove.join('\n'), a.grant.join('\n'), a.review.join('\n'), a.status]);

  const hasCat = !!result.catalog;
  const findings = [
    ['Severity', 'Type', 'User', 'Security setting', ...(hasCat ? ['Group', 'What it controls'] : []), 'Expected (baseline)', 'Actual (eCW)', 'Note', 'Baseline row', 'eCW row'],
    ...result.findings.map(f => [f.severity.toUpperCase(), TYPE_LABEL[f.type] || f.type, f.user, f.permission, ...(hasCat ? [f.group || '', f.description || ''] : []), f.expected, f.actual, f.note, f.baselineRow ?? '', f.actualRow ?? '']),
  ];

  // Side by side: settings down, users across; each cell "expected → actual" unless they agree.
  const settingsAll = [...new Set(result.detail.flatMap(d => d.settings.map(s => s.permission)))].sort();
  const usersAll = result.detail.map(d => d.user);
  const cellOf = new Map();   // "user|setting" → entry
  for (const d of result.detail) for (const s of d.settings) cellOf.set(`${d.user}|${s.permission}`, s);
  const sbs = [['Security setting', ...usersAll], ['(baseline / eCW)', ...result.detail.map(d => d.inBaseline && d.inEcw ? 'both' : d.inBaseline ? 'baseline only' : 'eCW only')]];
  const sbsStyle = [[STYLE.header, ...usersAll.map(() => STYLE.header)], [STYLE.grey, ...result.detail.map(d => d.inBaseline && d.inEcw ? STYLE.grey : STYLE.blue)]];
  for (const p of settingsAll) {
    const row = [p], st = [STYLE.header];
    for (const u of usersAll) {
      const s = cellOf.get(`${u}|${p}`);
      if (!s) { row.push(''); st.push(0); continue; }
      const ex = s.expected || '—', ac = s.actual || '—';
      row.push(s.type === 'ok' ? ac.replace(/ \(.*\)$/, '') : `${ex} → ${ac}`); st.push(CELL[s.type] ?? 0);
    }
    sbs.push(row); sbsStyle.push(st);
  }

  const users = [['User', 'Role (baseline)', 'High', 'Medium', 'Low', 'Info', 'Excess', 'Missing', 'Different', 'Other'], ...perUser(result).map(u => [u.user, roleOf.get(u.user) || '', u.high, u.medium, u.low, u.info, u.excess, u.missing, u.different, u.other])];
  const settings = [['Security setting', 'Excess', 'Missing', 'Different', 'Other', 'OK'], ...result.bySetting.map(s => [s.setting, s.excess, s.missing, s.different, s.other, s.ok])];
  const coverage = hasCat ? [['Group', 'Security setting', 'What it controls', 'In baseline?', 'Granted in eCW to (users)', 'Type'], ...[...result.catalog.settings].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)).map(s => [s.group, s.name, s.description, s.inBaseline ? 'Y' : 'N', s.grantedTo, s.type])] : [];
  const notInCat = hasCat ? [['Side', 'Setting name', 'Closest catalog setting', 'Its group'], ...result.catalog.unknown.map(u => ['baseline', u.name, u.suggestion, u.group]), ...result.catalog.ecwUnknown.map(n => ['eCW export', n, '', ''])] : [];
  const matches = [['Kind', 'Baseline name', 'eCW name', 'Matched by'], ...result.matches.map(m => [m.kind === 'user' ? 'User' : 'Setting', m.baseline, m.ecw, m.by === 'alias' ? 'alias you supplied' : 'same name, different category'])];

  return [
    { name: 'Summary', rows: summary, widths: [34, 100], freeze: false, styles: (r, c) => (r === 0 || (c === 0 && summary[r]?.length === 2 && summary[r][1] === '') ? STYLE.header : r === 1 ? (result.pass ? STYLE.green : STYLE.red) : 0) },
    { name: 'Actions', rows: actions, widths: [22, 16, 48, 48, 60, 60], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 2 && actions[r][2] ? STYLE.redWrap : c === 3 && actions[r][3] ? STYLE.amberWrap : c === 5 && actions[r][5] ? STYLE.blueWrap : c >= 2 ? STYLE.wrap : 0) },
    { name: 'Findings', rows: findings, widths: hasCat ? [10, 24, 22, 48, 26, 60, 22, 22, 80, 12, 10] : [10, 24, 22, 48, 22, 22, 80, 12, 10], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 0 ? FILL[result.findings[r - 1].severity] : hasCat && c === 5 ? STYLE.wrap : 0) },
    { name: 'Side by side', rows: sbs, widths: [44, ...usersAll.map(() => 18)], styles: (r, c) => sbsStyle[r]?.[c] ?? 0 },
    { name: 'Users', rows: users, widths: [26, 16, 8, 8, 8, 8, 8, 8, 10, 8], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 2 && users[r][2] > 0 ? STYLE.red : c === 3 && users[r][3] > 0 ? STYLE.amber : 0) },
    { name: 'Settings', rows: settings, widths: [48, 8, 8, 10, 8, 8], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 1 && settings[r][1] > 0 ? STYLE.red : c === 2 && settings[r][2] > 0 ? STYLE.amber : 0) },
    { name: 'Matches', rows: matches, widths: [10, 48, 48, 30], autofilter: true },
    ...(hasCat ? [
      { name: 'Coverage', rows: coverage, widths: [30, 50, 80, 12, 16, 8], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 3 && coverage[r][3] === 'N' && coverage[r][4] > 0 ? STYLE.amber : c === 3 && coverage[r][3] === 'Y' ? STYLE.green : c === 2 ? STYLE.wrap : 0) },
      { name: 'Not in catalog', rows: notInCat, widths: [12, 50, 50, 30], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 1 ? STYLE.amber : 0) },
    ] : []),
  ];
}

export const buildReport = (result, meta) => buildXlsx(reportSheets(result, meta));

export function textSummary(result, meta = {}) {
  const L = [];
  L.push(`eCW security settings validation — ${result.pass ? 'PASS' : 'FAIL'}`);
  if (meta.baseline) L.push(`  baseline:   ${meta.baseline}${meta.baselineSheet ? ` [${meta.baselineSheet}; ${meta.baselineLayout}]` : ''}`);
  if (meta.actual) L.push(`  eCW export: ${meta.actual}${meta.actualSheet ? ` [${meta.actualSheet}; ${meta.actualLayout}]` : ''}`);
  L.push(`  users: ${result.users.baseline} in baseline, ${result.users.ecw} in eCW, ${result.users.both} in both`);
  L.push(`  settings: ${result.permissions.baseline} in baseline, ${result.permissions.ecw} in eCW, ${result.permissions.both} in both${result.matches.length ? ` (${result.matches.length} paired by alias/name — see Matches)` : ''}`);
  L.push(`  compared ${result.compared} user/setting pairs: ${result.counts.ok} match`);
  L.push(`  findings: ${result.bySeverity.high} high, ${result.bySeverity.medium} medium, ${result.bySeverity.low} low, ${result.bySeverity.info} info`);
  if (result.catalog) { const c = result.catalog; L.push(`  catalog: ${meta.catalog || 'eCW settings catalog'} — ${c.total} settings, ${c.covered} covered by the baseline, ${c.grantedUncovered} not covered but granted to someone in eCW${c.unknown.length ? `, ${c.unknown.length} baseline name(s) not in the catalog` : ''}`); }
  const warn = [...(meta.baselineWarnings || []).map(w => `baseline: ${w}`), ...(meta.actualWarnings || []).map(w => `eCW export: ${w}`), ...(meta.catalogWarnings || []).map(w => `catalog: ${w}`)];
  if (warn.length) { L.push(''); L.push('  Check how the files were read:'); for (const w of warn) L.push(`   ! ${w}`); }
  const limit = meta.limit ?? 40;
  if (result.actions.length) {
    L.push(''); L.push('  What to do, per user:');
    let n = 0;
    for (const a of result.actions) {
      if (n++ >= limit) { L.push(`   … ${result.actions.length - limit} more users (see the report)`); break; }
      L.push(`   ${a.user}${a.status ? ` — ${a.status}` : ''}`);
      for (const p of a.remove) L.push(`     REMOVE  ${p}`);
      for (const p of a.grant) L.push(`     GRANT   ${p}`);
      for (const p of a.review) L.push(`     REVIEW  ${p}`);
    }
  }
  if (result.catalog?.unknown.length) { L.push(''); L.push('  Baseline settings the eCW catalog does not know (typo or renamed?):'); for (const u of result.catalog.unknown.slice(0, limit)) L.push(`   ? ${u.name}${u.suggestion ? `  → closest: "${u.suggestion}" (${u.group})` : ''}`); }
  const low = result.findings.filter(f => f.severity === 'low' && f.type.startsWith('permission'));
  if (low.length) { L.push(''); L.push(`  Coverage: ${low.length} setting/user pair(s) exist on only one side (low) — see the Findings sheet.`); const names = [...new Set(low.map(f => f.permission))]; L.push(`   ${names.slice(0, 6).join(' | ')}${names.length > 6 ? ' | …' : ''}`); }
  return L.join('\n');
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function findingsCsv(result) {
  const rows = [['severity', 'type', 'user', 'setting', 'expected', 'actual', 'note', 'baseline_row', 'ecw_row'], ...result.findings.map(f => [f.severity, f.type, f.user, f.permission, f.expected, f.actual, f.note, f.baselineRow ?? '', f.actualRow ?? ''])];
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
