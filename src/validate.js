// The comparison: baseline (what each user SHOULD have) vs. actual (what eCW says they have).
//
// Every (user, permission) pair in either set gets a finding:
//   ok                      both agree
//   excess                  eCW grants it, the baseline does not      — severity high
//   missing                 the baseline grants it, eCW does not      — severity medium
//   different               both set, different level (e.g. "read only" vs "full") — medium
//   user-not-in-baseline    eCW has a user the baseline never mentions — high if they hold any grant
//   user-not-in-ecw         the baseline expects a user eCW does not list — medium
//   permission-not-in-baseline  eCW lists a setting the baseline does not cover — low if granted, info otherwise
//   permission-not-in-ecw   the baseline names a setting eCW's export does not have — low (typo or renamed item)
// Users and settings are matched case-insensitively, ignoring punctuation and extra whitespace.
import { normKey, isGranted } from './parse.js';

export const SEVERITY = { high: 3, medium: 2, low: 1, info: 0 };

const matcher = pats => { const list = (Array.isArray(pats) ? pats : String(pats || '').split(',')).map(s => s.trim()).filter(Boolean); if (!list.length) return () => false; const res = list.map(p => new RegExp('^' + p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')); return s => res.some(r => r.test(s)); };

/**
 * Compare records. Options:
 *   ignoreUsers, ignorePermissions  — comma-separated globs (e.g. "test*,admin") to leave out of the comparison
 *   onlyUsers                        — restrict the comparison to these users (globs)
 *   reportUnknownPermissions         — include permission-not-in-baseline rows (default true)
 *   reportOk                         — include matching pairs in findings (default false; counts always include them)
 */
export function compare(baseline, actual, opts = {}) {
  const ignoreUser = matcher(opts.ignoreUsers), ignorePerm = matcher(opts.ignorePermissions);
  const onlyUser = opts.onlyUsers ? matcher(opts.onlyUsers) : null;
  const keep = r => !ignoreUser(r.subject) && !ignorePerm(r.permission) && (!onlyUser || onlyUser(r.subject));
  const index = recs => {
    const users = new Map();   // userKey → { name, perms: Map(permKey → rec) }
    const perms = new Map();   // permKey → display name
    for (const r of recs) {
      if (!keep(r)) continue;
      const uk = normKey(r.subject), pk = normKey(r.permission);
      if (!uk || !pk) continue;
      if (!users.has(uk)) users.set(uk, { name: r.subject, perms: new Map() });
      users.get(uk).perms.set(pk, r);   // a later duplicate row wins (eCW prints the effective value last)
      if (!perms.has(pk)) perms.set(pk, r.permission);
    }
    return { users, perms };
  };
  const B = index(baseline), A = index(actual);
  const findings = [];
  const counts = { ok: 0, excess: 0, missing: 0, different: 0, 'user-not-in-baseline': 0, 'user-not-in-ecw': 0, 'permission-not-in-baseline': 0, 'permission-not-in-ecw': 0 };
  const push = f => { counts[f.type] = (counts[f.type] || 0) + 1; if (f.type !== 'ok' || opts.reportOk) findings.push(f); };
  const allUsers = new Map([...A.users, ...B.users].map(([k, v]) => [k, v.name]));
  for (const [uk, name] of allUsers) {
    const b = B.users.get(uk), a = A.users.get(uk);
    if (!a) {
      const granted = [...b.perms.values()].filter(r => isGranted(r.value)).length;
      push({ type: 'user-not-in-ecw', severity: 'medium', user: name, permission: '', expected: `${b.perms.size} settings (${granted} granted)`, actual: '', note: 'user is in the baseline but not in the eCW export — not set up, deactivated, or a spelling difference' });
      continue;
    }
    if (!b) {
      const grants = [...a.perms.values()].filter(r => isGranted(r.value));
      push({ type: 'user-not-in-baseline', severity: grants.length ? 'high' : 'low', user: name, permission: '', expected: '', actual: `${a.perms.size} settings (${grants.length} granted)`, note: grants.length ? 'eCW user with no baseline: every grant is unreviewed — ' + grants.slice(0, 8).map(r => r.permission).join('; ') + (grants.length > 8 ? '; …' : '') : 'eCW user with no baseline and no grants' });
      continue;
    }
    for (const [pk, br] of b.perms) {
      const ar = a.perms.get(pk);
      const base = { user: name, permission: br.permission, expected: show(br), actual: ar ? show(ar) : '', baselineRow: br.row, actualRow: ar?.row };
      if (!ar) { if (A.perms.has(pk)) push({ ...base, type: 'missing', severity: isGranted(br.value) ? 'medium' : 'info', note: 'setting exists in eCW but is not listed for this user' }); else push({ ...base, type: 'permission-not-in-ecw', severity: 'low', note: 'this setting does not appear anywhere in the eCW export — renamed, or a baseline typo' }); continue; }
      if (br.value === ar.value) { push({ ...base, type: 'ok', severity: 'info', note: '' }); continue; }
      const bg = isGranted(br.value), ag = isGranted(ar.value);
      if (ag && !bg) push({ ...base, type: 'excess', severity: 'high', note: 'granted in eCW but not in the baseline — remove' });
      else if (bg && !ag) push({ ...base, type: 'missing', severity: 'medium', note: 'required by the baseline but not granted in eCW — add' });
      else push({ ...base, type: 'different', severity: 'medium', note: 'both set, but to different levels' });
    }
    if (opts.reportUnknownPermissions !== false) for (const [pk, ar] of a.perms) {
      if (b.perms.has(pk)) continue;
      if (B.perms.has(pk)) { if (isGranted(ar.value)) push({ user: name, permission: ar.permission, type: 'excess', severity: 'high', expected: '', actual: show(ar), actualRow: ar.row, note: 'granted in eCW; the baseline covers this setting but not for this user — remove or add to the baseline' }); else push({ user: name, permission: ar.permission, type: 'ok', severity: 'info', expected: '', actual: show(ar), actualRow: ar.row, note: '' }); }
      else push({ user: name, permission: ar.permission, type: 'permission-not-in-baseline', severity: isGranted(ar.value) ? 'low' : 'info', expected: '', actual: show(ar), actualRow: ar.row, note: isGranted(ar.value) ? 'eCW setting the baseline does not cover, and it is granted — decide and add it to the baseline' : 'eCW setting the baseline does not cover (not granted)' });
    }
  }
  findings.sort((x, y) => SEVERITY[y.severity] - SEVERITY[x.severity] || x.user.localeCompare(y.user) || x.permission.localeCompare(y.permission));
  const bySeverity = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  const users = { baseline: B.users.size, ecw: A.users.size, both: [...B.users.keys()].filter(k => A.users.has(k)).length };
  const permissions = { baseline: B.perms.size, ecw: A.perms.size, both: [...B.perms.keys()].filter(k => A.perms.has(k)).length };
  const compared = counts.ok + counts.excess + counts.missing + counts.different;
  return { findings, counts, bySeverity, users, permissions, compared, pass: bySeverity.high === 0 && bySeverity.medium === 0 };
}

/** "Y (Yes)", "N (blank)", "read only" — the normalized value, with what the cell said when that differs. */
const show = r => { const raw = r.raw; if (raw === '' || raw == null) return r.value === 'N' ? 'N (blank)' : r.value; const s = String(raw).trim(); return normKey(s) === normKey(r.value) ? r.value : `${r.value} (${s})`; };

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
