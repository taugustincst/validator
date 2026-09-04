import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildXlsx, readXlsx, parseCsv, readSpreadsheet, unzip, zip as buildZip } from '../src/xlsx.js';
import { normalizeValue, detectLayout, extractRecords, extractRoleMap, workbookToRecords, findHeaderRow } from '../src/parse.js';
import { compare } from '../src/validate.js';
import { validate, validateToFile, textSummary, findingsCsv } from '../src/index.js';
import { serve } from '../src/server.js';
import { writeExamples, baselineSheets, ecwExportRows, DEVIATIONS } from '../examples/make-examples.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecw-validator-'));
const [BASELINE, EXPORT] = writeExamples(tmp);

// ───────── spreadsheet I/O ─────────

test('xlsx: write → read round-trips strings, numbers, booleans, blanks and special characters', () => {
  const rows = [['A', 'B & C', '<D>'], ['x', 1.5, true], ['', '', 'only C'], ['q"uote', "it's", 'ünïcödé ✓']];
  const buf = buildXlsx([{ name: 'S1', rows }, { name: 'Bad/Name?', rows: [['h1', 'h2'], [1, 2]] }]);
  const z = unzip(buf);
  assert.ok(z.has('xl/workbook.xml') && z.has('xl/worksheets/sheet2.xml') && z.has('[Content_Types].xml'));
  const wb = readXlsx(buf);
  assert.equal(wb.sheets.length, 2);
  assert.equal(wb.sheets[0].name, 'S1');
  assert.equal(wb.sheets[1].name, 'Bad Name ');
  assert.deepEqual(wb.sheets[0].rows, rows);
});

test('xlsx: shared strings, rich text, cached formula values and sparse cell refs are read', () => {
  // A hand-built workbook the way Excel writes it: shared strings (with a rich-text run), a formula with a cached value, gaps.
  const zipParts = [
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>' },
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="Data" sheetId="1" r:id="rId9"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId9" Type="w" Target="/xl/worksheets/sheet7.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>User</t></si><si><r><t>Sec</t></r><r><rPr><b/></rPr><t xml:space="preserve"> Setting</t></r></si><si><t>jdoe</t></si></sst>' },
    { name: 'xl/worksheets/sheet7.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Value</t></is></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="str"><f>CONCAT("a","b")</f><v>ab</v></c><c r="C3"><v>42</v></c><c r="D3" t="b"><v>1</v></c></row></sheetData></worksheet>' },
  ];
  const wb = readXlsx(buildZip(zipParts));
  assert.equal(wb.sheets[0].name, 'Data');
  assert.deepEqual(wb.sheets[0].rows, [['User', 'Sec Setting', '', 'Value'], [], ['jdoe', 'ab', 42, true]]);
});

test('csv: quoted fields, embedded commas/newlines, CRLF, BOM, tab detection, numbers', () => {
  const rows = parseCsv('﻿User,Setting,Value\r\n"Smith, Jane","Notes\nLock",Y\r\njdoe,x,0\r\n');
  assert.deepEqual(rows, [['User', 'Setting', 'Value'], ['Smith, Jane', 'Notes\nLock', 'Y'], ['jdoe', 'x', 0]]);
  assert.deepEqual(parseCsv('a\tb\tc\n1\t2\t3'), [['a', 'b', 'c'], [1, 2, 3]]);
  const f = path.join(tmp, 'x.tsv'); fs.writeFileSync(f, 'user\tsetting\tvalue\nj\ts\tY\n');
  assert.deepEqual(readSpreadsheet(f).sheets[0].rows[1], ['j', 's', 'Y']);
});

