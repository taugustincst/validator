#!/usr/bin/env node
// Builds the standalone executable: the whole app (engine, web page, command line) in one file that
// needs no Node installation — a Node "single executable application".
//
//   node bin/build-exe.mjs                 → dist/ecw-validator.exe   (Windows x64)
//   node bin/build-exe.mjs --linux         → dist/ecw-validator       (Linux x64, for this machine)
//   node bin/build-exe.mjs --node-zip P    → use an already downloaded node-v<ver>-win-x64.zip
//
// Steps: bundle the ES modules into one CommonJS script (dist/ecw-validator.cjs), write the SEA
// config with web/index.html as an asset, generate the blob with this machine's node, fetch the
// matching Node build for Windows from nodejs.org (verified against SHASUMS256.txt), and inject the
// blob with postject. Needs internet for the download and for `npx postject` the first time.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { transform, ENGINE, root, read } from './bundle-lib.mjs';

const args = process.argv.slice(2);
const linux = args.includes('--linux');
const zipArg = args.indexOf('--node-zip') >= 0 ? args[args.indexOf('--node-zip') + 1] : null;
const dist = path.join(root, 'dist'); fs.mkdirSync(dist, { recursive: true });

// 1. One CommonJS script. node:* modules are required (the SEA `require` serves built-ins).
const shim = (name, mod, names) => names ? `const { ${names.replace(/\s+as\s+/g, ': ')} } = require('node:${mod}');` : `const ${name} = require('node:${mod}');`;
const MODULES = [['zlib', 'src/zlib.js'], ...ENGINE, ['server', 'src/server.js'], ['examples', 'examples/make-examples.js'], ['ecw-validate', 'bin/ecw-validate.js'], ['app', 'bin/exe-main.js']];
const fix = (id, src) => {
  if (id === 'server') src = src.replace("const here = path.dirname(fileURLToPath(import.meta.url));", "const here = process.cwd();");
  if (id === 'examples') src = src.replace(/^if \(process\.argv\[1\][\s\S]*?\n\}\n/m, '').replace(/path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/g, 'process.cwd()');   // drop the run-as-script block
  if (id === 'ecw-validate') src = src.replace("const { serve } = await import('../src/server.js');", 'const { serve } = M.server;').replace("const { writeExamples } = await import('../examples/make-examples.js');", 'const { writeExamples } = M.examples;').replace("path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples')", "path.join(process.cwd(), 'examples')");
  if (/import\.meta/.test(src)) throw new Error(`${id}: import.meta left in the bundle`);
  return src;
};
const script = [
  "'use strict';",
  'const M = {}; const __links = [];',
  ...MODULES.map(([id, file]) => transform(id, fix(id, read(file)), { shim, strip: [/^#!/, /^main\(process\.argv/, /^\/\/ Set the exit code/, /^\/\/ a pipe \(--json/] })),
  '__links.forEach(l => l());',
  'globalThis.__ECW_SERVER = M.server;',
  "try { const sea = require('node:sea'); if (sea.isSea()) globalThis.__ECW_PAGE = Buffer.from(sea.getAsset('index.html')); } catch {}",
  "M.app.run(process.argv.slice(2)).then(code => { if (code !== undefined) process.exitCode = code; }, e => { process.stderr.write(`error: ${e.message}\\n`); process.exitCode = 2; });",
].join('\n');
const cjs = path.join(dist, 'ecw-validator.cjs');
fs.writeFileSync(cjs, script);
new Function('require', 'module', 'exports', script.replace(/^M\.app\.run[\s\S]*$/m, ''));   // syntax check only

// 2. The SEA blob (this machine's node writes it; the blob is portable across platforms of the same Node version).
const seaConfig = { main: cjs, output: path.join(dist, 'ecw-validator.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, assets: { 'index.html': path.join(root, 'web', 'index.html') } };
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(dist, 'sea-config.json')], { stdio: 'inherit' });

// 3. The Node binary to inject into.
let exe;
if (linux) { exe = path.join(dist, 'ecw-validator'); fs.copyFileSync(process.execPath, exe); }
else {
  const ver = process.version;   // the blob must match the binary's Node version
  const zipName = `node-${ver}-win-x64.zip`;
  const zip = zipArg || path.join(dist, zipName);
  if (!fs.existsSync(zip)) {
    console.log(`downloading ${zipName} from nodejs.org …`);
    const res = await fetch(`https://nodejs.org/dist/${ver}/${zipName}`); if (!res.ok) throw new Error(`download failed: ${res.status}`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const sums = await (await fetch(`https://nodejs.org/dist/${ver}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find(l => l.endsWith(zipName))?.split(/\s+/)[0];
  const have = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (!want || want !== have) throw new Error(`checksum mismatch for ${zipName}`);
  exe = path.join(dist, 'ecw-validator.exe');
  fs.writeFileSync(exe, unzipOne(fs.readFileSync(zip), /node\.exe$/));
}

// 4. Inject. postject comes from npm (a build-time tool only; the executable has no dependencies).
const pjArgs = [exe, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
const r = process.env.POSTJECT ? spawnSync(process.env.POSTJECT, pjArgs, { stdio: 'inherit' })   // POSTJECT=/path/to/postject skips npx
  : spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'postject@1.0.0-alpha.6', ...pjArgs], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) throw new Error('postject failed');
console.log(`built ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB)`);

/** The first entry of a zip whose name matches `re`, inflated (stored or deflated). */
function unzipOne(buf, re) {
  const zlib = require_('node:zlib');
  let eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    if (re.test(name)) {
      const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28), start = lho + 30 + lnlen + lelen;
      const data = buf.subarray(start, start + csize);
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    }
    off += 46 + nlen + elen + clen;
  }
  throw new Error('node.exe not found in the zip');
}
function require_(m) { return globalThis.process.getBuiltinModule ? process.getBuiltinModule(m) : null; }
