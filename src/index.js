// Library entry point: one call from two files (or buffers) to a result + report, and `inspect`
// to see how a single file is read before comparing anything.
import fs from 'node:fs';
import path from 'node:path';
import { readSpreadsheet, buildXlsx } from './xlsx.js';
import { workbookToRecords, extractRecords, extractRoleMap, findHeaderRow, clean, normKey } from './parse.js';
import { lookup, bareName } from './catalog.js';
import { closest } from './validate.js';
import { compare } from './validate.js';
import { buildReport, textSummary, findingsCsv, reportSheets } from './report.js';
import { workbookToCatalog, detectCatalog, detectCatalogLike, extractCatalog, roleNameFromSheet } from './catalog.js';
import { documentSheets, buildEcwDocument } from './document.js';
import { buildSummaryPdf } from './pdf.js';
import { summaryDoc } from './summary.js';

export { documentSheets, buildEcwDocument, buildSummaryPdf, summaryDoc };
import { STYLE } from './xlsx.js';

export { workbookToCatalog, detectCatalog, extractCatalog };

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
 *   opts.baseline / opts.actual: per-file parse options ({ sheet, layout, subjectCol, permissionCol, valueCol, categoryCol, orientation, blankIsNo, rolesSheet,
 *                                ignoreSubjects (globs: role/user columns or rows to leave out), usersFile (a user → role file applied to a role-keyed baseline) })
 *   opts.compare: { ignoreUsers, ignorePermissions, onlyUsers, aliases, matchByName, reportUnknownPermissions, reportOk }
 *   opts.catalog: eCW's settings catalog — a file path or { name, data }, or an already-loaded catalog (optional)
 * Returns { result, meta, baseline: { sheet, layout, records, warnings }, actual: {...}, catalog }.
 */
export function validate(baseline, actual, opts = {}) {
  const load = (src, o, label) => {
    const wb = readAny(src, label);
    try { return { name: nameOf(src, label), ...workbookToRecords(wb, withUsersFile(o || {})) }; }
    catch (e) { throw new Error(`${label} (${nameOf(src, label)}): ${e.message}`); }
  };
  const b = load(baseline, opts.baseline, 'baseline');
  const a = loadActuals(actual, opts.actual, load);
  // A role-keyed baseline against per-role eCW exports needs no user list: drop that hint.
  if (a.kind === 'role-list') b.warnings = b.warnings.filter(w => !/columns look like ROLES/.test(w));
  if (!b.records.length) throw new Error(`baseline (${b.name}): no permission records found on sheet "${b.sheet}"`);
  if (!a.records.length) throw new Error(`eCW export (${a.name}): no permission records found on sheet "${a.sheet}"`);
  let cat = null;
  if (opts.catalog) { cat = opts.catalog.settings ? opts.catalog : loadCatalog(opts.catalog); }
  const result = compare(b.records, a.records, { ...(opts.compare || {}), catalog: cat });
  const meta = {
    ...(cat ? { catalog: path.basename(cat.name || 'catalog'), catalogSheet: cat.sheet, catalogWarnings: cat.warnings } : {}),
    when: new Date().toISOString(),
    baseline: path.basename(b.name), baselineSheet: b.sheet, baselineLayout: describeLayout(b), baselineWarnings: b.warnings,
    actual: path.basename(a.name), actualSheet: a.sheet, actualLayout: describeLayout(a), actualWarnings: a.warnings,
  };
  return { result, meta, baseline: b, actual: a, catalog: cat };
}

/**
 * The eCW side: one file, or several — eCW exports security settings one ROLE at a time, so a full
 * picture is one file per role. Each entry is a path / { name, data }, or { src, role } to name the
 * role the file belongs to (`"APPS Admin=file.xlsx"` on the command line). The records are merged;
 * sheet, layout and warnings are reported per file.
 */
function loadActuals(actual, o, load) {
  const list = Array.isArray(actual) ? actual : [actual];
  if (!list.length) throw new Error('eCW export: no file given');
  const parts = list.map((entry, i) => {
    const src = entry && typeof entry === 'object' && 'src' in entry ? entry.src : entry;
    const role = entry && typeof entry === 'object' && entry.role ? String(entry.role) : (list.length === 1 ? o?.role : undefined);
    const label = list.length === 1 ? 'eCW export' : `eCW export ${i + 1}`;
    const x = load(src, { ...(o || {}), role }, label);
    if (!x.records.length) throw new Error(`${label} (${x.name}): no permission records found on sheet "${x.sheet}"`);
    return x;
  });
  if (parts.length === 1) return parts[0];
  const roles = parts.map(p => p.role).filter(Boolean);
  const dup = roles.filter((r, i) => roles.findIndex(x => normKey(x) === normKey(r)) !== i);
  const warnings = parts.flatMap(p => p.warnings.map(w => `${path.basename(p.name)}: ${w}`));
  if (dup.length) warnings.push(`the same role appears in more than one file: ${[...new Set(dup)].join(', ')} — the later file wins`);
  const kinds = new Set(parts.map(p => p.kind || p.layout.layout));
  return { name: parts.map(p => path.basename(p.name)).join(' + '), sheet: parts.map(p => `${path.basename(p.name)}:${p.sheet}`).join(', '), sheets: parts.flatMap(p => p.sheets), layout: { layout: 'multi', kinds: [...kinds] }, kind: kinds.size === 1 ? parts[0].kind : 'mixed', records: parts.flatMap(p => p.records), roleMap: null, expanded: false, warnings, ignoredSheets: [], files: parts.map(p => ({ name: path.basename(p.name), sheet: p.sheet, role: p.role || '', records: p.records.length, readAs: describeLayout(p), warnings: p.warnings })) };
}

