// Documenting what eCW has: the per-role exports turned into one inventory workbook, with no
// baseline involved — settings down, roles across, X where the role holds the setting, plus the
// group and eCW's own description of each setting (from the exports, or the catalog when given).
//
//   eCW matrix   Group | Security setting | What it controls | <one column per role> | Roles holding it
//   Roles        role, source file, settings held, of how many
//   Settings     one row per setting with the roles that hold it, spelled out
//   Source       when, which files, how each was read, notes
import { buildXlsx, STYLE } from './xlsx.js';
import { normKey, isGranted } from './parse.js';
import { lookup } from './catalog.js';

/** Build the inventory sheets from eCW records (subject = role). `actual` is what validate() loaded for the eCW side. */
export function documentSheets(actual, { catalog = null, when = new Date().toISOString() } = {}) {
  const records = actual.records || [];
  const roles = [];   // in file order
  const roleKey = new Map();
  for (const r of records) { const k = normKey(r.subject); if (!roleKey.has(k)) { roleKey.set(k, r.subject); roles.push(r.subject); } }
  // settings: union of the exports (and the catalog), keyed by bare name
  const settings = new Map();   // key → { name, group, description, held: Map(roleKey → value) }
  const keyOf = perm => { const c = lookup(catalog, perm); if (c) return normKey(c.name); const i = String(perm).indexOf('>'); return normKey(i >= 0 ? String(perm).slice(i + 1) : perm); };
  const nameOf = perm => { const c = lookup(catalog, perm); if (c) return c.name; const i = String(perm).indexOf('>'); return (i >= 0 ? String(perm).slice(i + 1) : String(perm)).trim(); };
  const groupOf = perm => { const c = lookup(catalog, perm); if (c) return c.group; const i = String(perm).indexOf('>'); return i >= 0 ? String(perm).slice(0, i).trim() : ''; };
  if (catalog) for (const c of catalog.settings) settings.set(normKey(c.name), { name: c.name, group: c.group, description: c.description, held: new Map(), inCatalog: true });
  for (const r of records) {
    const k = keyOf(r.permission);
    if (!settings.has(k)) settings.set(k, { name: nameOf(r.permission), group: groupOf(r.permission), description: r.description || lookup(catalog, r.permission)?.description || '', held: new Map(), inCatalog: !!lookup(catalog, r.permission) });
    const s = settings.get(k);
    if (!s.description && r.description) s.description = r.description;
    s.held.set(normKey(r.subject), r.value);
  }
  const list = [...settings.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  const rk = roles.map(normKey);
  const cell = v => v === undefined ? '' : v === 'Y' ? 'X' : v === 'N' ? '' : v;   // a level ("read only") is written as is
  const matrix = [['Group', 'Security setting', 'What it controls', ...roles, 'Roles holding it', ...(catalog ? ['In catalog'] : [])]];
  const style = [];
  for (const s of list) {
    const held = rk.filter(k => isGranted(s.held.get(k) ?? 'N')).length;
    matrix.push([s.group, s.name, s.description, ...rk.map(k => cell(s.held.get(k))), held, ...(catalog ? [s.inCatalog ? 'Y' : 'N'] : [])]);
    style.push(rk.map(k => { const v = s.held.get(k); return v === undefined ? 0 : isGranted(v) ? STYLE.green : 0; }));
  }
  const rolesSheet = [['Role', 'Source file', 'Settings held', 'Of settings listed', 'How it was read'], ...roles.map((role, i) => { const k = rk[i]; const listed = records.filter(r => normKey(r.subject) === k); const f = (actual.files || []).find(f => normKey(f.role) === k); return [role, f ? f.name : (actual.name || ''), listed.filter(r => isGranted(r.value)).length, listed.length, f ? f.readAs : (actual.readAs || '')]; })];
  const settingsSheet = [['Group', 'Security setting', 'What it controls', 'Held by', 'Roles'], ...list.map(s => { const who = roles.filter((_, i) => isGranted(s.held.get(rk[i]) ?? 'N')); return [s.group, s.name, s.description, who.length, who.join(', ')]; })];
  const source = [['eCW security settings — documented from eCW\'s exports', ''], ['Documented at', when], ['Roles', roles.length], ['Settings', list.length], ['Catalog', catalog ? `${catalog.name ? catalog.name.replace(/^.*[\\/]/, '') : 'catalog'} (${catalog.settings.length} settings)` : 'none — groups and descriptions come from the exports'], [],
    ['How to read this', 'The eCW matrix sheet is what eCW grants today, in the same shape as a master matrix: settings down, roles across, X where the role holds the setting. Compare it with your master matrix, or adopt it as the new master after review.'], [],
    ['Files', ''], ...(actual.files || [{ name: actual.name, role: '', records: records.length, readAs: actual.readAs }]).map(f => [f.name, `${f.role ? `role "${f.role}" — ` : ''}${f.records} records, ${f.readAs}`]), [],
    ...(actual.warnings?.length ? [['Notes', ''], ...actual.warnings.map(w => ['', w])] : [])];
  return [
    { name: 'eCW matrix', rows: matrix, widths: [28, 46, 60, ...roles.map(() => 12), 10, ...(catalog ? [8] : [])], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 2 ? STYLE.wrap : c >= 3 && c < 3 + roles.length ? style[r - 1][c - 3] : 0) },
    { name: 'Roles', rows: rolesSheet, widths: [30, 36, 12, 14, 50], autofilter: true },
    { name: 'Settings', rows: settingsSheet, widths: [28, 46, 60, 8, 80], autofilter: true, styles: (r, c) => (r === 0 ? STYLE.header : c === 2 || c === 4 ? STYLE.wrap : 0) },
    { name: 'Source', rows: source, widths: [30, 100], freeze: false, styles: (r, c) => (r === 0 || (c === 0 && source[r]?.length === 2 && source[r][1] === '') ? STYLE.header : c === 1 ? STYLE.wrap : 0) },
  ];
}

export const buildEcwDocument = (actual, opts) => buildXlsx(documentSheets(actual, opts));
