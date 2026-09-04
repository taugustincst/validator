// A small local web UI over the validator: node:http only, no dependencies.
//   GET  /                 the page (web/index.html)
//   POST /api/inspect      { file: {name, data(base64)}, options, users?, catalog? } → how the file is read
//   POST /api/validate     { baseline: {name, data}, actual: {name, data} | actuals: [{name, data, role}], aliases?, catalog?, users?, options } → JSON result
//   POST /api/report       same body → the .xlsx report (also .csv / .json by `format`)
//   POST /api/template     { catalog: {name, data}, roles?: [..], groups?: [..] } → a baseline template .xlsx built from the catalog
//   GET  /api/health
// The routes themselves live in api.js (the browser build calls them in-process). Files never leave
// the machine: the page posts them to this process on loopback, the process keeps nothing on disk.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './api.js';

export { runFromBody } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, '..', 'web', 'index.html');
const MAX_BODY = 96 * 1024 * 1024;

const readBody = req => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('request too large (96 MB max)'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

export function createServer() {
  return http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(body); };
    const json = (status, obj) => send(status, JSON.stringify(obj));
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(200, fs.readFileSync(PAGE), 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:" });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, node: process.version });
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const ct = String(req.headers['content-type'] || '');
        if (!/application\/json/i.test(ct)) return json(415, { error: 'send application/json' });
        let body; try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return json(e.status || 400, { error: e.status ? e.message : 'invalid JSON body' }); }
        const r = handle(url.pathname, body);
        const isJson = r.type === 'application/json';
        const payload = isJson && typeof r.data !== 'string' ? JSON.stringify(r.data) : r.data;
        return send(r.status, payload, isJson ? 'application/json; charset=utf-8' : r.type + (r.type.startsWith('text/') ? '; charset=utf-8' : ''), r.filename ? { 'Content-Disposition': `attachment; filename="${r.filename}"` } : {});
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
