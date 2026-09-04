// A small local web UI over the validator: node:http only, no dependencies.
//   GET  /                 the page (web/index.html)
//   POST /api/validate     { baseline: {name, data(base64)}, actual: {name, data}, options } → JSON result
//   POST /api/report       same body → the .xlsx report (also .csv / .json by `format`)
//   GET  /api/health
// Files never leave the machine: the page posts them to this process on loopback, the process
// keeps nothing on disk.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, buildReport, findingsCsv } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, '..', 'web', 'index.html');
const MAX_BODY = 64 * 1024 * 1024;

const readBody = req => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('request too large (64 MB max)'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const toFile = (f, label) => {
  if (!f || typeof f.data !== 'string') throw Object.assign(new Error(`${label} file is missing`), { status: 400 });
  const data = Buffer.from(f.data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!data.length) throw Object.assign(new Error(`${label} file is empty`), { status: 400 });
  return { name: String(f.name || label).slice(0, 200), data };
};

export function runFromBody(body) {
  const o = body.options || {};
  const per = k => ({ sheet: o[k]?.sheet || undefined, layout: o[k]?.layout || undefined, orientation: o[k]?.orientation || undefined, rolesSheet: o[k]?.rolesSheet || undefined, subjectCol: o[k]?.subjectCol || undefined, permissionCol: o[k]?.permissionCol || undefined, valueCol: o[k]?.valueCol || undefined, categoryCol: o[k]?.categoryCol || undefined, blankIsNo: o[k]?.blankIsNo !== false });
  return validate(toFile(body.baseline, 'baseline'), toFile(body.actual, 'eCW export'), {
    baseline: per('baseline'), actual: per('actual'),
    compare: { ignoreUsers: o.ignoreUsers || '', ignorePermissions: o.ignorePermissions || '', onlyUsers: o.onlyUsers || '', reportUnknownPermissions: o.reportUnknownPermissions !== false, reportOk: !!o.reportOk },
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(body); };
    const json = (status, obj) => send(status, JSON.stringify(obj));
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(200, fs.readFileSync(PAGE), 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:" });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true });
      if (req.method === 'POST' && (url.pathname === '/api/validate' || url.pathname === '/api/report')) {
        const ct = String(req.headers['content-type'] || '');
        if (!/application\/json/i.test(ct)) return json(415, { error: 'send application/json' });
        let body; try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return json(e.status || 400, { error: e.status ? e.message : 'invalid JSON body' }); }
        const v = runFromBody(body);
        if (url.pathname === '/api/validate') return json(200, { meta: v.meta, ...v.result, baseline: { sheet: v.baseline.sheet, layout: v.baseline.layout, records: v.baseline.records.length, expanded: v.baseline.expanded }, actual: { sheet: v.actual.sheet, layout: v.actual.layout, records: v.actual.records.length } });
        const fmt = String(body.format || 'xlsx');
        const stem = `ecw-validation-${v.meta.when.slice(0, 10)}`;
        if (fmt === 'csv') return send(200, findingsCsv(v.result), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${stem}.csv"` });
        if (fmt === 'json') return send(200, JSON.stringify({ meta: v.meta, ...v.result }, null, 2), 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="${stem}.json"` });
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