/** A user → role file (User | Role columns; .csv or .xlsx) for a baseline whose columns are roles. Returns a Map (see extractRoleMap). */
export function loadUsersFile(src) {
  const wb = readAny(src, 'users file');
  for (const s of wb.sheets) { const m = extractRoleMap(s.rows); if (m) return m; }
  throw new Error(`users file (${nameOf(src, 'users file')}): needs a User column and a Role column`);
}
const withUsersFile = o => { if (!o.usersFile) return o; const roleMap = o.usersFile instanceof Map ? o.usersFile : loadUsersFile(o.usersFile); return { ...o, roleMap, roleMapName: typeof o.usersFile === 'string' ? path.basename(o.usersFile) : (o.usersFile?.name || 'users file') }; };

/**
 * Document what eCW has, with no baseline: load the eCW export(s) (one per role) and build the
 * inventory workbook. Returns { actual, catalog, sheets, xlsx }.
 */
export function documentEcw(actual, opts = {}) {
  const load = (src, o, label) => { const wb = readAny(src, label); try { return { name: nameOf(src, label), ...workbookToRecords(wb, o || {}) }; } catch (e) { throw new Error(`${label} (${nameOf(src, label)}): ${e.message}`); } };
  const a = loadActuals(actual, opts.actual, load);
  const cat = opts.catalog ? (opts.catalog.settings ? opts.catalog : loadCatalog(opts.catalog)) : null;
  const sheets = documentSheets(a, { catalog: cat });
  return { actual: a, catalog: cat, sheets, xlsx: buildXlsx(sheets) };
}

/** Load eCW's settings catalog from a file path or { name, data }. */
export function loadCatalog(src) {
  const wb = readAny(src, 'catalog');
  try { return { name: nameOf(src, 'catalog'), ...workbookToCatalog(wb) }; } catch (e) { throw new Error(`catalog (${nameOf(src, 'catalog')}): ${e.message}`); }
}

export const describeLayout = x => x.layout.layout === 'role-list' ? `eCW per-role export for "${x.role}"${x.layout.valueCol >= 0 ? ' (Permission column)' : ' (listed = granted)'}` : x.layout.layout === 'multi' ? `${x.files?.length || 0} files${x.kind === 'role-list' ? ', one eCW per-role export each' : ''}` : x.layout.layout === 'long' ? 'one row per user + setting' : `grid, ${x.layout.orientation === 'permissions-down' ? 'settings down / roles across' : 'roles down / settings across'}${x.expanded ? '; roles expanded to users' : ''}`;

/**
 * How a single file is read: its sheets, the chosen sheet and layout, the users, settings and values
 * found, warnings, and a preview of the raw rows — so a person can confirm the file was understood
 * before trusting a comparison. Never throws for a readable file: a parse problem is reported in `error`.
 */
export function inspect(src, opts = {}, label = 'file') {
  const wb = readAny(src, label);
  const sheets = wb.sheets.map(s => ({ name: s.name, rows: s.rows.length, cols: Math.max(0, ...s.rows.map(r => r.length)), headerRow: findHeaderRow(s.rows) + 1, headers: (s.rows[findHeaderRow(s.rows)] || []).map(clean).slice(0, 40), preview: s.rows.slice(0, 12).map(r => r.slice(0, 12).map(c => c === undefined ? '' : c)) }));
  const out = { name: path.basename(nameOf(src, label)), sheets, error: null, kind: 'permissions' };
  const catSheet = !opts.layout && !opts.subjectCol && !opts.role && wb.sheets.find(sh => detectCatalog(sh.rows) && !roleNameFromSheet(sh.rows, detectCatalog(sh.rows)));
  if (catSheet) {
    const c = extractCatalogSafe(catSheet.rows);
    if (c) {
      const groups = [...c.groups].map(([group, n]) => ({ group, settings: n })).sort((a, b) => b.settings - a.settings);
      out.roleExportPossible = true; out.hasPermissionColumn = false;
      return Object.assign(out, { kind: 'catalog', sheet: catSheet.name, sheetsUsed: [catSheet.name], readAs: 'eCW security settings catalog (setting name, description, type, group) — no users, no grants', records: c.settings.length, settings: c.settings.map(s => ({ name: s.name, group: s.group })), groups, users: [], values: [], warnings: [...c.warnings, 'this file has the catalog columns and names no role: as the CATALOG it is the list of settings eCW knows; as an eCW per-ROLE export (Security Settings → pick a role → Export to Excel) it needs the role name — give it, and every listed setting is read as granted to that role'], sample: c.settings.slice(0, 10).map(s => ({ user: '', setting: s.name, value: s.group, raw: s.description, row: s.row, sheet: catSheet.name })) });
    }
  }
  try {
    const x = workbookToRecords(wb, withUsersFile(opts));
    const users = new Map(), settings = new Map(), values = new Map();
    for (const r of x.records) { users.set(r.subject, (users.get(r.subject) || 0) + 1); settings.set(r.permission, (settings.get(r.permission) || 0) + 1); values.set(r.value, (values.get(r.value) || 0) + 1); }
    Object.assign(out, {
      kind: x.kind === 'role-list' ? 'role-list' : 'permissions', role: x.role || '',
      sheet: x.sheet, sheetsUsed: x.sheets, ignoredSheets: x.ignoredSheets, layout: x.layout, readAs: describeLayout(x), expanded: x.expanded, roleMap: x.roleMap, warnings: x.warnings,
      records: x.records.length,
      users: [...users].map(([name, n]) => ({ name, settings: n, role: x.roleMap?.[name] || '' })),
      settings: [...settings].map(([name, n]) => ({ name, users: n })),
      values: [...values].map(([value, n]) => ({ value: value || '(blank)', count: n })).sort((a, b) => b.count - a.count),
      sample: x.records.slice(0, 10).map(r => ({ user: r.subject, setting: r.permission, value: r.value, raw: r.raw, row: r.row, sheet: r.sheet })),
    });
    if (opts.catalog) out.catalogCheck = catalogCheck(x.records, opts.catalog.settings ? opts.catalog : loadCatalog(opts.catalog));
  } catch (e) { out.error = e.message; out.warnings = []; }
  return out;
}

