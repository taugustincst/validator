// The validator's request surface, independent of transport: the Node server (server.js) answers
// HTTP with it, and the browser build answers the page's own calls with it in-process. Each route
// takes the parsed JSON body and returns { status, type, data, filename } where data is a JSON
// value, a string, or a Buffer.
import { validate, inspect, loadAliases, loadCatalog, loadUsersFile, buildTemplate, buildReport, findingsCsv, documentEcw, buildSummaryPdf, summaryDoc } from './index.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

export const toFile = (f, label) => {
  if (!f || typeof f.data !== 'string') throw fail(400, `${label} file is missing`);
  const data = Buffer.from(f.data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!data.length) throw fail(400, `${label} file is empty`);
  return { name: String(f.name || label).slice(0, 200), data };
};
export const perFile = o => ({ role: o?.role || undefined, ignoreSubjects: o?.ignoreSubjects || undefined, sheet: o?.sheet || undefined, layout: o?.layout || undefined, orientation: o?.orientation || undefined, rolesSheet: o?.rolesSheet || undefined, subjectCol: o?.subjectCol || undefined, permissionCol: o?.permissionCol || undefined, valueCol: o?.valueCol || undefined, categoryCol: o?.categoryCol || undefined, blankIsNo: o?.blankIsNo !== false });

export function runFromBody(body) {
  const o = body.options || {};
  const aliases = body.aliases?.data ? loadAliases(toFile(body.aliases, 'aliases')) : (o.aliases || undefined);
  const users = body.users?.data ? loadUsersFile(toFile(body.users, 'users file')) : undefined;
  const actual = Array.isArray(body.actuals) && body.actuals.length ? body.actuals.map((f, i) => ({ src: toFile(f, `eCW export ${i + 1}`), role: f.role ? String(f.role) : undefined })) : toFile(body.actual, 'eCW export');
  return validate(toFile(body.baseline, 'baseline'), actual, {
    baseline: { ...perFile(o.baseline), usersFile: users }, actual: perFile(o.actual), catalog: body.catalog?.data ? toFile(body.catalog, 'catalog') : undefined,
    compare: { ignoreUsers: o.ignoreUsers || '', ignorePermissions: o.ignorePermissions || '', onlyUsers: o.onlyUsers || '', aliases, matchByName: o.matchByName !== false, reportUnknownPermissions: o.reportUnknownPermissions !== false, reportOk: !!o.reportOk },
  });
}

export const view = v => ({
  meta: v.meta, ...v.result, summary: summaryDoc(v.result, v.meta),
  catalogFile: v.catalog ? { name: v.catalog.name, sheet: v.catalog.sheet, settings: v.catalog.settings.length, groups: v.catalog.groups.size, warnings: v.catalog.warnings } : null,
  baseline: { name: v.baseline.name, sheet: v.baseline.sheet, layout: v.baseline.layout, readAs: v.meta.baselineLayout, records: v.baseline.records.length, expanded: v.baseline.expanded, warnings: v.baseline.warnings },
  actual: { name: v.actual.name, sheet: v.actual.sheet, layout: v.actual.layout, readAs: v.meta.actualLayout, records: v.actual.records.length, warnings: v.actual.warnings, files: v.actual.files || null },
});

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Answer one route. Throws { status, message } for a bad request. */
export function handle(pathname, body) {
  if (pathname === '/api/health') return { status: 200, type: 'application/json', data: { ok: true } };
  if (pathname === '/api/inspect') {
    const o = perFile(body.options);
    if (body.users?.data) o.usersFile = loadUsersFile(toFile(body.users, 'users file'));
    if (body.catalog?.data) o.catalog = toFile(body.catalog, 'catalog');
    return { status: 200, type: 'application/json', data: inspect(toFile(body.file, 'file'), o, body.label || 'file') };
  }
  if (pathname === '/api/template') {
    const cat = loadCatalog(toFile(body.catalog, 'catalog'));
    const roles = Array.isArray(body.roles) && body.roles.length ? body.roles.map(String) : undefined;
    const groups = Array.isArray(body.groups) && body.groups.length ? body.groups.map(String) : null;
    return { status: 200, type: XLSX, data: buildTemplate(cat, { roles, groups }), filename: 'baseline-template.xlsx' };
  }
  if (pathname === '/api/document') {   // the eCW inventory workbook: needs the eCW export(s), no baseline
    const o = body.options || {};
    const actual = Array.isArray(body.actuals) && body.actuals.length ? body.actuals.map((f, i) => ({ src: toFile(f, `eCW export ${i + 1}`), role: f.role ? String(f.role) : undefined })) : toFile(body.actual, 'eCW export');
    const d = documentEcw(actual, { actual: perFile(o.actual), catalog: body.catalog?.data ? toFile(body.catalog, 'catalog') : undefined });
    return { status: 200, type: XLSX, data: d.xlsx, filename: `ecw-security-settings-${new Date().toISOString().slice(0, 10)}.xlsx` };
  }
  if (pathname === '/api/validate' || pathname === '/api/report') {
    const v = runFromBody(body);
    if (pathname === '/api/validate') return { status: 200, type: 'application/json', data: view(v) };
    const fmt = String(body.format || 'xlsx');
    const stem = `ecw-validation-${v.meta.when.slice(0, 10)}`;
    if (fmt === 'csv') return { status: 200, type: 'text/csv', data: findingsCsv(v.result), filename: `${stem}.csv` };
    if (fmt === 'pdf') return { status: 200, type: 'application/pdf', data: buildSummaryPdf(v.result, v.meta), filename: `${stem}-summary.pdf` };
    if (fmt === 'summary') return { status: 200, type: 'application/json', data: summaryDoc(v.result, v.meta) };
    if (fmt === 'json') return { status: 200, type: 'application/json', data: JSON.stringify(view(v), null, 2), filename: `${stem}.json` };
    return { status: 200, type: XLSX, data: buildReport(v.result, v.meta), filename: `${stem}.xlsx` };
  }
  throw fail(404, 'not found');
}
