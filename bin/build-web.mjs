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
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// Module order: dependencies first (the parse ↔ catalog cycle is fine: links run again after all bodies).
const MODULES = [
  ['zlib', 'src/zlib-browser.js'],
  ['xlsx', 'src/xlsx.js'],
  ['parse', 'src/parse.js'],
  ['catalog', 'src/catalog.js'],
  ['validate', 'src/validate.js'],
  ['report', 'src/report.js'],
  ['document', 'src/document.js'],
  ['summary', 'src/summary.js'],
  ['pdf', 'src/pdf.js'],
  ['screen', 'src/screen.js'],
  ['index', 'src/index.js'],
  ['api', 'src/api.js'],
];
const modName = spec => path.basename(spec).replace(/\.js$/, '').replace('zlib-browser', 'zlib');

function transform(id, src) {
  const imports = new Map();   // module id → [{ name, alias }]
  const exports = new Set();
  const reexports = [];        // { from, names: [[name, alias]] } — export { a as b } from './x.js'
  const stars = [];            // export * from './x.js'
  const nodeShims = [];
  const lines = src.split('\n');
  const out = [];
  const addImport = (from, list) => { const m = modName(from); if (!imports.has(m)) imports.set(m, []); for (const item of list) { const [name, alias] = item.split(/\s+as\s+/).map(s => s.trim()); if (name) imports.get(m).push({ name, alias: alias || name }); } };
  for (let line of lines) {
    let m;
    if ((m = line.match(/^import\s+\{([^}]*)\}\s+from\s+'(\.\/[^']+)';\s*$/))) { addImport(m[2], m[1].split(',')); continue; }
    if ((m = line.match(/^import\s+(\w+)\s+from\s+'node:(\w+)';\s*$/))) { nodeShims.push([m[1], m[2]]); continue; }
    if ((m = line.match(/^import\s+\{([^}]*)\}\s+from\s+'node:(\w+)';\s*$/))) { nodeShims.push([null, m[2], m[1]]); continue; }
    if ((m = line.match(/^export\s+\*\s+from\s+'(\.\/[^']+)';\s*$/))) { stars.push(modName(m[1])); continue; }
    if ((m = line.match(/^export\s+\{([^}]*)\}\s+from\s+'(\.\/[^']+)';\s*$/))) { reexports.push({ from: modName(m[2]), names: m[1].split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+as\s+/).map(x => x.trim())) }); continue; }
    if ((m = line.match(/^export\s+\{([^}]*)\};\s*$/))) { for (const s of m[1].split(',')) { const [name, alias] = s.split(/\s+as\s+/).map(x => x.trim()); if (name) { exports.add(alias ? `${alias}: ${name}` : name); } } continue; }
    if ((m = line.match(/^export\s+(async\s+function|function|const|let|class)\s+(\w+)/))) { exports.add(m[2]); line = line.replace(/^export\s+/, ''); }
    out.push(line);
  }
  // Re-exports: pull them in as imports under their alias and export them.
  for (const r of reexports) for (const [name, alias] of r.names) { addImport('./' + r.from + '.js', [`${name} as ${alias || name}`]); exports.add(alias || name); }
  const importDecls = [...imports].map(([mod, list]) => list.map(i => i.alias));
  const allNames = [...new Set(importDecls.flat())];
  const link = [...imports].map(([mod, list]) => `if (M.${mod}) { ${list.map(i => `${i.alias} = M.${mod}.${i.name};`).join(' ')} }`).join(' ');
  const shims = nodeShims.map(([name, mod, names]) => {
    if (mod === 'fs') return `const ${name} = __fs;`;
    if (mod === 'path') return `const ${name} = __path;`;
    if (mod === 'url') return `const ${names ? names.replace(/\s+as\s+/g, ':') : name} = __url;`;
    if (mod === 'http') return `const ${name} = null;`;
    if (mod === 'zlib') return `const ${name} = null;`;
    throw new Error(`${id}: no browser shim for node:${mod}`);
  }).join('\n');
  const starMerge = stars.map(s => `Object.assign(__exports, M.${s});`).join(' ');
  return `M.${id} = (() => {\n${allNames.length ? `let ${allNames.join(', ')};` : ''}\nconst __link = () => { ${link} }; __links.push(__link); __link();\n${shims}\n${out.join('\n')}\nconst __exports = { ${[...exports].join(', ')} }; ${starMerge}\nreturn __exports;\n})();\n`;
}

const bundle = ['const M = {}; const __links = [];',
  `const __fs = { readFileSync: () => { throw new Error('file paths are not available in the browser; pass the file contents'); }, writeFileSync: () => { throw new Error('not available in the browser'); }, mkdirSync: () => {}, existsSync: () => false, readdirSync: () => [] };`,
  `const __path = { basename: p => String(p).replace(/^.*[\\\\/]/, ''), dirname: p => String(p).replace(/[\\\\/][^\\\\/]*$/, '') || '.', resolve: (...a) => a.join('/'), join: (...a) => a.join('/') };`,
  `const __url = { fileURLToPath: u => String(u) };`,
  read('src/buffer-shim.js').replace(/^export\s+/gm, ''),
  ...MODULES.map(([id, file]) => transform(id, read(file))),
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
