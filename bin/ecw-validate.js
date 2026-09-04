#!/usr/bin/env node
// ecw-validate — validate eCW security settings against a baseline spreadsheet.
//
//   ecw-validate validate --baseline baseline.xlsx --actual ecw-export.xlsx [--out report.xlsx] [options]
//   ecw-validate inspect  <file.xlsx|csv>          show how a file is read (sheets, layout, users, settings)
//   ecw-validate serve    [--port 8787]            local web UI (drag the two files in, download the report)
//   ecw-validate example  [dir]                    write a sample baseline + eCW export to try it on
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { validateToFile, inspect, loadAliases, loadCatalog, loadUsersFile, buildTemplate, textSummary } from '../src/index.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) { process.stderr.write(`ecw-validate needs Node.js 20 or newer (this is ${process.version}). Install it from https://nodejs.org\n`); process.exit(2); }

const HELP = `ecw-validate — validate eClinicalWorks security settings against a baseline spreadsheet

Usage
  ecw-validate validate --baseline <file> --actual <file> [--out report.xlsx] [options]
  ecw-validate inspect <file> [--sheet NAME] [--layout long|matrix] [--catalog <file>] ...
  ecw-validate serve [--port 8787] [--host 127.0.0.1] [--open]
  ecw-validate template --catalog <file> [--out baseline-template.xlsx] [--roles a,b,c] [--groups "Billing,Progress Notes"]
  ecw-validate example [dir]

Files may be .xlsx, .csv or .tsv. The baseline says what every user (or role) SHOULD have; the
"actual" file is eCW's exported security settings (Admin → Security Settings → Print/Export, or the
User Security Settings report). Both may be a grid (settings down, users across — or the reverse) or
one row per user + setting; the layout is detected from the header row.

Options (prefix with --baseline- or --actual- to apply to one file only, e.g. --actual-sheet)
  --sheet NAME|all        sheet to read (default: first sheet with permission data; "all" merges every sheet)
  --layout long|matrix    force a layout instead of detecting it
  --orientation permissions-down|users-down   matrix orientation
  --user-col NAME         column holding the user (long layout)      also --permission-col, --value-col, --category-col
  --roles-sheet NAME      user → role mapping sheet in the baseline (expands role rows to users)
  --users FILE            user → role list in a separate .csv/.xlsx (User | Role) when the baseline's columns are roles
  --ignore-roles a*,b     role or user columns (grid) / rows (list) to leave out while reading, e.g. "eCW SUPPORT*"

  --blank-is-unknown      a blank matrix cell is "not stated" rather than "not granted"
Catalog
  --catalog FILE          eCW's Security Settings catalog export (setting name / description / type / group). Findings
                          get each setting's group and what it controls; the report gains Coverage and Not-in-catalog
                          sheets; baseline names the catalog does not know are flagged with the closest real name.
Comparison
  --aliases FILE          .csv/.xlsx of names that differ between the documents: baseline name, eCW name
                          (optional first column "user" or "setting"); applied before comparing
  --no-match-by-name      do not pair a setting by its bare name when the category differs
  --ignore-users a,b*     users to leave out (globs)        --only-users a,b*   compare only these users
  --ignore-settings a*,b  settings to leave out (globs)     --no-unknown-settings   hide settings the baseline does not cover
  --include-ok            list matching pairs in the report too
Output
  --out FILE              report: .xlsx (default), .csv (findings) or .json
  --json                  print the full result as JSON to stdout
  --quiet                 print only the one-line verdict
  --limit N               findings to print in the terminal (default 40)
  --fail-on high|medium|low|none   exit 1 when a finding of this severity or worse exists (default medium)
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
    const flag = /^(json|quiet|include-ok|no-unknown-settings|no-match-by-name|blank-is-unknown|help|open|baseline-blank-is-unknown|actual-blank-is-unknown)$/.test(key);
    const val = eq > 0 ? a.slice(eq + 1) : (flag || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]);
    args[key] = val;
  }
  return args;
}

const fileOpts = (args, prefix) => {
  const g = k => args[`${prefix}-${k}`] ?? args[k];
  const o = { sheet: g('sheet'), layout: g('layout'), orientation: g('orientation'), subjectCol: g('user-col'), permissionCol: g('permission-col'), valueCol: g('value-col'), categoryCol: g('category-col'), rolesSheet: g('roles-sheet'), usersFile: g('users'), ignoreSubjects: g('ignore-roles'), blankIsNo: !g('blank-is-unknown') };
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === true) delete o[k];
  if (o.blankIsNo === undefined) o.blankIsNo = true;
  return o;
};

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') { process.stdout.write(HELP); return 0; }

  if (cmd === 'validate') {
    if (!args.baseline || !args.actual || args.baseline === true || args.actual === true) { process.stderr.write('validate needs --baseline <file> and --actual <file>\n\n' + HELP); return 2; }
    const out = args.out === true ? 'ecw-validation-report.xlsx' : args.out;
    const opts = {
      baseline: fileOpts(args, 'baseline'), actual: fileOpts(args, 'actual'),
      compare: { ignoreUsers: args['ignore-users'], ignorePermissions: args['ignore-settings'] ?? args['ignore-permissions'], onlyUsers: args['only-users'], aliases: typeof args.aliases === 'string' ? loadAliases(args.aliases) : undefined, matchByName: !args['no-match-by-name'], reportUnknownPermissions: !args['no-unknown-settings'], reportOk: !!args['include-ok'] },
    };
    if (typeof args.catalog === 'string') opts.catalog = args.catalog;
    for (const [k, f] of [['baseline', args.baseline], ['actual', args.actual], ['catalog', opts.catalog], ['aliases', typeof args.aliases === 'string' ? args.aliases : undefined], ['users', opts.baseline.usersFile]]) if (f && !fs.existsSync(f)) { process.stderr.write(`error: ${k} file not found: ${f}\n`); return 2; }
    const v = validateToFile(args.baseline, args.actual, out, opts);
    if (args.json) process.stdout.write(JSON.stringify({ meta: v.meta, ...v.result }, null, 2) + '\n');
    else if (args.quiet) process.stdout.write(`${v.result.pass ? 'PASS' : 'FAIL'}: ${v.result.bySeverity.high} high, ${v.result.bySeverity.medium} medium, ${v.result.bySeverity.low} low, ${v.result.bySeverity.info} info\n`);
    else process.stdout.write(textSummary(v.result, { ...v.meta, limit: Number(args.limit) || 40 }) + '\n' + (out ? `\nreport written to ${out}\n` : ''));
    const failOn = String(args['fail-on'] || 'medium');
    const worst = v.result.bySeverity.high ? 'high' : v.result.bySeverity.medium ? 'medium' : v.result.bySeverity.low ? 'low' : 'none';
    const rank = { none: 0, low: 1, medium: 2, high: 3 };
    return failOn !== 'none' && rank[worst] >= (rank[failOn] ?? 2) ? 1 : 0;
  }

  if (cmd === 'inspect') {
    const file = args._[1]; if (!file) { process.stderr.write('inspect needs a file\n'); return 2; }
    if (!fs.existsSync(file)) { process.stderr.write(`error: file not found: ${file}\n`); return 2; }
    const io = fileOpts(args, 'baseline'); if (typeof args.catalog === 'string') { if (!fs.existsSync(args.catalog)) { process.stderr.write(`error: catalog file not found: ${args.catalog}\n`); return 2; } io.catalog = args.catalog; }
    const x = inspect(file, io);
    if (args.json) { process.stdout.write(JSON.stringify(x, null, 2) + '\n'); return x.error ? 1 : 0; }
    const w = process.stdout.write.bind(process.stdout);
    w(`${file}: ${x.sheets.length} sheet(s)\n`);
    for (const s of x.sheets) w(`  • ${s.name}: ${s.rows} rows × ${s.cols} cols; header on row ${s.headerRow}: ${s.headers.slice(0, 8).map(h => JSON.stringify(h)).join(', ')}${s.headers.length > 8 ? ', …' : ''}\n`);
    if (x.error) { w(`\ncould not read permission data: ${x.error}\n`); return 1; }
    if (x.kind === 'catalog') {
      w(`\nread as: sheet "${x.sheet}" — ${x.readAs}\n  ${x.records} settings in ${x.groups.length} groups\n`);
      w(`  groups: ${x.groups.slice(0, 12).map(g => `${g.group} (${g.settings})`).join(', ')}${x.groups.length > 12 ? ', …' : ''}\n`);
      for (const m of x.warnings) w(`  ! ${m}\n`);
      w(`\n  first settings:\n`);
      for (const r of x.sample.slice(0, Number(args.limit) || 8)) w(`    row ${String(r.row).padStart(4)}  ${r.setting.padEnd(50)} [${r.value}]  ${String(r.raw).slice(0, 70)}\n`);
      w(`\n  next: ecw-validate template --catalog ${file} --out baseline-template.xlsx   (a baseline to fill in)\n`);
      return 0;
    }
    w(`\nread as: sheet "${x.sheet}" — ${x.readAs}\n  ${x.records} records, ${x.users.length} users, ${x.settings.length} settings\n`);
    if (x.roleMap) w(`  role map: ${Object.keys(x.roleMap).length} users → ${new Set(Object.values(x.roleMap)).size} roles\n`);
    w(`  users: ${x.users.slice(0, 15).map(u => u.name + (u.role ? ` (${u.role})` : '')).join(', ')}${x.users.length > 15 ? ', …' : ''}\n`);
    w(`  settings: ${x.settings.slice(0, 12).map(s => s.name).join(' | ')}${x.settings.length > 12 ? ' | …' : ''}\n`);
    w(`  values: ${x.values.map(v => `${v.value}×${v.count}`).join(', ')}\n`);
    for (const m of x.warnings) w(`  ! ${m}\n`);
    w(`\n  first records:\n`);
    for (const r of x.sample.slice(0, Number(args.limit) || 8)) w(`    row ${String(r.row).padStart(4)}  ${r.user.padEnd(18)} ${r.setting.padEnd(44)} ${r.value}${String(r.raw) !== r.value ? ` (cell: ${JSON.stringify(r.raw)})` : ''}\n`);
    if (x.catalogCheck) {
      const c = x.catalogCheck;
      w(`\n  against the catalog ${c.catalog} (${c.total} settings): ${c.known} of this file's ${x.settings.length} settings are known, ${c.unknown.length} are not; ${c.uncovered.length} catalog settings are not in this file\n`);
      for (const u of c.unknown.slice(0, Number(args.limit) || 40)) w(`    ? ${u.name}${u.suggestion ? `  → closest: "${u.suggestion}" (${u.group})` : ''}\n`);
      if (c.unknown.length > (Number(args.limit) || 40)) w(`    … ${c.unknown.length - (Number(args.limit) || 40)} more (--json for all)\n`);
      if (c.uncovered.length) w(`    not in this file: ${c.uncovered.slice(0, 10).map(u => u.name).join(' | ')}${c.uncovered.length > 10 ? ' | …' : ''}\n`);
    }
    return 0;
  }

  if (cmd === 'serve') {
    const { serve } = await import('../src/server.js');
    const port = Number(args.port) || Number(process.env.PORT) || 8787;
    const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
    const s = await serve({ port, host });
    const link = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${s.port}/`;
    process.stdout.write(`eCW security validator: ${link}  (Ctrl-C to stop)\n`);
    if (args.open) { const { exec } = await import('node:child_process'); exec((process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open') + ' ' + link, () => {}); }
    await new Promise(() => {});
    return 0;
  }

  if (cmd === 'template') {
    if (typeof args.catalog !== 'string') { process.stderr.write('template needs --catalog <eCW security settings catalog export>\n'); return 2; }
    if (!fs.existsSync(args.catalog)) { process.stderr.write(`error: catalog file not found: ${args.catalog}\n`); return 2; }
    const out = typeof args.out === 'string' ? args.out : 'baseline-template.xlsx';
    const roles = typeof args.roles === 'string' ? args.roles.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const groups = typeof args.groups === 'string' ? args.groups.split(',').map(s => s.trim()).filter(Boolean) : null;
    const cat = loadCatalog(args.catalog);
    fs.writeFileSync(out, buildTemplate(cat, { roles, groups }));
    const n = groups ? cat.settings.filter(s => groups.some(g => g.toLowerCase() === s.group.toLowerCase())).length : cat.settings.length;
    process.stdout.write(`wrote ${out}: ${n} settings${groups ? ` in ${groups.length} group(s)` : ` in ${cat.groups.size} groups`}, columns for ${(roles || ['Provider', 'Nurse', 'Front Desk', 'Biller', 'Practice Admin']).join(', ')}\nFill in Y/N per role on the Permissions sheet and the user → role list on the Users sheet, then validate with --baseline ${out} --catalog ${args.catalog}\n`);
    return 0;
  }

  if (cmd === 'example') {
    const { writeExamples } = await import('../examples/make-examples.js');
    const dir = args._[1] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
    for (const f of writeExamples(dir)) process.stdout.write(`wrote ${f}\n`);
    process.stdout.write(`\ntry: ecw-validate validate --baseline ${path.join(dir, 'baseline.xlsx')} --actual ${path.join(dir, 'ecw-export.xlsx')} --out ${path.join(dir, 'report.xlsx')}\n`);
    return 0;
  }

  process.stderr.write(`unknown command "${cmd}"\n\n` + HELP);
  return 2;
}

// Set the exit code and let the process end on its own: process.exit() right after a large write to
// a pipe (--json into another program) would cut the output off at 64 KB.
main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 2; });
