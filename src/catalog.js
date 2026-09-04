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
import { normKey, clean, findHeaderRow, normalizeValue } from './parse.js';

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
export function detectCatalog(rows) { const c = detectCatalogLike(rows); return c && c.permission < 0 ? c : null; }

const PERMISSION_HEADERS = ['permission', 'permissions', 'granted', 'allowed', 'access', 'checked', 'enabled', 'value', 'yes no', 'y n', 'assigned', 'has access'];
/**
 * Catalog-shaped sheet: setting name + description/group (+ type), and optionally ONE permission
 * column — which is what eCW's per-ROLE Security Settings export looks like (the catalog columns,
 * plus the role's checkbox). Returns the column map with `permission` (−1 when absent) or null.
 */
export function detectCatalogLike(rows) {
  const hi = findHeaderRow(rows);
  const headers = (rows[hi] || []).map(clean);
  if (headers.filter(Boolean).length < 2 || headers.filter(Boolean).length > 7) return null;
  const taken = new Set();
  const name = find(headers, NAME_HEADERS, taken); if (name < 0) return null; taken.add(name);
  const desc = find(headers, DESC_HEADERS, taken); if (desc >= 0) taken.add(desc);
  const type = find(headers, TYPE_HEADERS, taken); if (type >= 0) taken.add(type);
  const group = find(headers, GROUP_HEADERS, taken); if (group >= 0) taken.add(group);
  if (desc < 0 && group < 0) return null;
  const permission = find(headers, PERMISSION_HEADERS, taken); if (permission >= 0) taken.add(permission);
  // Every named column must be one of these: any other column (a user, a role, a second value) makes
  // this a permission grid or list, not a catalog / role export.
  if (headers.some((h, i) => h !== '' && !taken.has(i))) return null;
  // Data rows must be text names, not Y/N.
  const body = rows.slice(hi + 1, hi + 30).filter(r => clean(r[name]) !== '');
  if (body.length < 1 || body.some(r => /^[yn]$/i.test(clean(r[name])))) return null;
  return { headerRow: hi, name, desc, type, group, permission };
}

/**
 * The role name an eCW per-role export carries, if any: a title line above the header ("Security
 * Settings — APPS Admin", "Role: Billing"), or nothing. eCW's Export to Excel writes none, so the
 * caller usually has to supply it.
 */
export function roleNameFromSheet(rows, cols) {
  for (let i = 0; i < cols.headerRow; i++) {
    const cells = (rows[i] || []).map(clean).filter(Boolean);
    if (cells.length !== 1) continue;
    const m = cells[0].match(/^(?:role|role name|security role)\s*[:\-–—]\s*(.+)$/i) || cells[0].match(/^security settings?\s*[:\-–—]\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * eCW's per-ROLE export → permission records for that role. With a Permission column, its value is the
 * grant; without one, every listed setting is read as granted (eCW lists what the role has) — the
 * warning says so, because that assumption is worth checking on a low-privilege role.
 */
export function extractRoleList(rows, role, cols = detectCatalogLike(rows), name = '') {
  if (!cols) throw new Error('not an eCW per-role security settings export (setting name / description / group, optionally a Permission column)');
  if (!role) throw new Error('the role this export belongs to is not stated in the file — pass it (--role "APPS Admin", or "APPS Admin=file.xlsx")');
  const out = [], warnings = [];
  const where = name ? `sheet "${name}"` : 'the sheet';
  let granted = 0, listed = 0;
  for (let i = cols.headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const setting = clean(r[cols.name]); if (!setting) continue;
    const group = cols.group >= 0 ? clean(r[cols.group]) : '';
    const raw = cols.permission >= 0 ? (r[cols.permission] === undefined ? '' : r[cols.permission]) : 'listed';
    const value = cols.permission >= 0 ? normalizeValue(raw) : 'Y';
    listed++; if (value === 'Y') granted++;
    out.push({ subject: role, permission: group && normKey(group) !== normKey(setting) ? `${group} > ${setting}` : setting, value, raw, sheet: name, row: i + 1, role, description: cols.desc >= 0 ? clean(r[cols.desc]) : '', listedOnly: cols.permission < 0 });   // listedOnly: absence from this list means NOT granted
  }
  if (cols.permission < 0) warnings.push(`${where}: no Permission column — all ${listed} listed settings were read as GRANTED to "${role}" (eCW lists what the role has). Check this once against a low-privilege role's export: it should be short.`);
  else warnings.push(`${where}: role "${role}": ${granted} of ${listed} settings granted`);
  return { records: out, warnings, role, listed, granted };
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
