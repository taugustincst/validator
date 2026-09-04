// eCW's security settings CATALOG: the export from Admin → Security Settings that lists every
// security attribute the system knows — name, description, type ("Old" = classic attribute) and
// group — but no users and no grants. A real file has ~1,100 rows and looks like:
//
//   Security Setting Name | Security Setting Description | Security Setting Type | Security group Name
//   Delete Payments       | Grants or denies users …     | Old                   | Administration / Billing Setup
//
// It is not a per-user export, so it cannot be compared, but it is the dictionary the comparison
// should be checked against: a baseline setting that is not in the catalog is a typo or a renamed
// item; a catalog setting the baseline never mentions is a coverage gap; and every finding can
// carry the setting's group and what it actually controls.
import { normKey, clean, findHeaderRow, VALUE_HEADERS, SUBJECT_HEADERS } from './parse.js';

const NAME_HEADERS = ['security setting name', 'setting name', 'security setting', 'security attribute', 'attribute name', 'attribute', 'name', 'setting', 'permission', 'permission name', 'item', 'item name'];
const DESC_HEADERS = ['security setting description', 'description', 'setting description', 'attribute description', 'what it controls', 'what it does', 'details', 'help'];
const TYPE_HEADERS = ['security setting type', 'setting type', 'type', 'attribute type'];
const GROUP_HEADERS = ['security group name', 'group name', 'security group', 'group', 'category', 'module', 'section'];

const find = (headers, list, taken = new Set()) => { let best = -1, score = 0; headers.forEach((h, i) => { if (taken.has(i)) return; const k = normKey(h); if (!k) return; const s = list.includes(k) ? 2 : (k.length >= 4 && list.some(l => l.length >= 4 && (` ${k} `.includes(` ${l} `) || ` ${l} `.includes(` ${k} `)))) ? 1 : 0; if (s > score) { score = s; best = i; } }); return score ? best : -1; };

/**
 * Is this sheet a settings catalog? Returns the column map or null. A catalog has a setting-name
 * column and a description or group column, at most six columns, and NO value column and NO user
 * column — that is what separates it from a permission grid or list.
 */
export function detectCatalog(rows) {
  const hi = findHeaderRow(rows);
  const headers = (rows[hi] || []).map(clean);
  if (headers.filter(Boolean).length < 2 || headers.filter(Boolean).length > 6) return null;
  if (find(headers, VALUE_HEADERS) >= 0) return null;
  const taken = new Set();
  const name = find(headers, NAME_HEADERS, taken); if (name < 0) return null; taken.add(name);
  const desc = find(headers, DESC_HEADERS, taken); if (desc >= 0) taken.add(desc);
  const type = find(headers, TYPE_HEADERS, taken); if (type >= 0) taken.add(type);
  const group = find(headers, GROUP_HEADERS, taken); if (group >= 0) taken.add(group);
  if (desc < 0 && group < 0) return null;
  // Every named column must be one of the four: any other column (a user, a role, a value) makes this a
  // permission sheet, not a catalog.
  if (headers.some((h, i) => h !== '' && !taken.has(i))) return null;
  // Data rows must be text names, not Y/N.
  const body = rows.slice(hi + 1, hi + 30).filter(r => clean(r[name]) !== '');
  if (body.length < 3 || body.some(r => /^[yn]$/i.test(clean(r[name])))) return null;
  return { headerRow: hi, name, desc, type, group };
}

/** Parse a catalog sheet into { settings: [{ name, description, type, group, row }], groups: Map(group → count) }. */
export function extractCatalog(rows, cols = detectCatalog(rows)) {
  if (!cols) throw new Error('not a security settings catalog (needs a setting-name column plus a description or group column, and no user/value columns)');
  const settings = [], groups = new Map(), byKey = new Map();
  const warnings = [];
  let dups = 0;
  for (let i = cols.headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = clean(r[cols.name]); if (!name) continue;
    const s = { name, description: cols.desc >= 0 ? clean(r[cols.desc]) : '', type: cols.type >= 0 ? clean(r[cols.type]) : '', group: cols.group >= 0 ? clean(r[cols.group]) : '', row: i + 1 };
    const k = normKey(name);
    if (byKey.has(k)) { dups++; continue; }
    byKey.set(k, s); settings.push(s);
    groups.set(s.group, (groups.get(s.group) || 0) + 1);
  }
  if (dups) warnings.push(`${dups} setting name(s) appear more than once in the catalog; the first occurrence is used`);
  return { settings, groups, byKey, warnings };
}

/** Read a catalog from a workbook: the first sheet that is one. */
export function workbookToCatalog(wb, opts = {}) {
  const sheets = wb.sheets || [];
  const pick = opts.sheet ? sheets.filter(s => normKey(s.name) === normKey(opts.sheet)) : sheets;
  for (const s of pick) { const cols = detectCatalog(s.rows); if (cols) return { sheet: s.name, ...extractCatalog(s.rows, cols) }; }
  throw new Error(`no security settings catalog found${opts.sheet ? ` on sheet "${opts.sheet}"` : ''} (sheets: ${sheets.map(s => s.name).join(', ')})`);
}

/**
 * Look a permission name up in the catalog: the whole name first, then with leading "Group >"
 * segments stripped one at a time — a setting's own name may contain ">" ("Allow access to
 * Billing window > Done Button"), so the prefix is peeled from the left, never split from the right.
 */
export function lookup(cat, permission) {
  if (!cat) return null;
  const parts = String(permission ?? '').split('>');
  for (let i = 0; i < parts.length; i++) {
    const k = normKey(parts.slice(i).join('>'));
    if (k && cat.byKey.has(k)) return cat.byKey.get(k);
  }
  return null;
}
/** The setting's own name, with a leading "Group >" prefix removed when the catalog says so; otherwise the name unchanged. */
export const bareName = (cat, permission) => { const c = lookup(cat, permission); if (c) return c.name; const i = String(permission).indexOf('>'); return i >= 0 ? String(permission).slice(i + 1).trim() : String(permission); };
