// Bundles the engine's ES modules into one script without a bundler: each module becomes a function
// that receives the modules it imports (linked twice, so the parse ↔ catalog cycle resolves).
// Used by build-web.mjs (browser: node:* replaced by shims) and build-exe.mjs (Node: node:* required).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const modName = spec => path.basename(spec).replace(/\.js$/, '').replace('zlib-browser', 'zlib');

/**
 * transform(id, src, { shim, strip }) → the module as `M.<id> = (() => { … })();`
 *   shim(name, mod, names) → the statement that stands in for `import name from 'node:mod'`
 *   strip: regexes; top-level lines matching any are dropped (an entry point's auto-run, say)
 */
export function transform(id, src, { shim, strip = [] } = {}) {
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
    if (strip.some(re => re.test(line))) continue;
    if ((m = line.match(/^import\s+\{([^}]*)\}\s+from\s+'(\.\.?\/[^']+)';\s*$/))) { addImport(m[2], m[1].split(',')); continue; }
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
  const ref = m => `M[${JSON.stringify(m)}]`;
  const link = [...imports].map(([mod, list]) => `if (${ref(mod)}) { ${list.map(i => `${i.alias} = ${ref(mod)}.${i.name};`).join(' ')} }`).join(' ');
  const shims = nodeShims.map(([name, mod, names]) => shim(name, mod, names, id)).join('\n');
  const starMerge = stars.map(s => `Object.assign(__exports, ${ref(s)});`).join(' ');
  return `${ref(id)} = (() => {\n${allNames.length ? `let ${allNames.join(', ')};` : ''}\nconst __link = () => { ${link} }; __links.push(__link); __link();\n${shims}\n${out.join('\n')}\nconst __exports = { ${[...exports].join(', ')} }; ${starMerge}\nreturn __exports;\n})();\n`;
}

/** The engine modules in dependency order (the parse ↔ catalog cycle is fine: links run again after all bodies). */
export const ENGINE = [
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
