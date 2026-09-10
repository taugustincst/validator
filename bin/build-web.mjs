#!/usr/bin/env node
// Builds the self-contained browser version of the validator: web/index.html with the whole engine
// inlined, no server and no libraries, so the page runs from a double-click or as a hosted Artifact.
//
//   node bin/build-web.mjs            → dist/ecw-validator.html          (a complete document)
//                                     → dist/ecw-validator.artifact.html (the same page as a fragment, for the Artifact host)
//
// The engine modules are ES modules written for Node. They are bundled here without a bundler: each
// module becomes a function that receives the modules it imports (linked twice, so the parse ↔ catalog
// cycle resolves), `node:zlib` is replaced by the plain-JS decoder, `Buffer` by a small shim, and the
// file-system entry points are stubbed (the page only ever passes bytes).
import fs from 'node:fs';
import path from 'node:path';
import { transform, ENGINE, root, read } from './bundle-lib.mjs';

const MODULES = [['zlib', 'src/zlib-browser.js'], ...ENGINE];
const shim = (name, mod, names, id) => {
  if (mod === 'fs') return `const ${name} = __fs;`;
  if (mod === 'path') return `const ${name} = __path;`;
  if (mod === 'url') return `const ${names ? names.replace(/\s+as\s+/g, ':') : name} = __url;`;
  if (mod === 'http') return `const ${name} = null;`;
  if (mod === 'zlib') return `const ${name} = null;`;
  throw new Error(`${id}: no browser shim for node:${mod}`);
};

const bundle = ['const M = {}; const __links = [];',
  `const __fs = { readFileSync: () => { throw new Error('file paths are not available in the browser; pass the file contents'); }, writeFileSync: () => { throw new Error('not available in the browser'); }, mkdirSync: () => {}, existsSync: () => false, readdirSync: () => [] };`,
  `const __path = { basename: p => String(p).replace(/^.*[\\\\/]/, ''), dirname: p => String(p).replace(/[\\\\/][^\\\\/]*$/, '') || '.', resolve: (...a) => a.join('/'), join: (...a) => a.join('/') };`,
  `const __url = { fileURLToPath: u => String(u) };`,
  read('src/buffer-shim.js').replace(/^export\s+/gm, ''),
  ...MODULES.map(([id, file]) => transform(id, read(file), { shim })),
  '__links.forEach(l => l());',
  'window.ECW = M;'].join('\n');

// The page: swap the HTTP calls for in-page calls, and (when samples are embedded) open on a worked example.
let page = read('web/index.html');
const { webSamples } = await import(path.join(root, 'examples', 'make-examples.js'));
const samples = Object.entries(webSamples()).map(([k, buf]) => [k, buf.toString('base64')]);
const localApi = `
  // In-page API: the same routes the Node server answers, run here in the browser.
  const __b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const post = async (p, b) => {
    await new Promise(r => setTimeout(r, 0));   // let the UI paint "validating…" first
    try {
      const r = ECW.api.handle(p, b);
      const isJson = r.type === 'application/json';
      const payload = isJson && typeof r.data !== 'string' ? JSON.stringify(r.data) : r.data;
      const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
      return { ok: true, status: r.status, statusText: 'OK', headers: { get: h => h.toLowerCase() === 'content-disposition' && r.filename ? 'attachment; filename="' + r.filename + '"' : h.toLowerCase() === 'content-type' ? r.type : null }, json: async () => isJson ? (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) : JSON.parse(new TextDecoder().decode(bytes)), text: async () => typeof payload === 'string' ? payload : new TextDecoder().decode(bytes), blob: async () => new Blob([bytes], { type: r.type }), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    } catch (e) {
      const msg = String(e.message || e);
      return { ok: false, status: e.status || 400, statusText: msg, headers: { get: () => null }, json: async () => ({ error: msg }), text: async () => msg, blob: async () => new Blob([msg]), arrayBuffer: async () => new ArrayBuffer(0) };
    }
  };
  window.ECW_SAMPLES = ${JSON.stringify(Object.fromEntries(samples))};`;
page = page.replace(/\n\s*const post = \(p, b\) => fetch\(p, \{[^\n]*\n/, () => '\n' + localApi + '\n');
if (!page.includes('ECW.api.handle')) throw new Error('could not find the post() call to replace in web/index.html');
page = page.replace('<script>\n(() => {', () => `<script>\n${bundle}\n</script>\n<script>\n(() => {`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'ecw-validator.html'), page);
// The Artifact host wraps the file in its own doctype/head/body: give it the inner parts only.
const head = page.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta[^>]*>\s*/g, '');
const body = page.match(/<body>([\s\S]*)<\/body>/)[1];
fs.writeFileSync(path.join(root, 'dist', 'ecw-validator.artifact.html'), head.trim() + '\n' + body.trim() + '\n');
console.log(`built dist/ecw-validator.html (${(page.length / 1024).toFixed(0)} KB) and dist/ecw-validator.artifact.html`);
