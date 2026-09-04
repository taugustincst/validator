// Turn a spreadsheet — whatever its layout — into a flat list of permission records:
//   { subject, permission, value, raw, sheet, row }
// `subject` is a user (or a role, in a role-based baseline); `permission` is the security setting
// name (with its category prefixed when the sheet has one); `value` is the normalized value
// (see normalizeValue) and `raw` what the cell actually said.
//
// Two layouts are recognized automatically:
//   • LONG  — one row per (user, setting): columns like User | Category | Security Setting | Value.
//             This is what eCW's "Security Settings" / "User Security Settings" report exports.
//   • MATRIX — a grid: settings down the first column and users across the header (or the other way
//             round), Y/N or ✓ in the cells. This is how most practices keep their baseline.
// Detection is by header names first (see the *_HEADERS lists) and falls back on shape; both can
// be overridden with explicit options ({ layout, subjectCol, permissionCol, valueCol, categoryCol,
// orientation }).

export const SUBJECT_HEADERS = ['user', 'username', 'user name', 'userid', 'user id', 'login', 'login id', 'login name', 'staff', 'staff name', 'employee', 'employee name', 'provider', 'provider name', 'name', 'account', 'role', 'role name', 'security role', 'group', 'job title', 'title'];
export const PERMISSION_HEADERS = ['permission', 'permissions', 'security setting', 'security settings', 'setting', 'settings', 'item', 'item name', 'privilege', 'right', 'rights', 'access right', 'feature', 'function', 'option', 'security item', 'security option', 'menu item', 'description'];
export const VALUE_HEADERS = ['value', 'access', 'allowed', 'allow', 'granted', 'grant', 'permitted', 'enabled', 'status', 'setting value', 'y/n', 'yes/no', 'assigned', 'has access', 'checked', 'selected', 'level', 'access level'];
export const CATEGORY_HEADERS = ['category', 'module', 'section', 'group name', 'area', 'menu', 'tab', 'security group', 'setting group', 'folder'];

