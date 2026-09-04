// The comparison: baseline (what each user SHOULD have) vs. actual (what eCW says they have).
//
// Every (user, permission) pair in either set gets a status:
//   ok                      both agree
//   excess                  eCW grants it, the baseline does not      — severity high
//   missing                 the baseline grants it, eCW does not      — severity medium
//   different               both set, different level (e.g. "read only" vs "full") — medium
//   user-not-in-baseline    eCW has a user the baseline never mentions — high if they hold any grant
//   user-not-in-ecw         the baseline expects a user eCW does not list — medium
//   permission-not-in-baseline  eCW lists a setting the baseline does not cover — low if granted, info otherwise
//   permission-not-in-ecw   the baseline names a setting eCW's export does not have — low (typo or renamed item)
//
// Names are matched in three steps, and the result says which one applied:
//   1. exact — case, punctuation and repeated spaces ignored ("JDOE" = "jdoe", "Notes: Lock" = "Notes > Lock")
//   2. alias — pairs the owner supplied (opts.aliases.settings / opts.aliases.users)
//   3. by name — a setting whose name (without its "Category >" prefix) matches exactly one setting on the
//      other side, for when one document has categories and the other does not
// Anything still unmatched is reported with its closest candidate ("did you mean …") but is never
// silently matched — a wrong guess would hide a real discrepancy.
import { normKey, isGranted } from './parse.js';
import { lookup, bareName } from './catalog.js';

export const SEVERITY = { high: 3, medium: 2, low: 1, info: 0 };
export const TYPE_LABEL = {
  ok: 'OK', excess: 'Excess access', missing: 'Missing access', different: 'Different level',
  'user-not-in-baseline': 'User not in baseline', 'user-not-in-ecw': 'User not in eCW',
  'permission-not-in-baseline': 'Setting not in baseline', 'permission-not-in-ecw': 'Setting not in eCW',
};

