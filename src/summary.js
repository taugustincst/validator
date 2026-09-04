// The one-page-per-role summary of differences, as data: the print view and the PDF both render it.
//   { title, subtitle, meta: [[label, value]], verdict: { pass, headline, detail }, roles: [{ name, mappedFrom,
//     status, groups: [{ kind: 'remove'|'grant'|'review', heading, items: [{ text, detail }] }] }], footer }
import { TYPE_LABEL } from './validate.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function summaryDoc(result, meta = {}) {
  const toFix = result.actions.filter(a => a.remove.length || a.grant.length);
  const removeN = result.actions.reduce((n, a) => n + a.remove.length, 0);
  const grantN = result.actions.reduce((n, a) => n + a.grant.length, 0);
  const reviewN = result.actions.reduce((n, a) => n + a.review.length, 0);
  const missingRoles = result.actions.filter(a => a.status);
  const clean = result.detail.filter(d => d.inBaseline && d.inEcw && !result.actions.some(a => a.user === d.user)).length;
  const needs = result.actions.length;   // every role with anything to do: remove, grant, review, or a status
  const headline = result.pass ? 'eCW matches the matrix' : `${plural(needs, 'role')} need${needs === 1 ? 's' : ''} attention`;
  const detail = result.pass
    ? `${plural(result.users.both, 'role')} compared, ${result.compared} settings checked, nothing to change.${reviewN ? ` ${plural(reviewN, 'item')} to review.` : ''}`
    : [removeN ? `remove ${plural(removeN, 'permission')}` : '', grantN ? `grant ${plural(grantN, 'permission')}` : '', reviewN ? `review ${plural(reviewN, 'item')}` : ''].filter(Boolean).join(', ') + (clean ? `. ${plural(clean, 'role')} ${clean === 1 ? 'matches' : 'match'} the matrix exactly.` : '.');
  const desc = (user, perm) => (result.detail.find(d => d.user === user)?.settings.find(s => s.permission === perm) || {}).description || '';
  const roles = result.actions.map(a => ({
    name: a.user,
    mappedFrom: result.detail.find(d => d.user === a.user)?.role || '',
    status: a.status,
    groups: [
      a.remove.length ? { kind: 'remove', heading: `Remove in eCW — has but shouldn't (${a.remove.length})`, items: a.remove.map(p => ({ text: p, detail: desc(a.user, p) })) } : null,
      a.grant.length ? { kind: 'grant', heading: `Grant in eCW — should have but doesn't (${a.grant.length})`, items: a.grant.map(p => ({ text: p, detail: desc(a.user, p) })) } : null,
      a.review.length ? { kind: 'review', heading: `Review (${a.review.length})`, items: a.review.map(p => ({ text: p, detail: '' })) } : null,
    ].filter(Boolean),
  }));
  const matched = result.detail.filter(d => d.inBaseline && d.inEcw && !result.actions.some(a => a.user === d.user)).map(d => d.user);
  return {
    title: 'eCW security settings — role differences',
    subtitle: `${meta.baseline ? `Matrix: ${meta.baseline}` : ''}${meta.actual ? `   ·   eCW: ${meta.actual}` : ''}`.trim(),
    meta: [
      ['Run', (meta.when || new Date().toISOString()).replace('T', ' ').slice(0, 16)],
      ['Roles', `${result.users.baseline} in the matrix, ${result.users.ecw} in eCW, ${result.users.both} in both`],
      ['Settings', `${result.permissions.baseline} in the matrix, ${result.permissions.ecw} in eCW; ${result.compared} role/setting pairs compared, ${result.counts.ok} match`],
      ...(result.catalog ? [['Catalog', `${result.catalog.covered} of ${result.catalog.total} eCW settings covered by the matrix`]] : []),
    ],
    verdict: { pass: result.pass, headline, detail },
    roles,
    matched,
    footer: "Has but shouldn't = eCW grants it, the matrix does not. Should have but doesn't = the matrix grants it, eCW does not. Review = a level mismatch, or a setting the matrix does not mention.",
    counts: { high: result.bySeverity.high, medium: result.bySeverity.medium, low: result.bySeverity.low },
    labels: TYPE_LABEL,
  };
}