export const normKey = s => String(s ?? '').toLowerCase().normalize('NFKC').replace(/[‘’“”]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
export const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

const TRUE = new Set(['y', 'yes', 'true', '1', 'x', '✓', '✔', '☑', 'check', 'checked', 'allow', 'allowed', 'grant', 'granted', 'on', 'enabled', 'enable', 'permitted', 'permit', 'full', 'full access', 'access', 'assigned', 'active', 'ok', 'a']);
const FALSE = new Set(['n', 'no', 'false', '0', '', '-', '—', '–', 'x-', '✗', '✘', '☐', 'unchecked', 'deny', 'denied', 'none', 'no access', 'off', 'disabled', 'disable', 'not allowed', 'not permitted', 'revoke', 'revoked', 'unassigned', 'inactive', 'null', 'n/a', 'n a', 'na', 'blank', 'd']);

/** Normalize a cell to 'Y', 'N' or a lowercase custom level ('read only', 'view', ...). */
export function normalizeValue(raw) {
  if (raw === true) return 'Y';
  if (raw === false) return 'N';
  if (typeof raw === 'number') return raw ? 'Y' : 'N';
  const k = normKey(raw).replace(/^\s*[☑✓✔]\s*$/, 'y');
  const s = String(raw ?? '').trim();
  if (TRUE.has(k) || TRUE.has(s)) return 'Y';
  if (FALSE.has(k) || FALSE.has(s)) return 'N';
  return k;   // a level such as "read only" — compared as text
}
export const isGranted = v => v !== 'N' && v !== '';

/** 2 = a known column name, 1 = contains one as whole words ("eCW User Name", "Setting Description"), 0 = no. Short cells ("Y") never match. */
const wordIn = (a, b) => (' ' + a + ' ').includes(' ' + b + ' ');
const headerScore = (h, list) => { const k = normKey(h); if (!k) return 0; if (list.includes(k)) return 2; if (k.length < 4) return 0; return list.some(l => l.length >= 4 && (wordIn(k, l) || wordIn(l, k))) ? 1 : 0; };
const bestCol = (headers, list, taken) => { let best = -1, score = 0; headers.forEach((h, i) => { if (taken.has(i)) return; const s = headerScore(h, list); if (s > score) { score = s; best = i; } }); return score ? best : -1; };

/**
 * Find the header row. Title lines ("eClinicalWorks — User Security Settings", "Printed: …") sit above
 * the real header in eCW exports, so pick the row that looks most like one: known column names count
 * most, then width, and the row below it must carry data.
 */
export function findHeaderRow(rows, max = 20) {
  let best = 0, bestScore = -1;
  // A cell that reads as a Y/N value, or is a lone character, is data, not a column name.
  const labelLike = c => { const k = normKey(c); return k.length >= 2 && !TRUE.has(k) && !FALSE.has(k) && !TRUE.has(String(c).trim()) && !FALSE.has(String(c).trim()); };
  const known = h => Math.max(headerScore(h, SUBJECT_HEADERS), headerScore(h, PERMISSION_HEADERS), headerScore(h, VALUE_HEADERS), headerScore(h, CATEGORY_HEADERS));
  for (let i = 0; i < Math.min(rows.length, max); i++) {
    const r = rows[i] || [];
    const texts = r.filter(c => clean(c) !== '' && labelLike(c));
    if (texts.length < 2) continue;
    const next = rows[i + 1] || [];
    const dataBelow = next.filter(c => clean(c) !== '').length >= 2;
    const score = texts.reduce((a, c) => a + known(c), 0) * 10 + Math.min(texts.length, 8) + (dataBelow ? 5 : 0) - i * 0.01;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** Decide how a sheet is laid out. Returns { layout: 'long'|'matrix', ...columns } */
export function detectLayout(rows, opts = {}) {
  const hi = opts.headerRow ?? findHeaderRow(rows);
  const headers = (rows[hi] || []).map(clean);
  const taken = new Set();
  const col = (name, list) => { const explicit = opts[name]; if (explicit != null && explicit !== '') { const i = typeof explicit === 'number' ? explicit : headers.findIndex(h => normKey(h) === normKey(explicit)); if (i < 0) throw new Error(`column "${explicit}" not found in header row: ${headers.join(' | ')}`); taken.add(i); return i; } const i = bestCol(headers, list, taken); if (i >= 0) taken.add(i); return i; };
  const subjectCol = col('subjectCol', SUBJECT_HEADERS);
  const permissionCol = col('permissionCol', PERMISSION_HEADERS);
  const valueCol = col('valueCol', VALUE_HEADERS);
  const categoryCol = col('categoryCol', CATEGORY_HEADERS);
  // Long needs all three columns. A wide sheet whose "user" column is really a role header ("Provider")
  // is a matrix unless every one of the three is an exact, known column name.
  const found = subjectCol >= 0 && permissionCol >= 0 && valueCol >= 0;
  const exact = found && [subjectCol, permissionCol, valueCol].every(i => headerScore(headers[i], i === subjectCol ? SUBJECT_HEADERS : i === permissionCol ? PERMISSION_HEADERS : VALUE_HEADERS) === 2);
  const width = headers.filter(h => h !== '').length;
  const layout = opts.layout || (found && (exact || width <= 6) ? 'long' : 'matrix');
  if (layout === 'long') {
    if (subjectCol < 0 || permissionCol < 0 || valueCol < 0) throw new Error(`long layout needs user, permission and value columns; header row is: ${headers.join(' | ')}`);
    return { layout, headerRow: hi, subjectCol, permissionCol, valueCol, categoryCol };
  }
  // Matrix: the row labels live in the first column that has anything below the header (its own
  // header cell is often blank); everything to the right is data.
  const below = rows.slice(hi + 1);
  let labelCol = 0;
  while (labelCol < headers.length - 1 && !below.some(r => clean(r[labelCol]) !== '')) labelCol++;
  const dataRows = rows.slice(hi + 1).filter(r => clean(r[labelCol]) !== '');
  const colLabels = headers.slice(labelCol + 1).filter(h => h !== '').length;
  let orientation = opts.orientation;   // 'permissions-down' | 'users-down'
  if (!orientation) {
    const h0 = headers[labelCol];
    if (headerScore(h0, PERMISSION_HEADERS) || headerScore(h0, CATEGORY_HEADERS)) orientation = 'permissions-down';
    else if (headerScore(h0, SUBJECT_HEADERS)) orientation = 'users-down';
    else orientation = dataRows.length >= colLabels ? 'permissions-down' : 'users-down';   // there are usually far more settings than people
  }
  // A category column right next to the label column ("Category | Setting | user1 | user2…").
  let catCol = -1, permCol = labelCol;
  if (orientation === 'permissions-down') {
    if (categoryCol >= 0 && categoryCol <= labelCol + 1) { catCol = categoryCol; permCol = categoryCol === labelCol ? labelCol + 1 : labelCol; }
    else if (permissionCol >= 0 && permissionCol <= labelCol + 1 && permissionCol !== labelCol) { catCol = labelCol; permCol = permissionCol; }
  }
  return { layout: 'matrix', headerRow: hi, orientation, labelCol, categoryCol: catCol, permissionCol: permCol, firstDataCol: Math.max(labelCol, permCol, catCol) + 1 };
}

const joinName = (cat, name) => { cat = clean(cat); name = clean(name); return cat && name && normKey(name) !== normKey(cat) ? `${cat} > ${name}` : name || cat; };

/**
 * Extract records from one sheet. opts as in detectLayout, plus blankIsNo (matrix cells left empty
 * mean "not granted"; default true) and name (the sheet name for provenance).
 * Returns { layout, records, warnings, skipped } — warnings are plain sentences about what was
 * ignored or looked odd, so a person can see whether the file was read the way they expected.
 */
export function extractRecords(rows, opts = {}) {
  const lay = detectLayout(rows, opts);
  const out = [], warnings = [];
  const blankIsNo = opts.blankIsNo ?? true;
  const sheet = opts.name || '';
  const where = sheet ? `sheet "${sheet}"` : 'the sheet';
  let skipped = 0, unknownValues = new Map();
  const note = (raw, v) => { if (v !== 'Y' && v !== 'N') unknownValues.set(v, (unknownValues.get(v) || 0) + 1); };
  if (lay.layout === 'long') {
    let lastSubject = '', lastCat = '', noUser = 0;
    for (let i = lay.headerRow + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (!r.some(c => clean(c) !== '')) continue;
      const subj = clean(r[lay.subjectCol]) || lastSubject;   // eCW reports print the user once, then a block of settings
      const cat = lay.categoryCol >= 0 ? (clean(r[lay.categoryCol]) || lastCat) : '';
      const perm = clean(r[lay.permissionCol]);
      if (clean(r[lay.subjectCol])) lastSubject = subj;
      if (lay.categoryCol >= 0 && clean(r[lay.categoryCol])) lastCat = cat;
      if (!subj || !perm) { skipped++; if (!subj) noUser++; continue; }
      const raw = r[lay.valueCol];
      const value = normalizeValue(raw); note(raw, value);
      out.push({ subject: subj, permission: joinName(cat, perm), value, raw: raw === undefined ? '' : raw, sheet, row: i + 1 });
    }
    if (noUser) warnings.push(`${where}: ${noUser} row(s) had a setting but no user above them and were skipped`);
  } else {
    const headers = (rows[lay.headerRow] || []).map(clean);
    const cols = [];
    for (let c = lay.firstDataCol; c < headers.length; c++) if (headers[c] !== '') cols.push(c);
    const unnamed = headers.slice(lay.firstDataCol).filter((h, i) => h === '' && rows.slice(lay.headerRow + 1).some(r => clean(r[lay.firstDataCol + i]) !== '')).length;
    if (unnamed) warnings.push(`${where}: ${unnamed} column(s) have values but no name in the header row and were ignored`);
    let lastCat = '', headings = 0;
    for (let i = lay.headerRow + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const label = clean(r[lay.permissionCol]);
      const cat = lay.categoryCol >= 0 ? (clean(r[lay.categoryCol]) || lastCat) : '';
      if (lay.categoryCol >= 0 && clean(r[lay.categoryCol])) lastCat = cat;
      const anyValue = cols.some(c => clean(r[c]) !== '');
      if (!label) { if (anyValue) skipped++; continue; }
      // A row with a label but no values at all is a section heading in a permissions-down grid.
      if (!anyValue && lay.orientation === 'permissions-down' && lay.categoryCol < 0) { lastCat = label; headings++; continue; }
      for (const c of cols) {
        const raw = r[c] === undefined ? '' : r[c];
        if (clean(raw) === '' && !blankIsNo) continue;
        const rec = lay.orientation === 'permissions-down'
          ? { subject: headers[c], permission: joinName(lay.categoryCol >= 0 ? cat : lastCat, label) }
          : { subject: label, permission: headers[c] };
        const value = normalizeValue(raw); note(raw, value);
        out.push({ ...rec, value, raw, sheet, row: i + 1 });
      }
    }
    if (headings) warnings.push(`${where}: ${headings} row(s) with a name but no values were read as section headings (${[...new Set(out.map(r => r.permission.split(' > ')[0]))].slice(0, 6).join(', ')}…)`);
    if (skipped) warnings.push(`${where}: ${skipped} row(s) had values but no name in the first column and were skipped`);
  }
  // Duplicates: the same user + setting twice. The LAST one wins in the comparison; say so.
  const seen = new Map(); let dups = 0;
  for (const r of out) { const k = normKey(r.subject) + '|' + normKey(r.permission); if (seen.has(k)) { dups++; if (seen.get(k) !== r.value) r.duplicateOf = seen.get(k); } seen.set(k, r.value); }
  if (dups) warnings.push(`${where}: ${dups} user/setting pair(s) appear more than once — the last occurrence is used`);
  if (unknownValues.size) warnings.push(`${where}: values other than yes/no were kept as levels and compared as text: ${[...unknownValues].map(([v, n]) => `"${v}"×${n}`).slice(0, 8).join(', ')}`);
  return { layout: lay, records: out, warnings, skipped };
}

const ROLE_HEADERS = ['role', 'role name', 'security role', 'group', 'job title', 'title', 'template', 'profile'];
const USER_HEADERS = SUBJECT_HEADERS.filter(h => !ROLE_HEADERS.includes(h));

/** A two-column user → role sheet ("Users", "Roles", "Mapping"…): returns Map(userKey → { user, role }) or null. */
export function extractRoleMap(rows) {
  const hi = findHeaderRow(rows);
  const headers = (rows[hi] || []).map(clean);
  if (headers.filter(Boolean).length > 6) return null;   // a wide sheet is a matrix, not a mapping
  const taken = new Set();
  const u = bestCol(headers, USER_HEADERS, taken); if (u < 0) return null; taken.add(u);
  const r = bestCol(headers, ROLE_HEADERS, taken); if (r < 0) return null;
  const map = new Map();
  for (let i = hi + 1; i < rows.length; i++) { const row = rows[i] || []; const user = clean(row[u]); const role = clean(row[r]); if (user && role) map.set(normKey(user), { user, role }); }
  return map.size ? map : null;
}

const looksLikeRoleMap = name => /^(user|users|role map|roles map|mapping|user roles|users roles|staff|assignments?)$/i.test(clean(name));

/**
 * Read a whole workbook into records. Picks the sheet named by opts.sheet ('all' or '*' merges every
 * sheet that parses — eCW can export one tab per user), otherwise the first sheet that yields records
 * (skipping an obvious user→role mapping sheet). A baseline workbook may also carry a mapping sheet
 * (opts.rolesSheet, or auto-detected); when it does and the permission sheet is keyed by role, each
 * role's settings are expanded to its users.
 * Returns { sheet, sheets, layout, records, roleMap, expanded, warnings, ignoredSheets }.
 */
export function workbookToRecords(wb, opts = {}) {
  const sheets = wb.sheets || [];
  if (!sheets.length) throw new Error('the workbook has no sheets');
  const warnings = [];
  const pick = name => { const s = sheets.find(x => normKey(x.name) === normKey(name)); if (!s) throw new Error(`sheet "${name}" not found; sheets are: ${sheets.map(x => x.name).join(', ')}`); return s; };
  let roleMap = null, roleSheet = null;
  if (opts.rolesSheet) { roleSheet = pick(opts.rolesSheet); roleMap = extractRoleMap(roleSheet.rows); if (!roleMap) throw new Error(`sheet "${opts.rolesSheet}" is not a user → role mapping (needs a user column and a role column)`); }
  else if (opts.expandRoles !== false) for (const s of sheets) { if (sheets.length > 1 && looksLikeRoleMap(s.name)) { const m = extractRoleMap(s.rows); if (m) { roleMap = m; roleSheet = s; break; } } }
  const used = [], ignored = [];
  let res = null, layout = null;
  const all = opts.sheet && /^(all|\*)$/i.test(String(opts.sheet));
  if (opts.sheet && !all) { const main = pick(opts.sheet); res = extractRecords(main.rows, { ...opts, name: main.name }); used.push(main.name); layout = res.layout; }
  else {
    let lastErr = null; const records = [];
    for (const s of sheets) {
      if (s === roleSheet) continue;
      try {
        const r = extractRecords(s.rows, { ...opts, name: s.name });
        if (!r.records.length) { ignored.push(s.name); continue; }
        used.push(s.name); records.push(...r.records); warnings.push(...r.warnings); layout ??= r.layout;
        if (!all) break;
      } catch (e) { lastErr = e; ignored.push(s.name); }
    }
    if (!used.length) throw lastErr || new Error('no sheet with permission data found');
    res = { records, layout, warnings: [] };
    if (!all && ignored.length && sheets.length > 1) warnings.push(`sheet "${used[0]}" was used; ${ignored.map(n => `"${n}"`).join(', ')} had no permission data (use --sheet to pick another, or --sheet all to merge every sheet)`);
    if (!all && used.length === 1 && sheets.filter(x => x !== roleSheet && x !== sheets.find(y => y.name === used[0])).some(x => { try { return extractRecords(x.rows, { ...opts, name: x.name }).records.length > 0; } catch { return false; } })) warnings.push(`other sheets also contain permission data and were NOT read: ${sheets.filter(x => x !== roleSheet && x.name !== used[0]).map(x => `"${x.name}"`).join(', ')} — pass --sheet all to merge them`);
  }
  warnings.push(...(res.warnings || []));
  let records = res.records, expanded = false;
  if (roleMap) {
    const subjects = new Set(records.map(r => normKey(r.subject)));
    const roles = new Set([...roleMap.values()].map(v => normKey(v.role)));
    const byRole = [...subjects].filter(s => roles.has(s)).length;
    if (byRole && byRole >= subjects.size / 2) {   // the permission sheet is keyed by role → expand to users
      const out = [];
      const perRole = new Map();
      for (const r of records) { const k = normKey(r.subject); if (!perRole.has(k)) perRole.set(k, []); perRole.get(k).push(r); }
      const unmapped = [...subjects].filter(s => !roles.has(s));
      if (unmapped.length) warnings.push(`columns ${unmapped.map(u => `"${records.find(r => normKey(r.subject) === u).subject}"`).join(', ')} are not roles in "${roleSheet.name}" and were kept as users`);
      const noRole = [];
      for (const { user, role } of roleMap.values()) { const rs = perRole.get(normKey(role)); if (!rs) { noRole.push(`${user} (${role})`); continue; } for (const r of rs) out.push({ ...r, subject: user, role }); }
      if (noRole.length) warnings.push(`${noRole.length} user(s) in "${roleSheet.name}" have a role with no column in the permission sheet and got no expectations: ${noRole.slice(0, 6).join(', ')}${noRole.length > 6 ? ', …' : ''}`);
      for (const u of unmapped) out.push(...perRole.get(u));
      records = out; expanded = true;
    } else warnings.push(`"${roleSheet.name}" looks like a user → role sheet, but the permission sheet is not keyed by those roles, so it was not used`);
  }
  return { sheet: used.join(' + '), sheets: used, layout, records, roleMap: roleMap ? Object.fromEntries([...roleMap.values()].map(v => [v.user, v.role])) : null, expanded, warnings, ignoredSheets: ignored };
}