test('readSpreadsheet: an old .xls or a non-spreadsheet is refused with a clear message', () => {
  const xls = path.join(tmp, 'old.xls'); fs.writeFileSync(xls, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
  assert.throws(() => readSpreadsheet(xls), /legacy \.xls/);
  const zipNotXlsx = path.join(tmp, 'z.xlsx'); fs.writeFileSync(zipNotXlsx, buildZip([{ name: 'hello.txt', data: 'hi' }]));
  assert.throws(() => readSpreadsheet(zipNotXlsx), /not an \.xlsx workbook/);
});

// ───────── parsing ─────────

test('values: Y/N, yes/no, checkmarks, allow/deny, booleans, numbers and blanks normalize; levels are kept as text', () => {
  for (const v of ['Y', 'yes', 'YES', 'x', '✓', '☑', 'Allow', 'Granted', 'TRUE', 1, true, 'Full Access', 'Enabled']) assert.equal(normalizeValue(v), 'Y', String(v));
  for (const v of ['N', 'no', '', ' ', '-', '—', 'Deny', 'None', 'FALSE', 0, false, 'N/A', 'Unchecked', 'Not Allowed']) assert.equal(normalizeValue(v), 'N', String(v));
  assert.equal(normalizeValue('Read Only'), 'read only');
  assert.equal(normalizeValue('View-Only'), 'view only');
});

test('layout: header row is found below title lines, and Y/N data rows are never mistaken for it', () => {
  const rows = [['eClinicalWorks — User Security Settings'], ['Practice: X', '', 'Printed: 2026-09-01'], [], ['User Name', 'Category', 'Security Setting', 'Value'], ['JDOE', 'Patient', 'Delete', 'Yes'], ['', 'Patient', 'Merge', 'No']];
  assert.equal(findHeaderRow(rows), 3);
  const lay = detectLayout(rows);
  assert.equal(lay.layout, 'long');
  assert.deepEqual([lay.subjectCol, lay.categoryCol, lay.permissionCol, lay.valueCol], [0, 1, 2, 3]);
  const grid = [['Category', 'Security Setting', 'Provider', 'Front Desk', 'Nurse', 'Biller', 'Practice Admin'], ['Patient', 'View', 'Y', 'Y', 'Y', 'Y', 'Y'], ['Patient', 'Edit', 'Y', 'Y', 'Y', 'N', 'Y']];
  assert.equal(findHeaderRow(grid), 0);
  const g = detectLayout(grid);
  assert.equal(g.layout, 'matrix', '"Provider" as a column header is a role, not a user column');
  assert.equal(g.orientation, 'permissions-down');
  assert.equal(g.categoryCol, 0); assert.equal(g.permissionCol, 1); assert.equal(g.firstDataCol, 2);
});

test('long layout: the user (and category) carry down blank cells, as eCW prints them', () => {
  const rows = [['User', 'Category', 'Setting', 'Value'], ['jdoe', 'Patient', 'Delete', 'Yes'], ['', '', 'Merge', 'No'], ['', 'Billing', 'Post', 'Yes'], ['asmith', 'Patient', 'Delete', 'No']];
  const { records } = extractRecords(rows);
  assert.deepEqual(records.map(r => [r.subject, r.permission, r.value]), [['jdoe', 'Patient > Delete', 'Y'], ['jdoe', 'Patient > Merge', 'N'], ['jdoe', 'Billing > Post', 'Y'], ['asmith', 'Patient > Delete', 'N']]);
  assert.equal(records[2].row, 4, 'row numbers are 1-based sheet rows for the report');
});

test('matrix layout: settings down / users across, section headings, blank-is-no, and the transposed grid', () => {
  const down = [['Security Setting', 'jdoe', 'asmith'], ['Patient'], ['Delete', 'Y', ''], ['Merge', '', 'x'], ['Billing'], ['Post payments', 'N', 'Y']];
  const d = extractRecords(down);
  assert.equal(d.layout.orientation, 'permissions-down');
  assert.deepEqual(d.records.map(r => [r.subject, r.permission, r.value]), [['jdoe', 'Patient > Delete', 'Y'], ['asmith', 'Patient > Delete', 'N'], ['jdoe', 'Patient > Merge', 'N'], ['asmith', 'Patient > Merge', 'Y'], ['jdoe', 'Billing > Post payments', 'N'], ['asmith', 'Billing > Post payments', 'Y']]);
  const sparse = extractRecords(down, { blankIsNo: false });
  assert.equal(sparse.records.length, 4, 'blank cells are skipped when blankIsNo is off');
  const across = [['User', 'Delete patient', 'Merge patients', 'Post payments'], ['jdoe', 'Y', 'N', 'N'], ['asmith', 'N', 'Y', 'Y']];
  const a = extractRecords(across);
  assert.equal(a.layout.orientation, 'users-down');
  assert.deepEqual(a.records.filter(r => r.subject === 'asmith').map(r => `${r.permission}=${r.value}`), ['Delete patient=N', 'Merge patients=Y', 'Post payments=Y']);
  // No recognizable header at all: shape decides (more rows than columns → settings down).
  const bare = [['', 'jdoe', 'asmith'], ['Delete', 'Y', 'N'], ['Merge', 'N', 'Y'], ['Post', 'Y', 'Y'], ['Lock', 'N', 'N']];
  assert.equal(extractRecords(bare).layout.orientation, 'permissions-down');
  assert.equal(extractRecords(bare, { orientation: 'users-down' }).records[0].subject, 'Delete', 'explicit orientation wins');
});

test('roles: a user → role sheet expands a role-keyed baseline to users', () => {
  const wb = { sheets: baselineSheets() };
  const x = workbookToRecords(wb);
  assert.equal(x.sheet, 'Permissions');
  assert.equal(x.expanded, true);
  assert.equal(new Set(x.records.map(r => r.subject)).size, 9);
  assert.equal(x.records.find(r => r.subject === 'hrivera' && r.permission === 'Admin > Security settings').value, 'Y');
  assert.equal(x.records.find(r => r.subject === 'efoster' && r.permission === 'Admin > Security settings').value, 'N');
  assert.equal(x.records[0].role, 'Provider');
  assert.equal(extractRoleMap([['User', 'Role'], ['a', 'X'], ['b', '']]).size, 1);
  assert.equal(extractRoleMap([['Setting', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']]), null, 'a wide sheet is not a mapping');
  const noExpand = workbookToRecords(wb, { expandRoles: false });
  assert.equal(noExpand.expanded, false);
  assert.ok(noExpand.records.some(r => r.subject === 'Provider'));
  assert.throws(() => workbookToRecords(wb, { sheet: 'Nope' }), /sheet "Nope" not found; sheets are: Permissions, Users/);
  assert.throws(() => workbookToRecords(wb, { rolesSheet: 'Permissions' }), /not a user → role mapping/);
});

test('explicit column names override detection, and a missing column is a clear error', () => {
  const rows = [['Who', 'What', 'How'], ['jdoe', 'Delete', 'Y']];
  const { records } = extractRecords(rows, { layout: 'long', subjectCol: 'Who', permissionCol: 'What', valueCol: 'How' });
  assert.deepEqual(records.map(r => [r.subject, r.permission, r.value]), [['jdoe', 'Delete', 'Y']]);
  assert.throws(() => extractRecords(rows, { layout: 'long', subjectCol: 'Nobody' }), /column "Nobody" not found in header row: Who \| What \| How/);
  assert.throws(() => extractRecords(rows, { layout: 'long' }), /long layout needs user, permission and value columns/);
});

// ───────── comparison ─────────

const rec = (subject, permission, raw) => ({ subject, permission, value: normalizeValue(raw), raw, row: 0 });

test('compare: every finding type, with severities, and matching is case/punctuation-insensitive', () => {
  const baseline = [rec('jdoe', 'Patient > Delete', 'N'), rec('jdoe', 'Patient > Merge', 'Y'), rec('jdoe', 'Orders > Labs', 'Y'), rec('jdoe', 'Old Setting', 'Y'), rec('gone', 'Patient > Delete', 'Y'), rec('asmith', 'Patient > Delete', 'N')];
  const actual = [rec('JDOE', 'Patient > Delete', 'Yes'), rec('JDOE', 'patient > merge', 'No'), rec('JDOE', 'Orders > Labs', 'View Only'), rec('JDOE', 'New Setting', 'Yes'), rec('ASMITH', 'Patient > Delete', 'No'), rec('ASMITH', 'Patient > Merge', 'Yes'), rec('newbie', 'Patient > Delete', 'Yes'), rec('idle', 'Patient > Delete', 'No')];
  const r = compare(baseline, actual);
  const by = (t, u) => r.findings.filter(f => f.type === t && (!u || f.user === u));
  assert.equal(r.pass, false);
  assert.equal(by('excess', 'jdoe')[0].permission, 'Patient > Delete'); assert.equal(by('excess', 'jdoe')[0].severity, 'high');
  assert.equal(by('missing', 'jdoe')[0].permission, 'Patient > Merge'); assert.equal(by('missing', 'jdoe')[0].severity, 'medium');
  assert.equal(by('different', 'jdoe')[0].actual, 'view only');
  assert.equal(by('permission-not-in-ecw', 'jdoe')[0].permission, 'Old Setting');
  assert.equal(by('permission-not-in-baseline', 'jdoe')[0].permission, 'New Setting'); assert.equal(by('permission-not-in-baseline', 'jdoe')[0].severity, 'low');
  assert.equal(by('excess', 'asmith')[0].permission, 'Patient > Merge', 'a grant on a setting the baseline knows but not for this user is excess');
  assert.equal(by('user-not-in-ecw')[0].user, 'gone');
  assert.deepEqual(by('user-not-in-baseline').map(f => [f.user, f.severity]).sort(), [['idle', 'low'], ['newbie', 'high']]);
  assert.equal(r.findings[0].severity, 'high', 'sorted worst first');
  assert.equal(r.users.both, 2);
  assert.equal(r.counts.ok, 1, 'asmith Patient > Delete matches');
  assert.equal(by('ok').length, 0, 'matches are counted, not listed, unless asked');
  assert.equal(r.findings.find(f => f.user === 'jdoe').user, 'jdoe', 'the baseline spelling of a user is the one shown');
  assert.equal(compare(baseline, actual, { reportOk: true }).findings.filter(f => f.type === 'ok').length, 1);
});

test('compare: ignore / only filters take globs, and a clean pair passes', () => {
  const baseline = [rec('jdoe', 'A', 'Y'), rec('test1', 'A', 'N')];
  const actual = [rec('jdoe', 'A', 'Y'), rec('test1', 'A', 'Y'), rec('test2', 'A', 'Y'), rec('jdoe', 'Labs > X', 'Y')];
  assert.equal(compare(baseline, actual).pass, false);
  const r = compare(baseline, actual, { ignoreUsers: 'test*', ignorePermissions: 'Labs > *' });
  assert.equal(r.pass, true); assert.equal(r.findings.length, 0); assert.equal(r.users.ecw, 1);
  assert.equal(compare(baseline, actual, { onlyUsers: 'jdoe', reportUnknownPermissions: false }).findings.length, 0);
});

test('compare: a duplicated row keeps the last value (the effective one)', () => {
  const r = compare([rec('u', 'A', 'N')], [rec('u', 'A', 'Y'), rec('u', 'A', 'N')]);
  assert.equal(r.pass, true);
});

// ───────── end to end ─────────

test('validate: the sample pair finds every planted discrepancy and nothing else', () => {
  const v = validate(BASELINE, EXPORT);
  const r = v.result;
  assert.equal(r.pass, false);
  assert.equal(r.users.both, 8); assert.equal(r.permissions.both, 30); assert.equal(r.compared, 240);
  const key = f => `${f.user.toLowerCase()}|${f.permission}|${f.type}`;
  const got = new Set(r.findings.map(key));
  const want = ['efoster|Admin > Security settings|excess', 'cnguyen|Rx > Prescribe medications|excess', 'bpatel|Progress Notes > Lock progress notes|missing', 'gkim|Billing > Post payments|missing', 'dlee|Orders > Order labs|different', 'ijones||user-not-in-ecw', 'ztemp||user-not-in-baseline'];
  for (const w of want) assert.ok(got.has(w), `missing finding ${w}: ${[...got].join('\n')}`);
  assert.equal(r.findings.filter(f => ['excess', 'missing', 'different'].includes(f.type)).length, DEVIATIONS.length, 'no false positives');
  assert.deepEqual(r.bySeverity, { high: 3, medium: 4, low: 2, info: 6 });
  assert.equal(r.findings.filter(f => f.type === 'permission-not-in-baseline').length, 8, 'Telehealth is reported once per eCW user');
  assert.match(textSummary(r, v.meta), /FAIL[\s\S]*3 high, 4 medium[\s\S]*HIGH\s+Excess access\s+cnguyen/);
  assert.match(findingsCsv(r), /^severity,type,user,setting/);
  assert.match(v.meta.baselineLayout, /roles expanded to users/);
});

test('validate: report files are written in xlsx, csv and json; xlsx reads back with three sheets', () => {
  const x = path.join(tmp, 'out', 'r.xlsx'), c = path.join(tmp, 'r.csv'), j = path.join(tmp, 'r.json');
  validateToFile(BASELINE, EXPORT, x); validateToFile(BASELINE, EXPORT, c); validateToFile(BASELINE, EXPORT, j);
  const wb = readXlsx(x);
  assert.deepEqual(wb.sheets.map(s => s.name), ['Summary', 'Findings', 'Users']);
  assert.equal(wb.sheets[1].rows[0][0], 'Severity');
  assert.equal(wb.sheets[1].rows.length, 1 + 15);
  assert.match(wb.sheets[0].rows[1][1], /^FAIL/);
  assert.equal(fs.readFileSync(c, 'utf8').split('\r\n').length, 17);
  assert.equal(JSON.parse(fs.readFileSync(j, 'utf8')).bySeverity.high, 3);
});

test('validate: unreadable input names the file and the problem', () => {
  const junk = path.join(tmp, 'junk.xlsx'); fs.writeFileSync(junk, 'not a workbook at all');
  assert.throws(() => validate(junk, EXPORT), /baseline \(.*junk\.xlsx\): long layout needs|baseline \(.*junk\.xlsx\)/);
  assert.throws(() => validate({ name: 'b.csv', data: Buffer.from('only one column\nx\n') }, EXPORT), /baseline \(b\.csv\): no sheet with permission data found/);
});

test('cli: validate exits 1 on findings (0 with --fail-on none), inspect describes a file, example writes samples', () => {
  const run = (...a) => spawnSync(process.execPath, [path.join(root, 'bin/ecw-validate.js'), ...a], { encoding: 'utf8' });
  const out = path.join(tmp, 'cli-report.xlsx');
  let r = run('validate', '--baseline', BASELINE, '--actual', EXPORT, '--out', out);
  assert.equal(r.status, 1, r.stderr); assert.match(r.stdout, /FAIL[\s\S]*report written to/); assert.ok(fs.existsSync(out));
  r = run('validate', '--baseline', BASELINE, '--actual', EXPORT, '--fail-on', 'none', '--quiet');
  assert.equal(r.status, 0); assert.match(r.stdout, /^FAIL: 3 high, 4 medium/);
  r = run('validate', '--baseline', BASELINE, '--actual', EXPORT, '--ignore-users', 'efoster,cnguyen,ztemp,ijones', '--ignore-settings', 'Progress Notes > Lock*,Billing > Post*,Orders > Order labs,Telehealth*', '--quiet');
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^PASS/);
  r = run('validate', '--baseline', BASELINE, '--actual', EXPORT, '--json', '--fail-on', 'none');
  assert.equal(JSON.parse(r.stdout).counts.excess, 2);
  r = run('inspect', EXPORT);
  assert.equal(r.status, 0); assert.match(r.stdout, /long \(one row per user \+ setting\)[\s\S]*278 records, 9 users, 31 settings/);
  r = run('validate', '--baseline', BASELINE);
  assert.equal(r.status, 2); assert.match(r.stderr, /needs --baseline <file> and --actual <file>/);
  r = run('validate', '--baseline', path.join(tmp, 'missing.xlsx'), '--actual', EXPORT);
  assert.equal(r.status, 2); assert.match(r.stderr, /error: baseline \(.*missing\.xlsx\): ENOENT/);
  const dir = path.join(tmp, 'ex'); fs.mkdirSync(dir);
  r = run('example', dir);
  assert.equal(r.status, 0); assert.ok(fs.existsSync(path.join(dir, 'baseline.xlsx')) && fs.existsSync(path.join(dir, 'ecw-export.xlsx')));
  assert.match(run().stdout, /^ecw-validate — validate/);
});

test('server: the page is served, /api/validate returns the result, /api/report returns a workbook, bad input is a 4xx', async () => {
  const s = await serve({ port: 0 });
  try {
    const u = `http://127.0.0.1:${s.port}`;
    const page = await fetch(u + '/');
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /eCW Security Settings Validator/);
    const body = { baseline: { name: 'b.xlsx', data: fs.readFileSync(BASELINE).toString('base64') }, actual: { name: 'a.xlsx', data: fs.readFileSync(EXPORT).toString('base64') }, options: { ignoreUsers: 'ztemp' } };
    const post = (p, b) => fetch(u + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let r = await post('/api/validate', body); let j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.pass, false); assert.equal(j.bySeverity.high, 2, 'ztemp ignored'); assert.equal(j.baseline.expanded, true); assert.equal(j.actual.records, 278);
    r = await post('/api/report', body);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /ecw-validation-\d{4}-\d\d-\d\d\.xlsx/);
    assert.deepEqual(readXlsx(Buffer.from(await r.arrayBuffer())).sheets.map(x => x.name), ['Summary', 'Findings', 'Users']);
    r = await post('/api/report', { ...body, format: 'csv' }); assert.match(r.headers.get('content-type'), /text\/csv/); assert.match(await r.text(), /^severity,type/);
    r = await post('/api/validate', { baseline: body.baseline }); assert.equal(r.status, 400); assert.match((await r.json()).error, /eCW export file is missing/);
    r = await post('/api/validate', { baseline: { name: 'x', data: Buffer.from('nonsense').toString('base64') }, actual: body.actual }); assert.equal(r.status, 400); assert.match((await r.json()).error, /baseline \(x\)/);
    r = await fetch(u + '/api/validate', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' }); assert.equal(r.status, 415);
    r = await fetch(u + '/nope'); assert.equal(r.status, 404);
    assert.equal((await fetch(u + '/api/health')).status, 200);
  } finally { await s.close(); }
});

test('examples: the eCW-style export has the title lines and per-user blocks the parser must cope with', () => {
  const rows = ecwExportRows();
  assert.match(rows[0][0], /eClinicalWorks/);
  assert.deepEqual(rows[3], ['User Name', 'Category', 'Security Setting', 'Value']);
  assert.equal(rows[5][0], '', 'the user is printed once per block');
});
