#!/usr/bin/env node
// ecw-validate — validate eCW security settings against a baseline spreadsheet.
//
//   ecw-validate validate --baseline baseline.xlsx --actual ecw-export.xlsx [--out report.xlsx] [options]
//   ecw-validate inspect  <file.xlsx|csv>          show how a file is read (sheets, layout, users, settings)
//   ecw-validate serve    [--port 8787]            local web UI (drag the two files in, download the report)
//   ecw-validate example  [dir]                    write a sample baseline + eCW export to try it on
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateToFile, readSpreadsheet, workbookToRecords, textSummary, describeLayout } from '../src/index.js';

const HELP = `ecw-validate — validate eClinicalWorks security settings against a baseline spreadsheet

Usage
  ecw-validate validate --baseline <file> --actual <file> [--out report.xlsx] [options]
  ecw-validate inspect <file> [--sheet NAME] [--layout long|matrix] ...
  ecw-validate serve [--port 8787] [--host 127.0.0.1]
  ecw-validate example [dir]

Files may be .xlsx, .csv or .tsv. The baseline says what every user (or role) SHOULD have; the
"actual" file is eCW's exported security settings (Admin → Security Settings → Print/Export, or the
User Security Settings report). Both may be a grid (settings down, users across — or the reverse) or
one row per user + setting; the layout is detected from the header row.

Options (prefix with --baseline- or --actual- to apply to one file only, e.g. --actual-sheet)
  --sheet NAME            sheet to read (default: first sheet with permission data)
  --layout long|matrix    force a layout instead of detecting it
  --orientation permissions-down|users-down   matrix orientation
  --user-col NAME         column holding the user (long layout)      also --permission-col, --value-col, --category-col
  --roles-sheet NAME      user → role mapping sheet in the baseline (expands role rows to users)
  --blank-is-unknown      a blank matrix cell is "not stated" rather than "not granted"
Comparison
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
    const flag = /^(json|quiet|include-ok|no-unknown-settings|blank-is-unknown|help|baseline-blank-is-unknown|actual-blank-is-unknown)$/.test(key);
    const val = eq > 0 ? a.slice(eq + 1) : (flag || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]);
    args[key] = val;
  }
  return args;
}

const fileOpts = (args, prefix) => {
  const g = k => args[`${prefix}-${k}`] ?? args[k];
  const o = { sheet: g('sheet'), layout: g('layout'), orientation: g('orientation'), subjectCol: g('user-col'), permissionCol: g('permission-col'), valueCol: g('value-col'), categoryCol: g('category-col'), rolesSheet: g('roles-sheet'), blankIsNo: !g('blank-is-unknown') };
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
      compare: { ignoreUsers: args['ignore-users'], ignorePermissions: args['ignore-settings'] ?? args['ignore-permissions'], onlyUsers: args['only-users'], reportUnknownPermissions: !args['no-unknown-settings'], reportOk: !!args['include-ok'] },
    };
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
    const wb = readSpreadsheet(file);
    process.stdout.write(`${file}: ${wb.sheets.length} sheet(s)\n`);
    for (const s of wb.sheets) process.stdout.write(`  • ${s.name}: ${s.rows.length} rows × ${Math.max(0, ...s.rows.map(r => r.length))} cols; header guess: ${JSON.stringify((s.rows[0] || []).slice(0, 8))}\n`);
    const x = workbookToRecords(wb, fileOpts(args, 'baseline'));
    const users = [...new Set(x.records.map(r => r.subject))], perms = [...new Set(x.records.map(r => r.permission))];
    process.stdout.write(`\nread as: sheet "${x.sheet}", ${describeLayout(x)}\n  ${x.records.length} records, ${users.length} users, ${perms.length} settings\n`);
    if (x.roleMap) process.stdout.write(`  role map: ${Object.keys(x.roleMap).length} users → ${new Set(Object.values(x.roleMap)).size} roles\n`);
    process.stdout.write(`  users: ${users.slice(0, 15).join(', ')}${users.length > 15 ? ', …' : ''}\n  settings: ${perms.slice(0, 15).join(' | ')}${perms.length > 15 ? ' | …' : ''}\n`);
    const vals = new Map(); for (const r of x.records) vals.set(r.value, (vals.get(r.value) || 0) + 1);
    process.stdout.write(`  values: ${[...vals].map(([v, n]) => `${v || '(blank)'}×${n}`).join(', ')}\n`);
    if (args.json) process.stdout.write(JSON.stringify(x.records.slice(0, Number(args.limit) || 50), null, 2) + '\n');
    return 0;
  }

  if (cmd === 'serve') {
    const { serve } = await import('../src/server.js');
    const port = Number(args.port) || Number(process.env.PORT) || 8787;
    const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
    const s = await serve({ port, host });
    process.stdout.write(`eCW security validator: http://${host}:${s.port}/  (Ctrl-C to stop)\n`);
    await new Promise(() => {});
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

main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`error: ${e.message}\n`); process.exit(2); });
