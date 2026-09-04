// Library entry point: one call from two files (or buffers) to a result + report, and `inspect`
// to see how a single file is read before comparing anything.
import fs from 'node:fs';
import path from 'node:path';
import { readSpreadsheet, buildXlsx } from './xlsx.js';
import { workbookToRecords, extractRecords, findHeaderRow, clean } from './parse.js';
import { compare } from './validate.js';
import { buildReport, textSummary, findingsCsv, reportSheets } from './report.js';

export { readSpreadsheet, buildXlsx, workbookToRecords, compare, buildReport, textSummary, findingsCsv, reportSheets };
export * from './parse.js';
export { perUser, actions, similarity, closest, SEVERITY, TYPE_LABEL } from './validate.js';

const nameOf = (src, label) => typeof src === 'string' ? src : (src?.name || label);
function readAny(src, label) {
  try { return typeof src === 'string' ? readSpreadsheet(src) : readSpreadsheet(src.data, src.name || ''); }
  catch (e) { throw new Error(`${label} (${nameOf(src, label)}): ${e.message}`); }
}

/**
 * Validate an eCW export against a baseline.
 *   baseline / actual: a file path, or { name, data: Buffer }
 *   opts.baseline / opts.actual: per-file parse options ({ sheet, layout, subjectCol, permissionCol, valueCol, categoryCol, orientation, blankIsNo, rolesSheet })
 *   opts.compare: { ignoreUsers, ignorePermissions, onlyUsers, aliases, matchByName, reportUnknownPermissions, reportOk }
 * Returns { result, meta, baseline: { sheet, layout, records, warnings }, actual: {...} }.
 */
export function validate(baseline, actual, opts = {}) {
  const load = (src, o, label) => {
    const wb = readAny(src, label);
    try { return { name: nameOf(src, label), ...workbookToRecords(wb, o || {}) }; }
    catch (e) { throw new Error(`${label} (${nameOf(src, label)}): ${e.message}`); }
  };
  const b = load(baseline, opts.baseline, 'baseline');
  const a = load(actual, opts.actual, 'eCW export');
  if (!b.records.length) throw new Error(`baseline (${b.name}): no permission records found on sheet "${b.sheet}"`);
  if (!a.records.length) throw new Error(`eCW export (${a.name}): no permission records found on sheet "${a.sheet}"`);
  const result = compare(b.records, a.records, opts.compare || {});
  const meta = {
    when: new Date().toISOString(),
    baseline: path.basename(b.name), baselineSheet: b.sheet, baselineLayout: describeLayout(b), baselineWarnings: b.warnings,
    actual: path.basename(a.name), actualSheet: a.sheet, actualLayout: describeLayout(a), actualWarnings: a.warnings,
  };
  return { result, meta, baseline: b, actual: a };
}

export const describeLayout = x => x.layout.layout === 'long' ? 'one row per user + setting' : `grid, ${x.layout.orientation === 'permissions-down' ? 'settings down / users across' : 'users down / settings across'}${x.expanded ? '; roles expanded to users' : ''}`;

/**
 * How a single file is read: its sheets, the chosen sheet and layout, the users, settings and values
 * found, warnings, and a preview of the raw rows — so a person can confirm the file was understood
 * before trusting a comparison. Never throws for a readable file: a parse problem is reported in `error`.
 */
export function inspect(src, opts = {}, label = 'file') {
  const wb = readAny(src, label);
  const sheets = wb.sheets.map(s => ({ name: s.name, rows: s.rows.length, cols: Math.max(0, ...s.rows.map(r => r.length)), headerRow: findHeaderRow(s.rows) + 1, headers: (s.rows[findHeaderRow(s.rows)] || []).map(clean).slice(0, 40), preview: s.rows.slice(0, 12).map(r => r.slice(0, 12).map(c => c === undefined ? '' : c)) }));
  const out = { name: path.basename(nameOf(src, label)), sheets, error: null };
  try {
    const x = workbookToRecords(wb, opts);
    const users = new Map(), settings = new Map(), values = new Map();
    for (const r of x.records) { users.set(r.subject, (users.get(r.subject) || 0) + 1); settings.set(r.permission, (settings.get(r.permission) || 0) + 1); values.set(r.value, (values.get(r.value) || 0) + 1); }
    Object.assign(out, {
      sheet: x.sheet, sheetsUsed: x.sheets, ignoredSheets: x.ignoredSheets, layout: x.layout, readAs: describeLayout(x), expanded: x.expanded, roleMap: x.roleMap, warnings: x.warnings,
      records: x.records.length,
      users: [...users].map(([name, n]) => ({ name, settings: n, role: x.roleMap?.[name] || '' })),
      settings: [...settings].map(([name, n]) => ({ name, users: n })),
      values: [...values].map(([value, n]) => ({ value: value || '(blank)', count: n })).sort((a, b) => b.count - a.count),
      sample: x.records.slice(0, 10).map(r => ({ user: r.subject, setting: r.permission, value: r.value, raw: r.raw, row: r.row, sheet: r.sheet })),
    });
  } catch (e) { out.error = e.message; out.warnings = []; }
  return out;
}

/**
 * Aliases from a file: two columns (baseline name, eCW name) with an optional first column "user" /
 * "setting" (default setting); .csv or .xlsx. Returns { settings: {...}, users: {...} }.
 */
export function loadAliases(src) {
  const wb = readAny(src, 'aliases');
  const out = { settings: {}, users: {} };
  for (const s of wb.sheets) for (const r of s.rows) {
    const cells = r.map(clean).filter(Boolean);
    if (cells.length < 2) continue;
    if (/^(baseline|from|old)$/i.test(cells[0]) || /^(kind|type)$/i.test(cells[0])) continue;   // header row
    const kind = cells.length >= 3 && /^(user|users|setting|settings|permission)$/i.test(cells[0]) ? (/^user/i.test(cells[0]) ? 'users' : 'settings') : 'settings';
    const [from, to] = cells.length >= 3 && kind ? cells.slice(1, 3) : cells.slice(0, 2);
    if (cells.length >= 3 && !/^(user|users|setting|settings|permission)$/i.test(cells[0])) { out.settings[cells[0]] = cells[1]; continue; }
    out[kind][from] = to;
  }
  return out;
}

/** Validate and write the report file(s). out may end in .xlsx, .csv or .json. */
export function validateToFile(baseline, actual, out, opts = {}) {
  const v = validate(baseline, actual, opts);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    if (/\.csv$/i.test(out)) fs.writeFileSync(out, findingsCsv(v.result));
    else if (/\.json$/i.test(out)) fs.writeFileSync(out, JSON.stringify({ meta: v.meta, ...v.result }, null, 2));
    else fs.writeFileSync(out, buildReport(v.result, v.meta));
  }
  return v;
}