const matcher = pats => { const list = (Array.isArray(pats) ? pats : String(pats || '').split(',')).map(s => s.trim()).filter(Boolean); if (!list.length) return () => false; const res = list.map(p => new RegExp('^' + p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')); return s => res.some(r => r.test(s)); };
const shortName = k => { const i = k.lastIndexOf(' > '); return i >= 0 ? k.slice(i + 3) : k; };
// "Category > Setting" keeps its separator so the bare setting name can be pulled out again.
const permKey = name => String(name ?? '').split('>').map(normKey).filter(Boolean).join(' > ');

/** 0..1 similarity of two normalized strings: token overlap blended with edit distance on the whole. */
export function similarity(a, b) {
  if (a === b) return 1;
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const jaccard = inter / (ta.size + tb.size - inter || 1);
  const d = levenshtein(a, b), lev = 1 - d / Math.max(a.length, b.length, 1);
  return Math.max(jaccard * 0.6 + lev * 0.4, lev, ta.size > 1 && inter === ta.size ? 0.9 : 0);   // a name fully contained in the other counts high
}
function levenshtein(a, b) {
  if (a.length > 200 || b.length > 200) return Math.abs(a.length - b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
}
/** Closest candidate among `names` (Map key → display), or null when nothing is close enough. */
export function closest(key, names, threshold = 0.72) {
  let best = null, score = threshold;
  const bare = k => normKey(String(k).replace(/\(.*$/s, ''));
  for (const [k, display] of names) {
    const dk = bare(display), dkey = bare(key);
    const s = Math.max(similarity(key, k), similarity(shortName(key), shortName(k)) * 0.95, dk && dkey ? similarity(dkey, dk) * 0.97 : 0);
    if (s > score) { score = s; best = { key: k, name: display, score: Math.round(s * 100) / 100 }; }
  }
  return best;
}

const aliasMap = (pairs, keyFn) => { const m = new Map(); if (!pairs) return m; const entries = Array.isArray(pairs) ? pairs : Object.entries(pairs); for (const [from, to] of entries) if (from && to) m.set(keyFn(from), keyFn(to)); return m; };

/**
 * Compare records. Options:
 *   ignoreUsers, ignorePermissions  — comma-separated globs (e.g. "test*,admin") to leave out of the comparison
 *   onlyUsers                        — restrict the comparison to these users (globs)
 *   aliases                          — { settings: { baselineName: ecwName }, users: { baselineName: ecwName } } (objects or [from, to] arrays)
 *   matchByName                      — match a setting by its name alone when unique (default true)
 *   reportUnknownPermissions         — include permission-not-in-baseline rows (default true)
 *   reportOk                         — include matching pairs in findings (default false; counts always include them)
 *   catalog                          — eCW's settings catalog (see catalog.js): findings get the setting's group and
 *                                      description, and result.catalog reports baseline names it does not know and
 *                                      catalog settings the baseline does not cover
 * Returns { findings, detail, actions, counts, bySeverity, bySetting, users, permissions, matches, compared, pass }.
 */
export function compare(baseline, actual, opts = {}) {
  const ignoreUser = matcher(opts.ignoreUsers), ignorePerm = matcher(opts.ignorePermissions);
  const onlyUser = opts.onlyUsers ? matcher(opts.onlyUsers) : null;
  const keep = r => !ignoreUser(r.subject) && !ignorePerm(r.permission) && (!onlyUser || onlyUser(r.subject));
  const settingAlias = aliasMap(opts.aliases?.settings, permKey), userAlias = aliasMap(opts.aliases?.users, normKey);
  const index = (recs, ua, pa) => {
    const users = new Map();   // userKey → { name, perms: Map(permKey → rec) }
    const perms = new Map();   // permKey → display name
    for (const r of recs) {
      if (!keep(r)) continue;
      let uk = normKey(r.subject), pk = permKey(r.permission);
      if (ua.has(uk)) uk = ua.get(uk);
      if (pa.has(pk)) pk = pa.get(pk);
      if (!uk || !pk) continue;
      if (!users.has(uk)) users.set(uk, { name: r.subject, perms: new Map(), listedOnly: false });
      users.get(uk).perms.set(pk, r);   // a later duplicate row wins (eCW prints the effective value last)
      if (r.listedOnly) users.get(uk).listedOnly = true;   // an eCW per-role export that lists only what the role has
      if (!perms.has(pk)) perms.set(pk, r.permission);
    }
    return { users, perms };
  };
  // Aliases are written baseline → eCW; apply them to the baseline side so both sides use eCW's keys.
  const B = index(baseline, userAlias, settingAlias), A = index(actual, new Map(), new Map());

  // Step 3 — settings matched by bare name when that is unambiguous on both sides.
  const matches = [];   // { baseline, ecw, by: 'alias'|'name' }
  for (const [from, to] of settingAlias) if (A.perms.has(to)) matches.push({ baseline: baseline.find(r => permKey(r.permission) === from)?.permission || from, ecw: A.perms.get(to), by: 'alias' });
  for (const [from, to] of userAlias) if (A.users.has(to)) matches.push({ baseline: baseline.find(r => normKey(r.subject) === from)?.subject || from, ecw: A.users.get(to).name, by: 'alias', kind: 'user' });
  // Users / roles: eCW shows a role as "APPS Admin (Admin (Apps Support))" and a practice's matrix says
  // "APPS Admin": the name without its parenthetical, when unique on both sides, is the same role.
  const plain = k => k.replace(/\(.*$/s, '').replace(/\s+/g, ' ').trim();
  if (opts.matchByName !== false) {
    const bPlain = new Map(), aPlain = new Map();
    for (const k of B.users.keys()) { const p = plain(B.users.get(k).name.toLowerCase()); const pk = normKey(p); if (!bPlain.has(pk)) bPlain.set(pk, []); bPlain.get(pk).push(k); }
    for (const k of A.users.keys()) { const p = plain(A.users.get(k).name.toLowerCase()); const pk = normKey(p); if (!aPlain.has(pk)) aPlain.set(pk, []); aPlain.get(pk).push(k); }
    for (const [pk, bks] of bPlain) {
      if (bks.length !== 1 || A.users.has(bks[0])) continue;
      const aks = aPlain.get(pk); if (!aks || aks.length !== 1 || B.users.has(aks[0]) || aks[0] === bks[0]) continue;
      const u = B.users.get(bks[0]); B.users.delete(bks[0]); B.users.set(aks[0], u);   // the baseline row takes eCW's key; its name stays the baseline's
      matches.push({ baseline: u.name, ecw: A.users.get(aks[0]).name, by: 'name', kind: 'user' });
    }
  }
  const remap = new Map();   // baseline permKey → ecw permKey
  if (opts.matchByName !== false) {
    const byShort = m => { const out = new Map(); for (const k of m.keys()) { const s = shortName(k); if (!out.has(s)) out.set(s, []); out.get(s).push(k); } return out; };
    const bs = byShort(B.perms), as = byShort(A.perms);
    for (const [s, bks] of bs) {
      if (bks.length !== 1 || A.perms.has(bks[0])) continue;
      const aks = as.get(s); if (!aks || aks.length !== 1 || B.perms.has(aks[0])) continue;
      remap.set(bks[0], aks[0]); matches.push({ baseline: B.perms.get(bks[0]), ecw: A.perms.get(aks[0]), by: 'name' });
    }
    if (remap.size) {
      for (const u of B.users.values()) { const np = new Map(); for (const [k, r] of u.perms) np.set(remap.get(k) || k, r); u.perms = np; }
      for (const [from, to] of remap) { const d = B.perms.get(from); B.perms.delete(from); if (!B.perms.has(to)) B.perms.set(to, d); }
    }
  }

  const findings = [], detail = [];
  const counts = { ok: 0, excess: 0, missing: 0, different: 0, 'user-not-in-baseline': 0, 'user-not-in-ecw': 0, 'permission-not-in-baseline': 0, 'permission-not-in-ecw': 0 };
  const bySetting = new Map();
  const push = f => {
    counts[f.type] = (counts[f.type] || 0) + 1;
    if (f.permission) { if (!bySetting.has(f.permission)) bySetting.set(f.permission, { setting: f.permission, ok: 0, excess: 0, missing: 0, different: 0, other: 0 }); const s = bySetting.get(f.permission); if (f.type in s) s[f.type]++; else s.other++; }
    if (f.type !== 'ok' || opts.reportOk) findings.push(f);
    return f;
  };
  // Baseline spelling first: it is the reference document, so its names are the ones people know.
  const allUsers = new Map([...A.users, ...B.users].map(([k, v]) => [k, v.name]));
  const userNamesA = new Map([...A.users].map(([k, v]) => [k, v.name])), userNamesB = new Map([...B.users].map(([k, v]) => [k, v.name]));
  for (const [uk, name] of allUsers) {
    const b = B.users.get(uk), a = A.users.get(uk);
    const row = { user: name, inBaseline: !!b, inEcw: !!a, role: b && [...b.perms.values()].find(r => r.role)?.role || '', settings: [] };
    detail.push(row);
    if (!a) {
      const granted = [...b.perms.values()].filter(r => isGranted(r.value)).length;
      const near = closest(name, userNamesA);
      const f = push({ type: 'user-not-in-ecw', severity: 'medium', user: name, permission: '', expected: `${b.perms.size} settings (${granted} granted)`, actual: '', note: `user is in the baseline but not in the eCW export — not set up, deactivated, or spelled differently${near ? `; closest eCW user: "${near.name}"` : ''}`, suggestion: near?.name || '' });
      row.finding = f;
      for (const [pk, br] of b.perms) row.settings.push({ permission: br.permission, expected: show(br), actual: '', type: 'user-not-in-ecw', severity: isGranted(br.value) ? 'medium' : 'info' });
      continue;
    }
    if (!b) {
      const grants = [...a.perms.values()].filter(r => isGranted(r.value));
      const near = closest(name, userNamesB);
      const f = push({ type: 'user-not-in-baseline', severity: grants.length ? 'high' : 'low', user: name, permission: '', expected: '', actual: `${a.perms.size} settings (${grants.length} granted)`, note: (grants.length ? 'eCW user with no baseline: every grant is unreviewed — ' + grants.slice(0, 8).map(r => r.permission).join('; ') + (grants.length > 8 ? '; …' : '') : 'eCW user with no baseline and no grants') + (near ? `; closest baseline user: "${near.name}"` : ''), suggestion: near?.name || '' });
      row.finding = f;
      for (const [pk, ar] of a.perms) row.settings.push({ permission: ar.permission, expected: '', actual: show(ar), type: 'user-not-in-baseline', severity: isGranted(ar.value) ? 'high' : 'info' });
      continue;
    }
    for (const [pk, br] of b.perms) {
      const ar = a.perms.get(pk);
      const base = { user: name, permission: br.permission, expected: show(br), actual: ar ? show(ar) : '', baselineRow: br.row, actualRow: ar?.row };
      let f;
      if (!ar && a.listedOnly) {   // not in the role's list = the role does not have it
        const nl = { ...base, actual: 'N (not listed)' };
        f = isGranted(br.value) ? push({ ...nl, type: 'missing', severity: 'medium', note: 'required by the baseline but not in this role\'s eCW list — grant it in eCW' }) : push({ ...nl, type: 'ok', severity: 'info', note: '' });
      } else if (!ar) {
        if (A.perms.has(pk)) f = push({ ...base, type: 'missing', severity: isGranted(br.value) ? 'medium' : 'info', note: 'setting exists in eCW but is not listed for this user' });
        else { const near = closest(pk, A.perms); f = push({ ...base, type: 'permission-not-in-ecw', severity: 'low', note: `this setting does not appear anywhere in the eCW export — renamed, or a baseline typo${near ? `; closest eCW setting: "${near.name}"` : ''}`, suggestion: near?.name || '' }); }
      } else if (br.value === ar.value) f = push({ ...base, type: 'ok', severity: 'info', note: '' });
      else {
        const bg = isGranted(br.value), ag = isGranted(ar.value);
        if (ag && !bg) f = push({ ...base, type: 'excess', severity: 'high', note: 'granted in eCW but not in the baseline — remove in eCW, or approve it in the baseline' });
        else if (bg && !ag) f = push({ ...base, type: 'missing', severity: 'medium', note: 'required by the baseline but not granted in eCW — grant it in eCW' });
        else f = push({ ...base, type: 'different', severity: 'medium', note: `both set, but to different levels — eCW says "${ar.raw}", the baseline "${br.raw}"` });
      }
      row.settings.push({ permission: base.permission, expected: base.expected, actual: base.actual, type: f.type, severity: f.severity, baselineRow: br.row, actualRow: ar?.row });
    }
    for (const [pk, ar] of a.perms) {
      if (b.perms.has(pk)) continue;
      let f;
      if (B.perms.has(pk)) f = isGranted(ar.value) ? push({ user: name, permission: ar.permission, type: 'excess', severity: 'high', expected: '', actual: show(ar), actualRow: ar.row, note: 'granted in eCW; the baseline covers this setting but says nothing for this user — remove, or add it to the baseline' }) : push({ user: name, permission: ar.permission, type: 'ok', severity: 'info', expected: '', actual: show(ar), actualRow: ar.row, note: '' });
      else if (opts.reportUnknownPermissions !== false) { const near = closest(pk, B.perms); f = push({ user: name, permission: ar.permission, type: 'permission-not-in-baseline', severity: isGranted(ar.value) ? 'low' : 'info', expected: '', actual: show(ar), actualRow: ar.row, note: (isGranted(ar.value) ? 'eCW setting the baseline does not cover, and it is granted — decide and add it to the baseline' : 'eCW setting the baseline does not cover (not granted)') + (near ? `; closest baseline setting: "${near.name}"` : ''), suggestion: near?.name || '' }); }
      else continue;
      row.settings.push({ permission: ar.permission, expected: '', actual: show(ar), type: f.type, severity: f.severity, actualRow: ar.row });
    }
    row.settings.sort((x, y) => x.permission.localeCompare(y.permission));
  }
  findings.sort((x, y) => SEVERITY[y.severity] - SEVERITY[x.severity] || x.user.localeCompare(y.user) || x.permission.localeCompare(y.permission));
  detail.sort((x, y) => x.user.localeCompare(y.user));
  const bySeverity = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  const users = { baseline: B.users.size, ecw: A.users.size, both: [...B.users.keys()].filter(k => A.users.has(k)).length };
  const permissions = { baseline: B.perms.size, ecw: A.perms.size, both: [...B.perms.keys()].filter(k => A.perms.has(k)).length };
  const compared = counts.ok + counts.excess + counts.missing + counts.different;
  const result = { findings, detail, counts, bySeverity, bySetting: [...bySetting.values()].filter(s => s.excess || s.missing || s.different || s.other).sort((a, b) => (b.excess + b.missing + b.different) - (a.excess + a.missing + a.different)), users, permissions, matches, compared, pass: bySeverity.high === 0 && bySeverity.medium === 0 };
  result.actions = actions(result);
  if (opts.catalog) enrich(result, opts.catalog, B, A);
  return result;
}

/** Attach group + description from the catalog to every finding and detail row; compute coverage. */
function enrich(result, cat, B, A) {
  const tag = (o, name) => { const c = lookup(cat, name); if (c) { o.group = c.group; o.description = c.description; } return c; };
  for (const f of result.findings) if (f.permission) tag(f, f.permission);
  for (const d of result.detail) for (const s of d.settings) tag(s, s.permission);
  const catNames = new Map([...cat.byKey].map(([k, v]) => [k, v.name]));
  const unknown = [];
  for (const [pk, name] of B.perms) if (!lookup(cat, name)) { const near = closest(normKey(bareName(cat, name)), catNames, 0.6); unknown.push({ name, suggestion: near?.name || '', group: near ? cat.byKey.get(near.key)?.group || '' : '' }); }
  const ecwUnknown = [];
  for (const [pk, name] of A.perms) if (!lookup(cat, name)) ecwUnknown.push(name);
  // Coverage: which catalog settings the baseline says something about, and how many eCW users hold each.
  const covered = new Set(); for (const [, name] of B.perms) { const c = lookup(cat, name); if (c) covered.add(normKey(c.name)); }
  const grantedTo = new Map();
  for (const u of A.users.values()) for (const r of u.perms.values()) { const c = lookup(cat, r.permission); if (c && isGranted(r.value)) { const k = normKey(c.name); grantedTo.set(k, (grantedTo.get(k) || 0) + 1); } }
  const settings = cat.settings.map(c => ({ name: c.name, group: c.group, description: c.description, type: c.type, inBaseline: covered.has(normKey(c.name)), grantedTo: grantedTo.get(normKey(c.name)) || 0 }));
  const byGroup = new Map();
  for (const s of settings) { if (!byGroup.has(s.group)) byGroup.set(s.group, { group: s.group, total: 0, covered: 0, grantedUncovered: 0 }); const g = byGroup.get(s.group); g.total++; if (s.inBaseline) g.covered++; else if (s.grantedTo) g.grantedUncovered++; }
  result.catalog = { total: cat.settings.length, covered: covered.size, unknown, ecwUnknown, settings, byGroup: [...byGroup.values()].sort((a, b) => b.total - a.total), grantedUncovered: settings.filter(s => !s.inBaseline && s.grantedTo).length };
}

/** "Y (Yes)", "N (blank)", "read only" — the normalized value, with what the cell said when that differs. */
const show = r => { const raw = r.raw; if (raw === '' || raw == null) return r.value === 'N' ? 'N (blank)' : r.value; const s = String(raw).trim(); return normKey(s) === normKey(r.value) ? r.value : `${r.value} (${s})`; };

/**
 * What to actually do, per user, in the order an eCW administrator would work through it:
 * remove (excess grants), grant (missing), review (different levels, unknown settings), and the
 * users to create or retire. Derived from findings, so it always agrees with them.
 */
export function actions(result) {
  const per = new Map();
  const at = u => { if (!per.has(u)) per.set(u, { user: u, remove: [], grant: [], review: [], status: '' }); return per.get(u); };
  for (const f of result.findings) {
    if (f.type === 'excess') at(f.user).remove.push(f.permission);
    else if (f.type === 'missing' && f.severity !== 'info') at(f.user).grant.push(f.permission);
    else if (f.type === 'different') at(f.user).review.push(`${f.permission}: eCW has ${f.actual}, baseline wants ${f.expected}`);
    else if (f.type === 'user-not-in-baseline') at(f.user).status = f.severity === 'high' ? `not in the baseline but holds grants in eCW — add to the baseline or remove the user${f.suggestion ? ` (closest baseline user: ${f.suggestion})` : ''}` : 'not in the baseline (no grants) — add to the baseline or ignore';
    else if (f.type === 'user-not-in-ecw') at(f.user).status = `expected by the baseline but not in eCW — create the user, or retire the baseline row${f.suggestion ? ` (closest eCW user: ${f.suggestion})` : ''}`;
    else if (f.type === 'permission-not-in-baseline' && f.severity === 'low') at(f.user).review.push(`${f.permission}: granted in eCW, not covered by the baseline`);
  }
  return [...per.values()].sort((a, b) => (b.remove.length - a.remove.length) || (b.grant.length - a.grant.length) || a.user.localeCompare(b.user));
}

/** Per-user rollup for the summary sheet. */
export function perUser(result) {
  const m = new Map();
  for (const f of result.findings) {
    if (!m.has(f.user)) m.set(f.user, { user: f.user, high: 0, medium: 0, low: 0, info: 0, excess: 0, missing: 0, different: 0, other: 0 });
    const u = m.get(f.user); u[f.severity]++;
    if (f.type in u) u[f.type]++; else if (f.type !== 'ok') u.other++;
  }
  return [...m.values()].sort((a, b) => b.high - a.high || b.medium - a.medium || a.user.localeCompare(b.user));
}