/** Which of a file's setting names the catalog knows, which it does not (with the closest real name), and which catalog settings the file never mentions. */
export function catalogCheck(records, cat) {
  const names = new Map(); for (const r of records) if (!names.has(normKey(r.permission))) names.set(normKey(r.permission), r.permission);
  const catNames = new Map([...cat.byKey].map(([k, v]) => [k, v.name]));
  const unknown = [], known = new Set();
  for (const [k, name] of names) { const c = lookup(cat, name); if (c) known.add(normKey(c.name)); else { const near = closest(normKey(bareName(cat, name)), catNames, 0.6); unknown.push({ name, suggestion: near?.name || '', group: near ? cat.byKey.get(near.key)?.group || '' : '' }); } }
  const uncovered = cat.settings.filter(s => !known.has(normKey(s.name))).map(s => ({ name: s.name, group: s.group }));
  return { catalog: cat.name ? path.basename(cat.name) : 'catalog', total: cat.settings.length, known: known.size, unknown, uncovered };
}

const extractCatalogSafe = rows => { try { return extractCatalog(rows); } catch { return null; } };

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
    else if (/\.pdf$/i.test(out)) fs.writeFileSync(out, buildSummaryPdf(v.result, v.meta));
    else if (/\.json$/i.test(out)) fs.writeFileSync(out, JSON.stringify({ meta: v.meta, ...v.result }, null, 2));
    else fs.writeFileSync(out, buildReport(v.result, v.meta));
  }
  return v;
}

/**
 * A baseline TEMPLATE built from the catalog: one row per setting (group, name, what it controls)
 * with a blank column per role (or user) to fill in with Y/N, plus a Users sheet for the user → role
 * mapping and a How-to sheet. The practice fills it in; the validator reads it back as a baseline.
 */
export function buildTemplate(catalog, { roles = ['Provider', 'Nurse', 'Front Desk', 'Biller', 'Practice Admin'], groups = null } = {}) {
  const cat = catalog.settings ? catalog : loadCatalog(catalog);
  const keep = groups ? new Set(groups.map(normKey)) : null;
  const rows = [['Category', 'Security Setting', 'What it controls', ...roles]];
  for (const s of [...cat.settings].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))) { if (keep && !keep.has(normKey(s.group))) continue; rows.push([s.group, s.name, s.description, ...roles.map(() => '')]); }
  const users = [['User', 'Role'], ['', roles[0]]];
  const howto = [['How to fill in this baseline'], [''], ['Permissions sheet', `One row per eCW security setting, grouped by the catalog's group. Put Y in a role's column when that role should have the setting, N (or leave blank) when it should not. Delete rows you do not care about, or leave them: a blank row means "not granted".`], ['Users sheet', 'One row per eCW login: the user name exactly as eCW shows it, and the role whose column applies. The validator expands each role to its users.'], ['Then', 'ecw-validate validate --baseline this-file.xlsx --actual <per-user export from eCW> --catalog <this catalog> --out report.xlsx'], ['Roles', 'Rename or add role columns freely; the Users sheet must use the same names.']];
  return buildXlsx([
    { name: 'Permissions', rows, widths: [30, 50, 70, ...roles.map(() => 14)], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 2 ? STYLE.wrap : 0) },
    { name: 'Users', rows: users, widths: [24, 20] },
    { name: 'How to', rows: howto, widths: [22, 120], freeze: false, styles: (r, c) => (r === 0 ? STYLE.header : c === 1 ? STYLE.wrap : 0) },
  ]);
}
