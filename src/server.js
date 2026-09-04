// A small local web UI over the validator: node:http only, no dependencies.
//   GET  /                 the page (web/index.html)
//   POST /api/inspect      { file: {name, data(base64)}, options } → how the file is read (sheets, layout, users, settings, preview)
//   POST /api/validate     { baseline: {name, data}, actual: {name, data}, aliases?: {name, data}, options } → JSON result
//   POST /api/report       same body → the .xlsx report (also .csv / .json by `format`)
//   GET  /api/health
// Files never leave the machine: the page posts them to this process on loopback, the process
// keeps nothing on disk.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, inspect, loadAliases, buildReport, findingsCsv } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, '..', 'web', 'index.html');
const MAX_BODY = 96 * 1024 * 1024;

const readBody = req => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('request too large (96 MB max)'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const toFile = (f, label) => {
  if (!f || typeof f.data !== 'string') throw Object.assign(new Error(`${label} file is missing`), { status: 400 });
  const data = Buffer.from(f.data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!data.length) throw Object.assign(new Error(`${label} file is empty`), { status: 400 });
  return { name: String(f.name || label).slice(0, 200), data };
};
const perFile = o => ({ sheet: o?.sheet || undefined, layout: o?.layout || undefined, orientation: o?.orientation || undefined, rolesSheet: o?.rolesSheet || undefined, subjectCol: o?.subjectCol || undefined, permissionCol: o?.permissionCol || undefined, valueCol: o?.valueCol || undefined, categoryCol: o?.categoryCol || undefined, blankIsNo: o?.blankIsNo !== false });

export function runFromBody(body) {
  const o = body.options || {};
  const aliases = body.aliases?.data ? loadAliases(toFile(body.aliases, 'aliases')) : (o.aliases || undefined);
  return validate(toFile(body.baseline, 'baseline'), toFile(body.actual, 'eCW export'), {
    baseline: perFile(o.baseline), actual: perFile(o.actual),
    compare: { ignoreUsers: o.ignoreUsers || '', ignorePermissions: o.ignorePermissions || '', onlyUsers: o.onlyUsers || '', aliases, matchByName: o.matchByName !== false, reportUnknownPermissions: o.reportUnknownPermissions !== false, reportOk: !!o.reportOk },
  });
}

const view = v => ({
  meta: v.meta, ...v.result,
  baseline: { name: v.baseline.name, sheet: v.baseline.sheet, layout: v.baseline.layout, readAs: v.meta.baselineLayout, records: v.baseline.records.length, expanded: v.baseline.expanded, warnings: v.baseline.warnings },
  actual: { name: v.actual.name, sheet: v.actual.sheet, layout: v.actual.layout, readAs: v.meta.actualLayout, records: v.actual.records.length, warnings: v.actual.warnings },
});

export function createServer() {
  return http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(body); };
    const json = (status, obj) => send(status, JSON.stringify(obj));
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(200, fs.readFileSync(PAGE), 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:" });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, node: process.version });
      if (req.method === 'POST' && ['/api/validate', '/api/report', '/api/inspect'].includes(url.pathname)) {
        const ct = String(req.headers['content-type'] || '');
        if (!/application\/json/i.test(ct)) return json(415, { error: 'send application/json' });
        let body; try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return json(e.status || 400, { error: e.status ? e.message : 'invalid JSON body' }); }
        if (url.pathname === '/api/inspect') return json(200, inspect(toFile(body.file, 'file'), perFile(body.options), body.label || 'file'));
        const v = runFromBody(body);
        if (url.pathname === '/api/validate') return json(200, view(v));
        const fmt = String(body.format || 'xlsx');
        const stem = `ecw-validation-${v.meta.when.slice(0, 10)}`;
        if (fmt === 'csv') return send(200, findingsCsv(v.result), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${stem}.csv"` });
        if (fmt === 'json') return send(200, JSON.stringify(view(v), null, 2), 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="${stem}.json"` });
        return send(200, buildReport(v.result, v.meta), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { 'Content-Disposition': `attachment; filename="${stem}.xlsx"` });
      }
      json(404, { error: 'not found' });
    } catch (e) { json(e.status || 400, { error: String(e.message || e) }); }
  });
}

export function serve({ port = 8787, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, host, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}
