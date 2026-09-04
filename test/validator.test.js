import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildXlsx, readXlsx, parseCsv, readSpreadsheet, unzip, zip as buildZip } from '../src/xlsx.js';
import { normalizeValue, isAnnotated, detectLayout, extractRecords, extractRoleMap, workbookToRecords, findHeaderRow } from '../src/parse.js';
import { compare, similarity, closest } from '../src/validate.js';
import { validate, validateToFile, textSummary, findingsCsv, inspect, loadAliases, loadCatalog, loadUsersFile, buildTemplate, catalogCheck, documentEcw } from '../src/index.js';
import { detectCatalog, detectCatalogLike, extractRoleList, roleNameFromSheet, lookup } from '../src/catalog.js';
import { serve } from '../src/server.js';
import { writeExamples, baselineSheets, ecwExportRows, catalogRows, DEVIATIONS, SETTINGS, CATALOG_EXTRA } from '../examples/make-examples.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecw-validator-'));
const [BASELINE, EXPORT, CATALOG, ...ROLE_FILES] = writeExamples(tmp);

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
  assert.equal(x.records.find(r => r.subject === 'hrivera' && r.permission === 'Administration / System Admin Setup > Allow Access to Patient Merge').value, 'Y');
  assert.equal(x.records.find(r => r.subject === 'efoster' && r.permission === 'Administration / System Admin Setup > Allow Access to Patient Merge').value, 'N');
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
  assert.equal(r.users.both, 8); assert.equal(r.permissions.both, SETTINGS.length); assert.equal(r.compared, 8 * SETTINGS.length);
  const key = f => `${f.user.toLowerCase()}|${f.permission}|${f.type}`;
  const got = new Set(r.findings.map(key));
  const want = [...DEVIATIONS.map(([u, p, v]) => `${u}|${p}|${v === 'Yes' ? 'excess' : v === 'No' ? 'missing' : 'different'}`), 'ijones||user-not-in-ecw', 'ztemp||user-not-in-baseline'];
  for (const w of want) assert.ok(got.has(w), `missing finding ${w}: ${[...got].join('\n')}`);
  assert.equal(r.findings.filter(f => ['excess', 'missing', 'different'].includes(f.type)).length, DEVIATIONS.length, 'no false positives');
  assert.deepEqual(r.bySeverity, { high: 3, medium: 4, low: 2, info: 6 });
  assert.equal(r.findings.filter(f => f.type === 'permission-not-in-baseline').length, 8, 'Blast eMsg is reported once per eCW user');
  const text = textSummary(r, v.meta);
  assert.match(text, /FAIL[\s\S]*3 high, 4 medium[\s\S]*What to do, per role:[\s\S]*cnguyen\n\s+REMOVE\s+SureScripts > SS EPrescription/);
  assert.match(text, /gkim\n\s+GRANT\s+Administration \/ Billing Setup > Delete Payments/);
  assert.match(text, /ijones — expected by the baseline but not in eCW/);
  assert.match(text, /Check how the files were read:[\s\S]*"view only"×1/);
  assert.deepEqual(r.actions.find(a => a.user === 'efoster'), { user: 'efoster', remove: ['Administration / System Admin Setup > Allow Access to Patient Merge'], grant: [], review: [], status: '' });
  assert.equal(r.detail.find(d => d.user === 'dlee').settings.find(s => s.type === 'different').actual, 'view only');
  assert.equal(r.detail.find(d => d.user === 'ijones').inEcw, false);
  assert.equal(r.bySetting[0].setting.length > 0, true);
  assert.match(findingsCsv(r), /^severity,type,role,setting/);
  assert.match(v.meta.baselineLayout, /roles expanded to users/);
});

test('validate: report files are written in xlsx, csv and json; xlsx reads back with every sheet', () => {
  const x = path.join(tmp, 'out', 'r.xlsx'), c = path.join(tmp, 'r.csv'), j = path.join(tmp, 'r.json');
  validateToFile(BASELINE, EXPORT, x); validateToFile(BASELINE, EXPORT, c); validateToFile(BASELINE, EXPORT, j);
  const wb = readXlsx(x);
  assert.deepEqual(wb.sheets.map(s => s.name), ['Summary', 'Actions', 'Findings', 'Side by side', 'Roles', 'Settings', 'Matches']);
  const F = wb.sheets[2]; assert.equal(F.rows[0][0], 'Severity'); assert.equal(F.rows.length, 1 + 15);
  assert.match(wb.sheets[0].rows[1][1], /^FAIL — 3 high, 4 medium/);
  const A = wb.sheets[1]; assert.equal(A.rows[0][2], 'Remove in eCW (excess)'); assert.ok(A.rows.some(r => r[0] === 'efoster' && r[2] === 'Administration / System Admin Setup > Allow Access to Patient Merge' && r[1] === 'Front Desk'));
  const S = wb.sheets[3]; assert.equal(S.rows[0][0], 'Security setting'); assert.ok(S.rows[0].includes('efoster')); const ri = S.rows.findIndex(r => r[0] === 'Administration / System Admin Setup > Allow Access to Patient Merge'); const ci = S.rows[0].indexOf('efoster'); assert.equal(S.rows[ri][ci], 'N → Y (Yes)'); assert.equal(S.rows[ri][S.rows[0].indexOf('hrivera')], 'Y');
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
  r = run('validate', '--baseline', BASELINE, '--actual', EXPORT, '--ignore-users', 'efoster,cnguyen,ztemp,ijones', '--ignore-settings', 'Progress Notes > Lock Chart,*Delete Payments,Progress Notes > Access Patient Orders,Patient Portal > Blast eMsg', '--quiet');
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^PASS/);
  r = run('validate', '--baseline', BASELINE, '--actual', EXPORT, '--json', '--fail-on', 'none');
  assert.equal(JSON.parse(r.stdout).counts.excess, 2);
  r = run('inspect', EXPORT);
  assert.equal(r.status, 0); assert.match(r.stdout, new RegExp(`header on row 4[\\s\\S]*one row per user \\+ setting[\\s\\S]*${8 * (SETTINGS.length + 1) + SETTINGS.length} records, 9 users, ${SETTINGS.length + 1} settings[\\s\\S]*first records:[\\s\\S]*row\\s+5\\s+AGARCIA`));
  r = run('validate', '--baseline', BASELINE);
  assert.equal(r.status, 2); assert.match(r.stderr, /needs --baseline <file> and at least one --actual <file>/);
  r = run('validate', '--baseline', path.join(tmp, 'missing.xlsx'), '--actual', EXPORT);
  assert.equal(r.status, 2); assert.match(r.stderr, /error: baseline file not found: .*missing\.xlsx/);
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
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /eCW Security Validator/);
    const body = { baseline: { name: 'b.xlsx', data: fs.readFileSync(BASELINE).toString('base64') }, actual: { name: 'a.xlsx', data: fs.readFileSync(EXPORT).toString('base64') }, options: { ignoreUsers: 'ztemp' } };
    const post = (p, b) => fetch(u + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let r = await post('/api/validate', body); let j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.pass, false); assert.equal(j.bySeverity.high, 2, 'ztemp ignored'); assert.equal(j.baseline.expanded, true); assert.equal(j.actual.records, 8 * (SETTINGS.length + 1) + SETTINGS.length);
    r = await post('/api/report', body);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /ecw-validation-\d{4}-\d\d-\d\d\.xlsx/);
    assert.equal(readXlsx(Buffer.from(await r.arrayBuffer())).sheets.length, 7);
    r = await post('/api/inspect', { file: body.actual, label: 'actual' }); j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.records, 8 * (SETTINGS.length + 1) + SETTINGS.length); assert.equal(j.sheets[0].headerRow, 4); assert.equal(j.users.length, 9); assert.equal(j.sample[0].user, 'AGARCIA'); assert.equal(j.sheets[0].preview[3][0], 'User Name');
    r = await post('/api/inspect', { file: { name: 'x.csv', data: Buffer.from('one\ntwo\n').toString('base64') } }); j = await r.json();
    assert.equal(r.status, 200); assert.match(j.error, /no sheet with permission data/); assert.equal(j.sheets.length, 1, 'the raw preview is still there so the person can see why');
    r = await post('/api/validate', { ...body, aliases: { name: 'al.csv', data: Buffer.from('user,ztemp-baseline,ztemp\n').toString('base64') } }); j = await r.json();
    assert.equal(j.matches.length, 0, 'an alias whose baseline side does not exist changes nothing');
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

// ───────── matching, suggestions, aliases, actions ─────────

test('compare: a setting is paired by bare name when one side has categories and the other does not; otherwise only suggested', () => {
  const baseline = [rec('jdoe', 'Lock progress notes', 'Y'), rec('jdoe', 'Delete patient', 'N'), rec('jdoe', 'Post payments', 'Y')];
  const actual = [rec('jdoe', 'Progress Notes > Lock progress notes', 'No'), rec('jdoe', 'Patient > Delete patient', 'No'), rec('jdoe', 'Billing > Post payment', 'Yes')];
  const r = compare(baseline, actual);
  assert.deepEqual(r.matches.map(m => [m.baseline, m.ecw, m.by]).sort(), [['Delete patient', 'Patient > Delete patient', 'name'], ['Lock progress notes', 'Progress Notes > Lock progress notes', 'name']]);
  assert.equal(r.permissions.both, 2);
  const missing = r.findings.find(f => f.type === 'missing'); assert.equal(missing.permission, 'Lock progress notes', 'shown under the baseline name');
  const gone = r.findings.find(f => f.type === 'permission-not-in-ecw');
  assert.equal(gone.permission, 'Post payments'); assert.equal(gone.suggestion, 'Billing > Post payment'); assert.match(gone.note, /closest eCW setting: "Billing > Post payment"/);
  const unknown = r.findings.find(f => f.type === 'permission-not-in-baseline'); assert.equal(unknown.suggestion, 'Post payments');
  assert.equal(compare(baseline, actual, { matchByName: false }).matches.length, 0);
  // ambiguous on one side → not paired
  const amb = compare([rec('u', 'Delete', 'Y')], [rec('u', 'Patient > Delete', 'Y'), rec('u', 'Documents > Delete', 'N')]);
  assert.equal(amb.matches.length, 0); assert.equal(amb.findings.find(f => f.type === 'permission-not-in-ecw').permission, 'Delete');
});

test('compare: aliases pair users and settings the documents spell differently', () => {
  const baseline = [rec('jdoe', 'Notes > Lock', 'Y'), rec('jdoe', 'Notes > Sign', 'Y')];
  const actual = [rec('Doe, John', 'Progress Notes > Lock progress note', 'Yes'), rec('Doe, John', 'Progress Notes > Sign', 'No')];
  const plain = compare(baseline, actual);
  assert.equal(plain.findings.find(f => f.type === 'user-not-in-ecw').user, 'jdoe');
  const r = compare(baseline, actual, { aliases: { users: { jdoe: 'Doe, John' }, settings: { 'Notes > Lock': 'Progress Notes > Lock progress note', 'Notes > Sign': 'Progress Notes > Sign' } } });
  assert.equal(r.users.both, 1); assert.equal(r.permissions.both, 2);
  assert.equal(r.counts.ok, 1); assert.equal(r.findings.find(f => f.type === 'missing').permission, 'Notes > Sign');
  assert.equal(r.matches.filter(m => m.by === 'alias').length, 3);
  const f = path.join(tmp, 'aliases.csv'); fs.writeFileSync(f, 'kind,baseline,ecw\r\nuser,jdoe,"Doe, John"\r\nsetting,Notes > Lock,Progress Notes > Lock progress note\r\nNotes > Sign,Progress Notes > Sign\r\n');
  assert.deepEqual(loadAliases(f), { users: { jdoe: 'Doe, John' }, settings: { 'Notes > Lock': 'Progress Notes > Lock progress note', 'Notes > Sign': 'Progress Notes > Sign' } });
});

test('compare: an unmatched user gets its closest counterpart as a suggestion, never an automatic pairing', () => {
  const r = compare([rec('jsmith', 'A', 'Y'), rec('mjones', 'A', 'Y')], [rec('JSMITH2', 'A', 'Yes'), rec('mjones', 'A', 'Yes')]);
  const gone = r.findings.find(f => f.type === 'user-not-in-ecw'); assert.equal(gone.user, 'jsmith'); assert.equal(gone.suggestion, 'JSMITH2');
  const extra = r.findings.find(f => f.type === 'user-not-in-baseline'); assert.equal(extra.user, 'JSMITH2'); assert.equal(extra.suggestion, 'jsmith');
  assert.match(r.actions.find(a => a.user === 'jsmith').status, /closest eCW role: JSMITH2/);
  assert.ok(similarity('lock progress notes', 'lock progress note') > 0.9);
  assert.ok(similarity('billing', 'scheduling') < 0.6);
  assert.equal(closest('zzzz', new Map([['abcd', 'abcd']])), null);
});

test('compare: actions and detail are derived from the same findings', () => {
  const r = compare([rec('u', 'A', 'N'), rec('u', 'B', 'Y'), rec('u', 'C', 'Y'), rec('u', 'D', 'Y')], [rec('u', 'A', 'Yes'), rec('u', 'B', 'No'), rec('u', 'C', 'Read Only'), rec('u', 'D', 'Yes'), rec('u', 'E', 'Yes')]);
  assert.deepEqual(r.actions, [{ user: 'u', remove: ['A'], grant: ['B'], review: ['C: eCW has read only, baseline wants Y', 'E: granted in eCW, not covered by the baseline'], status: '' }]);
  const d = r.detail[0];
  assert.deepEqual(d.settings.map(s => [s.permission, s.type]), [['A', 'excess'], ['B', 'missing'], ['C', 'different'], ['D', 'ok'], ['E', 'permission-not-in-baseline']]);
  assert.deepEqual(r.bySetting.map(s => s.setting), ['A', 'B', 'C', 'E']);
});

// ───────── reading: warnings, sheet merging, inspect ─────────

test('parse: warnings say what was skipped, duplicated or kept as a level', () => {
  const rows = [['User', 'Setting', 'Value'], ['jdoe', 'A', 'Y'], ['', 'B', 'N'], ['jdoe', 'A', 'N'], ['jdoe', 'C', 'Read Only']];
  const { records, warnings } = extractRecords(rows, { name: 'S' });
  assert.equal(records.length, 4);
  assert.ok(warnings.some(w => /1 setting\(s\) appear more than once \(the LAST row wins\): "A" rows 2\/4 — the copies DISAGREE/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some(w => /"read only"×1/.test(w)));
  const orphan = extractRecords([['User', 'Setting', 'Value'], ['', 'A', 'Y'], ['jdoe', 'B', 'Y']], { name: 'S' });
  assert.ok(orphan.warnings.some(w => /1 row\(s\) had a setting but no user above them/.test(w)));
  const grid = extractRecords([['Setting', 'jdoe', ''], ['A', 'Y', 'N'], ['B', 'N', 'Y']], { name: 'G' });
  assert.ok(grid.warnings.some(w => /1 column\(s\) have values but no name/.test(w)), grid.warnings.join('\n'));
});

test('workbook: one tab per user merges with sheet "all"; otherwise the other tabs are pointed out', () => {
  const wb = { sheets: [{ name: 'JDOE', rows: [['Setting', 'Value'], ['A', 'Y'], ['B', 'N']] }, { name: 'ASMITH', rows: [['Setting', 'Value'], ['A', 'N'], ['B', 'Y']] }] };
  // A two-column per-user tab has no user column: read as a grid with the tab name as the user via users-down? No —
  // it reads as a grid: settings down, one value column named "Value". The sheet name is the user, so say so with --user-col? Instead the
  // realistic per-user export repeats the user in a column; test that shape:
  const per = { sheets: [{ name: 'JDOE', rows: [['User', 'Setting', 'Value'], ['jdoe', 'A', 'Y'], ['jdoe', 'B', 'N']] }, { name: 'ASMITH', rows: [['User', 'Setting', 'Value'], ['asmith', 'A', 'N'], ['asmith', 'B', 'Y']] }, { name: 'Notes', rows: [['Just a note']] }] };
  const one = workbookToRecords(per);
  assert.equal(one.sheet, 'JDOE'); assert.equal(one.records.length, 2);
  assert.ok(one.warnings.some(w => /other sheets also contain permission data and were NOT read: "ASMITH"/.test(w)), one.warnings.join('\n'));
  const all = workbookToRecords(per, { sheet: 'all' });
  assert.equal(all.sheet, 'JDOE + ASMITH'); assert.equal(all.records.length, 4); assert.deepEqual(all.ignoredSheets, ['Notes']);
  assert.equal(new Set(all.records.map(r => r.subject)).size, 2);
  assert.ok(wb.sheets.length);
});

test('roles: users whose role has no column, and columns that are not roles, are reported', () => {
  const wb = { sheets: [{ name: 'Permissions', rows: [['Setting', 'Provider', 'Nurse', 'jdoe'], ['A', 'Y', 'N', 'Y']] }, { name: 'Users', rows: [['User', 'Role'], ['a', 'Provider'], ['b', 'Nurse'], ['c', 'Biller']] }] };
  const x = workbookToRecords(wb);
  assert.equal(x.expanded, true);
  assert.deepEqual([...new Set(x.records.map(r => r.subject))].sort(), ['a', 'b', 'jdoe'], 'a non-role column is kept as a user');
  assert.ok(x.warnings.some(w => /c \(Biller\)/.test(w)), x.warnings.join('\n'));
  assert.ok(x.warnings.some(w => /"jdoe" are not roles/.test(w)));
});

test('inspect: describes a file without throwing, even when it cannot be read as permissions', () => {
  const x = inspect(EXPORT, {}, 'eCW export');
  assert.equal(x.error, null); assert.equal(x.sheets[0].headerRow, 4); assert.deepEqual(x.sheets[0].headers, ['User Name', 'Category', 'Security Setting', 'Value']);
  assert.equal(x.records, 8 * (SETTINGS.length + 1) + SETTINGS.length); assert.equal(x.users.length, 9); assert.equal(x.settings.length, SETTINGS.length + 1); assert.equal(x.values[0].value, 'N');
  assert.equal(x.sample[0].row, 5); assert.equal(x.sample[0].raw, 'Yes');
  const b = inspect(BASELINE); assert.equal(b.expanded, true); assert.equal(b.users.find(u => u.name === 'agarcia').role, 'Provider'); assert.equal(b.sheetsUsed[0], 'Permissions');
  const bad = path.join(tmp, 'bad.csv'); fs.writeFileSync(bad, 'just\nwords\n');
  const y = inspect(bad); assert.match(y.error, /no sheet with permission data/); assert.equal(y.sheets[0].preview.length, 2);
});

test('csv: semicolon-separated (European Excel) files are read', () => {
  assert.deepEqual(parseCsv('User;Setting;Value\njdoe;A;Y\n'), [['User', 'Setting', 'Value'], ['jdoe', 'A', 'Y']]);
});

// ───────── the eCW settings catalog ─────────

test('catalog: eCW\'s Security Settings export (name / description / type / group) is recognised, and refused as an eCW export', () => {
  const rows = catalogRows();
  const cols = detectCatalog(rows);
  assert.deepEqual(cols, { headerRow: 0, name: 0, desc: 1, type: 2, group: 3, permission: -1 });
  const cat = loadCatalog(CATALOG);
  assert.equal(cat.settings.length, SETTINGS.length + CATALOG_EXTRA.length); assert.equal(cat.groups.size, 13);
  assert.equal(lookup(cat, 'Delete Payments').group, 'Administration / Billing Setup');
  assert.equal(lookup(cat, 'Administration / Billing Setup > delete payments').name, 'Delete Payments', 'the "Group > Name" form resolves by bare name');
  assert.equal(lookup(cat, 'Nope'), null);
  // Not catalogs: a grid with role columns, a template with blank role columns, a list with a value column
  assert.equal(detectCatalog([['Category', 'Security Setting', 'What it controls', 'MA', 'RN'], ['Billing', 'Batches', 'x', '', ''], ['Billing', 'ERA', 'y', '', ''], ['Billing', 'ICD', 'z', '', '']]), null, 'unclaimed role columns → a permission grid');
  assert.equal(detectCatalog([['Security Setting Name', 'Description', 'Value'], ['A', 'a', 'Y'], ['B', 'b', 'N'], ['C', 'c', 'Y']]), null, 'a value column → grants');
  assert.throws(() => validate(BASELINE, CATALOG), /eCW export \(.*catalog\.xlsx\): sheet "Sheet1" is eCW's security settings CATALOG[\s\S]*export for ONE ROLE[\s\S]*--role/);
  const x = inspect(CATALOG);
  assert.equal(x.kind, 'catalog'); assert.equal(x.records, cat.settings.length); assert.equal(x.groups[0].group, 'Administration / Billing Setup'); assert.match(x.warnings.join(' '), /as the CATALOG it is the list of settings eCW knows; as an eCW per-ROLE export/);
});

test('catalog: findings carry group + description, baseline typos are flagged with the real name, coverage is reported', () => {
  const v = validate(BASELINE, EXPORT, { catalog: CATALOG });
  const r = v.result;
  assert.deepEqual(r.bySeverity, { high: 3, medium: 4, low: 2, info: 6 }, 'the catalog changes nothing in the comparison itself');
  const f = r.findings.find(x => x.type === 'excess' && x.user === 'cnguyen');
  assert.equal(f.group, 'SureScripts'); assert.match(f.description, /SureScript ePrescription/);
  assert.equal(r.detail.find(d => d.user === 'dlee').settings.find(s => s.type === 'different').group, 'Progress Notes');
  const c = r.catalog;
  assert.equal(c.total, SETTINGS.length + CATALOG_EXTRA.length); assert.equal(c.covered, SETTINGS.length); assert.deepEqual(c.unknown, []); assert.deepEqual(c.ecwUnknown, []);
  assert.equal(c.grantedUncovered, 1); assert.equal(c.settings.find(s => s.name === 'Blast eMsg').grantedTo, 2, 'the two providers hold it');
  assert.equal(c.byGroup.find(g => g.group === 'Patient Portal').grantedUncovered, 1);
  assert.match(textSummary(r, v.meta), /catalog: catalog\.xlsx — \d+ settings, \d+ covered by the baseline, 1 not covered but granted/);
  // A baseline with a misspelt setting: flagged, with the closest real name and its group
  const rec = (subject, permission, raw) => ({ subject, permission, value: normalizeValue(raw), raw, row: 0 });
  const cat = loadCatalog(CATALOG);
  const r2 = compare([rec('u', 'Delete Payment', 'Y'), rec('u', 'Lock Chart', 'Y')], [rec('u', 'Delete Payments', 'Yes'), rec('u', 'Lock Chart', 'Yes')], { catalog: cat });
  assert.equal(r2.catalog.unknown.length, 1); assert.equal(r2.catalog.unknown[0].name, 'Delete Payment'); assert.equal(r2.catalog.unknown[0].suggestion, 'Delete Payments'); assert.equal(r2.catalog.unknown[0].group, 'Administration / Billing Setup');
  assert.match(textSummary(r2, {}), /Baseline settings the eCW catalog does not know[\s\S]*\? Delete Payment  → closest: "Delete Payments"/);
  // The report gains Coverage and Not-in-catalog sheets, and Findings gets Group / What it controls columns
  const out = path.join(tmp, 'cat-report.xlsx'); validateToFile(BASELINE, EXPORT, out, { catalog: CATALOG });
  const wb = readXlsx(out);
  assert.deepEqual(wb.sheets.map(s => s.name), ['Summary', 'Actions', 'Findings', 'Side by side', 'Roles', 'Settings', 'Matches', 'Coverage', 'Not in catalog']);
  assert.deepEqual(wb.sheets[2].rows[0].slice(3, 6), ['Security setting', 'Group', 'What it controls']);
  const cov = wb.sheets[7]; assert.equal(cov.rows.length, 1 + cat.settings.length); assert.ok(cov.rows.some(r => r[1] === 'Blast eMsg' && r[3] === 'N' && r[4] === 2));
  assert.ok(wb.sheets[0].rows.some(r => r[0] === 'Catalog settings' && r[1] === cat.settings.length));
});

test('catalog: a baseline template is built from it and reads back as a baseline (the description column is not a user)', () => {
  const buf = buildTemplate(CATALOG, { roles: ['MA', 'RN'], groups: ['Billing', 'Logs'] });
  const wb = readXlsx(buf);
  assert.deepEqual(wb.sheets.map(s => s.name), ['Permissions', 'Users', 'How to']);
  assert.deepEqual(wb.sheets[0].rows[0], ['Category', 'Security Setting', 'What it controls', 'MA', 'RN']);
  const n = catalogRows().slice(1).filter(r => ['Billing', 'Logs'].includes(r[3])).length; assert.equal(wb.sheets[0].rows.length, 1 + n);
  // fill it in and read it back
  const rows = wb.sheets[0].rows.map((r, i) => (i === 0 ? r : [...r.slice(0, 3), 'Y', 'N']));
  const f = path.join(tmp, 'filled.xlsx'); fs.writeFileSync(f, buildXlsx([{ name: 'Permissions', rows }, { name: 'Users', rows: [['User', 'Role'], ['ma1', 'MA'], ['rn1', 'RN']] }]));
  const x = inspect(f);
  assert.equal(x.kind, 'permissions'); assert.equal(x.error, null); assert.deepEqual(x.users.map(u => u.name).sort(), ['ma1', 'rn1']); assert.equal(x.settings.length, n); assert.equal(x.records, 2 * n);
  assert.equal(x.sample[0].setting.split(' > ')[0], 'Billing');
});

test('catalog: CLI --catalog and template; server /api/template and catalog in the body', async () => {
  const run = (...a) => spawnSync(process.execPath, [path.join(root, 'bin/ecw-validate.js'), ...a], { encoding: 'utf8' });
  let r = run('validate', '--baseline', BASELINE, '--actual', EXPORT, '--catalog', CATALOG, '--fail-on', 'none');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /catalog: .*catalog\.xlsx — \d+ settings/);
  r = run('inspect', CATALOG); assert.equal(r.status, 0); assert.match(r.stdout, /eCW security settings catalog[\s\S]*settings in 13 groups[\s\S]*next: ecw-validate template/);
  const t = path.join(tmp, 'tpl.xlsx'); r = run('template', '--catalog', CATALOG, '--out', t, '--roles', 'MA,RN');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /columns for MA, RN/); assert.equal(readXlsx(t).sheets[0].rows[0].length, 5);
  r = run('validate', '--baseline', BASELINE, '--actual', CATALOG); assert.equal(r.status, 2); assert.match(r.stderr, /security settings CATALOG/);
  const s = await serve({ port: 0 });
  try {
    const u = `http://127.0.0.1:${s.port}`; const b64 = f => fs.readFileSync(f).toString('base64');
    const post = (p, b) => fetch(u + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let res = await post('/api/validate', { baseline: { name: 'b.xlsx', data: b64(BASELINE) }, actual: { name: 'a.xlsx', data: b64(EXPORT) }, catalog: { name: 'c.xlsx', data: b64(CATALOG) } }); let j = await res.json();
    assert.equal(res.status, 200); assert.equal(j.catalogFile.settings, SETTINGS.length + CATALOG_EXTRA.length); assert.equal(j.catalog.covered, SETTINGS.length); assert.equal(j.findings[0].group !== undefined, true);
    res = await post('/api/inspect', { file: { name: 'c.xlsx', data: b64(CATALOG) } }); j = await res.json(); assert.equal(j.kind, 'catalog');
    res = await post('/api/template', { catalog: { name: 'c.xlsx', data: b64(CATALOG) }, roles: ['X'] }); assert.equal(res.status, 200); assert.equal(readXlsx(Buffer.from(await res.arrayBuffer())).sheets[0].rows[0].length, 4);
    res = await post('/api/template', { catalog: { name: 'b.xlsx', data: b64(BASELINE) } }); assert.equal(res.status, 400); assert.match((await res.json()).error, /no security settings catalog found/);
  } finally { await s.close(); }
});

// ───────── a real-world master matrix: Setting | Description | Group | 28 role columns, X ticks with notes ─────────

const MATRIX = [
  ['Security Item in NEW VERSION IN TEST - DO NOT SORT THIS LIST  ', ' Description/ Action - DO NOT SORT THIS LIST ', 'Security Group Name - DO NOT SORT THIS LIST', 'APPS Admin ', 'Billing ', 'eCW SUPPORT-DONT NEED TO VALIDATE', 'Provider', 'Read Only '],
  ['Delete Payments', 'Grants or denies users permission to delete both patient and insurance payments', 'Administration / Billing Setup', 'X', 'x', 'x', '', ''],
  ['Lock Chart', 'Allows the user to lock the chart', 'Progress Notes', '', '', 'x', 'X (added 9/13/24', ''],
  ['Eligibility Admin', 'Manage Eligibility Admin', 'Administration / Billing Setup', 'x', 'ADDED 6/12', '', '', ''],
  ['Configure Letter Category', 'Allows custom letter categories', 'Documents', '', 'Configure Letter Category', '', '', ''],
  ['Accounts LookUp', 'first copy', 'Billing', 'X', '', '', '', ''],
  ['Accounts LookUp', 'second copy', 'Billing', '', 'X', '', '', ''],
  ['', '', '', '', 'x', '', '', ''],
  [], [], [],
];

test('matrix: description and group columns beside the setting are metadata, not users; ticks with notes are grants; oddities are named', () => {
  const lay = detectLayout(MATRIX);
  assert.equal(lay.layout, 'matrix'); assert.equal(lay.orientation, 'permissions-down');
  assert.deepEqual([lay.permissionCol, lay.descriptionCol, lay.categoryCol, lay.firstDataCol], [0, 1, 2, 3]);
  const { records, warnings } = extractRecords(MATRIX, { name: 'M' });
  const subjects = [...new Set(records.map(r => r.subject))];
  assert.deepEqual(subjects, ['APPS Admin', 'Billing', 'eCW SUPPORT-DONT NEED TO VALIDATE', 'Provider', 'Read Only'], 'header cells are trimmed; description/group are not users');
  const get = (u, p) => records.filter(r => r.subject === u && r.permission === p).pop();
  assert.equal(get('APPS Admin', 'Administration / Billing Setup > Delete Payments').value, 'Y');
  assert.equal(get('Provider', 'Administration / Billing Setup > Delete Payments').value, 'N', 'blank = not granted');
  assert.equal(get('Provider', 'Progress Notes > Lock Chart').value, 'Y', '"X (added 9/13/24" is a tick with a note');
  assert.equal(get('Billing', 'Administration / Billing Setup > Eligibility Admin').value, 'Y', '"ADDED 6/12" is a tick with a note');
  assert.equal(get('Billing', 'Documents > Configure Letter Category').value, 'configure letter category', 'pasted text is kept as text, not guessed');
  assert.equal(get('Billing', 'Billing > Accounts LookUp').value, 'Y', 'the LAST duplicate row wins');
  for (const v of ['x - added 1/16/2024', 'added 8/29', 'X (added 9/13/24', 'x ']) assert.equal(normalizeValue(v), 'Y', v);
  assert.equal(isAnnotated('x - added 1/16/2024'), true); assert.equal(isAnnotated('X'), false); assert.equal(isAnnotated(''), false);
  const W = warnings.join('\n');
  assert.match(W, /"eCW SUPPORT-DONT NEED TO VALIDATE" look like they should be left out/);
  assert.match(W, /2 cell\(s\) carry a note on a tick and were read as GRANTED: row 3 Provider "X \(added 9\/13\/24"; row 4 Billing "ADDED 6\/12"/);
  assert.match(W, /1 cell\(s\) contain text instead of a tick[\s\S]*row 5 Billing "Configure Letter Category"/);
  assert.match(W, /1 setting\(s\) appear more than once \(the LAST row wins\): "Billing > Accounts LookUp" rows 6\/7 — the copies DISAGREE/);
  assert.match(W, /1 row\(s\) had values but no name in the first column and were skipped: row 8 \("x" under Billing\)/);
  assert.doesNotMatch(W, /configure letter category.*kept as levels/, 'pasted text is not also reported as a level');
  // ignoreSubjects drops a role column while reading
  const dropped = extractRecords(MATRIX, { name: 'M', ignoreSubjects: 'eCW SUPPORT*, Read*' });
  assert.deepEqual([...new Set(dropped.records.map(r => r.subject))], ['APPS Admin', 'Billing', 'Provider']);
  assert.match(dropped.warnings.join('\n'), /left out as asked: "eCW SUPPORT-DONT NEED TO VALIDATE", "Read Only"/);
  // the workbook has no Users sheet and the columns look like roles: say so
  const x = workbookToRecords({ sheets: [{ name: 'UPGRADE V12.0.4', rows: MATRIX }, { name: 'Sheet1', rows: [] }] });
  assert.equal(x.expanded, false); assert.match(x.warnings.join('\n'), /columns look like ROLES[\s\S]*one export per role[\s\S]*per-USER list, add a Users sheet/);
});

test('matrix: a separate users → roles file expands the role columns to users', () => {
  const uf = path.join(tmp, 'users.csv'); fs.writeFileSync(uf, 'User,Role\r\njdoe,APPS Admin\r\nasmith,Provider\r\nbwho,Nobody\r\n');
  const m = loadUsersFile(uf); assert.equal(m.size, 3);
  const x = workbookToRecords({ sheets: [{ name: 'M', rows: MATRIX }] }, { roleMap: m, roleMapName: 'users.csv' });
  assert.equal(x.expanded, true, 'an explicit users file expands even when it covers only some of the role columns');
  assert.deepEqual([...new Set(x.records.map(r => r.subject))].sort(), ['Billing', 'Read Only', 'asmith', 'eCW SUPPORT-DONT NEED TO VALIDATE', 'jdoe'], 'mapped roles become users; unmapped role columns stay as they are');
  assert.equal(x.records.find(r => r.subject === 'jdoe' && r.permission === 'Administration / Billing Setup > Delete Payments').value, 'Y');
  assert.match(x.warnings.join('\n'), /bwho \(Nobody\)/);
  const bad = path.join(tmp, 'notusers.csv'); fs.writeFileSync(bad, 'a,b\n1,2\n');
  assert.throws(() => loadUsersFile(bad), /needs a User column and a Role column/);
  // end to end through validate(): baseline = the matrix + users file, actual = a per-user list
  const mf = path.join(tmp, 'matrix.xlsx'); fs.writeFileSync(mf, buildXlsx([{ name: 'UPGRADE V12.0.4', rows: MATRIX }]));
  const af = path.join(tmp, 'peruser.csv'); fs.writeFileSync(af, 'User Name,Category,Security Setting,Value\r\nJDOE,Administration / Billing Setup,Delete Payments,Yes\r\nJDOE,Progress Notes,Lock Chart,Yes\r\nASMITH,Progress Notes,Lock Chart,Yes\r\n');
  const v = validate(mf, af, { baseline: { usersFile: uf, ignoreSubjects: 'eCW SUPPORT*' } });
  assert.equal(v.result.users.both, 2);
  assert.equal(v.result.findings.find(f => f.user === 'jdoe' && f.type === 'excess').permission, 'Progress Notes > Lock Chart');
  assert.match(v.meta.baselineLayout, /roles expanded to users/);
});

test('catalog: lookup peels "Group >" prefixes from the left, so a setting whose name contains ">" is found; inspect cross-checks a file', () => {
  const cat = loadCatalog(CATALOG);
  const rows = [['Security Setting Name', 'Security Setting Description', 'Security Setting Type', 'Security group Name'], ['Allow access to Billing window > Done Button', 'd', 'Old', 'Administration / Billing Setup'], ['Lock Chart', 'd', 'Old', 'Progress Notes'], ['Delete Payments', 'd', 'Old', 'Administration / Billing Setup']];
  const c2 = { name: 'c', ...loadCatalog({ name: 'c.xlsx', data: buildXlsx([{ name: 'S', rows }]) }) };
  assert.equal(lookup(c2, 'Administration / Billing Setup > Allow access to Billing window > Done Button').name, 'Allow access to Billing window > Done Button');
  assert.equal(lookup(c2, 'Allow access to Billing window > Done Button').name, 'Allow access to Billing window > Done Button');
  assert.equal(lookup(c2, 'Progress Notes > Lock Chart').name, 'Lock Chart');
  assert.equal(lookup(c2, 'Done Button'), null);
  const x = inspect({ name: 'm.xlsx', data: buildXlsx([{ name: 'M', rows: MATRIX }]) }, { catalog: cat, ignoreSubjects: 'eCW SUPPORT*' });
  const cc = x.catalogCheck;
  assert.equal(cc.total, cat.settings.length); assert.equal(cc.known, 3, 'Delete Payments, Lock Chart, Accounts LookUp');
  assert.deepEqual(cc.unknown.map(u => u.name).sort(), ['Administration / Billing Setup > Eligibility Admin', 'Documents > Configure Letter Category']);
  assert.equal(cc.uncovered.length, cat.settings.length - 3);
  assert.equal(catalogCheck([{ permission: 'Delete Payment' }], cat).unknown[0].suggestion, 'Delete Payments');
});

// ───────── eCW exports one ROLE at a time ─────────

const roleExport = (perm, withCol) => { const rows = [['Security Setting Name', 'Security Setting Description', 'Security Setting Type', 'Security group Name', ...(withCol ? ['Permission'] : [])]]; for (const [g, n, d] of [...SETTINGS.map(([g, n, d]) => [g, n, d])]) { const on = perm(g, n); if (withCol) rows.push([n, d, 'Old', g, on ? 'TRUE' : 'FALSE']); else if (on) rows.push([n, d, 'Old', g]); } return rows; };

test('role export: a catalog-shaped file with a role name is that role\'s grants; with a Permission column the value is used; without, listed = granted', () => {
  const noCol = roleExport((g, n) => SETTINGS.find(s => s[1] === n)[3][0] === 1, false);   // what the Provider role has, as eCW lists it
  const like = detectCatalogLike(noCol); assert.equal(like.permission, -1);
  assert.equal(detectCatalog(noCol) !== null, true, 'without a role it is indistinguishable from the catalog');
  assert.throws(() => extractRoleList(noCol, ''), /the role this export belongs to is not stated/);
  const r = extractRoleList(noCol, 'Provider', like, 'Sheet1');
  assert.equal(r.records.length, SETTINGS.filter(s => s[3][0]).length); assert.ok(r.records.every(x => x.subject === 'Provider' && x.value === 'Y'));
  assert.equal(r.records.find(x => /Lock Chart/.test(x.permission)).permission, 'Progress Notes > Lock Chart');
  assert.match(r.warnings[0], /no Permission column — all \d+ listed settings were read as GRANTED to "Provider"/);
  const withCol = roleExport((g, n) => SETTINGS.find(s => s[1] === n)[3][0] === 1, true);
  const c2 = detectCatalogLike(withCol); assert.equal(c2.permission, 4); assert.equal(detectCatalog(withCol), null, 'a Permission column means grants, not the catalog');
  const r2 = extractRoleList(withCol, 'Provider', c2);
  assert.equal(r2.records.length, SETTINGS.length); assert.equal(r2.granted, SETTINGS.filter(s => s[3][0]).length);
  assert.equal(r2.records.find(x => /Delete Payments/.test(x.permission)).value, 'N');
  // a title line names the role
  const titled = [['Security Settings - Billing'], [], ...withCol];
  assert.equal(roleNameFromSheet(titled, detectCatalogLike(titled)), 'Billing');
  const x = workbookToRecords({ sheets: [{ name: 'Sheet1', rows: titled }] });
  assert.equal(x.kind, 'role-list'); assert.equal(x.role, 'Billing'); assert.equal(x.layout.layout, 'role-list');
  assert.throws(() => workbookToRecords({ sheets: [{ name: 'Sheet1', rows: withCol }] }), /export for ONE ROLE \(it has a Permission column\) but the role is not stated/);
  assert.throws(() => workbookToRecords({ sheets: [{ name: 'Sheet1', rows: noCol }] }), /CATALOG[\s\S]*export for ONE ROLE[\s\S]*--role/);
  assert.equal(workbookToRecords({ sheets: [{ name: 'Sheet1', rows: noCol }] }, { role: 'Provider' }).records[0].subject, 'Provider');
  const ins = inspect({ name: 'p.xlsx', data: buildXlsx([{ name: 'S', rows: noCol }]) }, { role: 'Provider' });
  assert.equal(ins.kind, 'role-list'); assert.equal(ins.role, 'Provider'); assert.match(ins.readAs, /per-role export for "Provider" \(listed = granted\)/);
});

test('role export: several files, one per role, are merged and compared against the matrix\'s role columns; role names match without their parenthetical', () => {
  // baseline: the matrix by role (no Users sheet) — its columns are Provider, Nurse, … ; eCW: one export per role, named as eCW names them
  const matrix = [['Security Item', 'Description', 'Security Group Name', ...['Provider', 'Front Desk', 'Nurse', 'Biller', 'Practice Admin']], ...SETTINGS.map(([g, n, d, v]) => [n, d, g, ...v.map(x => (x ? 'X' : ''))])];
  const bf = path.join(tmp, 'matrix2.xlsx'); fs.writeFileSync(bf, buildXlsx([{ name: 'UPGRADE V12.0.4', rows: matrix }]));
  const has = role => (g, n) => SETTINGS.find(s => s[1] === n)[3][['Provider', 'Front Desk', 'Nurse', 'Biller', 'Practice Admin'].indexOf(role)] === 1;
  const files = {
    'Provider (Provider)': roleExport(has('Provider'), false),
    'Nurse (RN/LVN)': roleExport((g, n) => has('Nurse')(g, n) || n === 'SS EPrescription', false),   // excess: a nurse can e-prescribe
    'Biller': roleExport((g, n) => has('Biller')(g, n) && n !== 'Delete Payments', true),            // missing: with a Permission column
    'Practice Admin (Admin)': roleExport(has('Practice Admin'), true),
  };
  const actuals = Object.entries(files).map(([role, rows]) => ({ src: { name: role.replace(/[^a-z]/gi, '_') + '.xlsx', data: buildXlsx([{ name: 'Sheet1', rows }]) }, role }));
  const v = validate(bf, actuals, { baseline: {}, catalog: CATALOG });
  const r = v.result;
  assert.equal(r.users.baseline, 5); assert.equal(r.users.ecw, 4); assert.equal(r.users.both, 4, 'Provider (Provider), Nurse (RN/LVN) and Practice Admin (Admin) match their matrix columns by name');
  assert.deepEqual(r.matches.filter(m => m.kind === 'user').map(m => [m.baseline, m.ecw]).sort(), [['Nurse', 'Nurse (RN/LVN)'], ['Practice Admin', 'Practice Admin (Admin)'], ['Provider', 'Provider (Provider)']]);
  assert.equal(r.findings.find(f => f.type === 'user-not-in-ecw').user, 'Front Desk');
  assert.equal(r.findings.find(f => f.type === 'excess').user, 'Nurse'); assert.equal(r.findings.find(f => f.type === 'excess').permission, 'SureScripts > SS EPrescription');
  assert.equal(r.findings.find(f => f.type === 'missing').user, 'Biller'); assert.match(r.findings.find(f => f.type === 'missing').permission, /Delete Payments/);
  assert.deepEqual(r.counts, { ...r.counts, excess: 1, missing: 1, different: 0, 'user-not-in-baseline': 0, 'user-not-in-ecw': 1 });
  assert.equal(r.counts.ok, 4 * SETTINGS.length - 2);
  assert.equal(v.actual.files.length, 4); assert.equal(v.actual.files[1].role, 'Nurse (RN/LVN)'); assert.match(v.meta.actualLayout, /4 files/);
  assert.match(v.actual.warnings.join('\n'), /Nurse__RN_LVN_\.xlsx: sheet "Sheet1": no Permission column — all \d+ listed settings were read as GRANTED/);
  assert.match(v.actual.warnings.join('\n'), /Biller\.xlsx: sheet "Sheet1": role "Biller": \d+ of \d+ settings granted/);
  // the same role twice → the later file wins, and it says so
  const twice = validate(bf, [actuals[0], actuals[0]], {}); assert.match(twice.actual.warnings.join('\n'), /same role appears in more than one file: Provider \(Provider\)/);
  // suggestions strip the parenthetical too
  const rec = (subject, permission, raw) => ({ subject, permission, value: normalizeValue(raw), raw, row: 0 });
  const sug = compare([rec('Clinical IT Liason', 'A', 'Y')], [rec('Clinical IT Liaison (Clinical IT Liaison)', 'A', 'Yes')]);
  assert.equal(sug.findings.find(f => f.type === 'user-not-in-ecw').suggestion, 'Clinical IT Liaison (Clinical IT Liaison)');
});

test('role export: CLI takes one --actual per role ("Role=file"), --role for one file, --actual-dir; the server takes actuals[]', async () => {
  const run = (...a) => spawnSync(process.execPath, [path.join(root, 'bin/ecw-validate.js'), ...a], { encoding: 'utf8' });
  const matrix = [['Security Item', 'Description', 'Security Group Name', 'Provider', 'Nurse'], ...SETTINGS.map(([g, n, d, v]) => [n, d, g, v[0] ? 'X' : '', v[2] ? 'X' : ''])];
  const bf = path.join(tmp, 'matrix3.xlsx'); fs.writeFileSync(bf, buildXlsx([{ name: 'M', rows: matrix }]));
  const dir = path.join(tmp, 'roles-cli'); fs.mkdirSync(dir, { recursive: true });
  const prov = roleExport((g, n) => SETTINGS.find(s => s[1] === n)[3][0] === 1, false), nurse = roleExport((g, n) => SETTINGS.find(s => s[1] === n)[3][2] === 1, false);
  fs.writeFileSync(path.join(dir, 'Provider.xlsx'), buildXlsx([{ name: 'S', rows: prov }])); fs.writeFileSync(path.join(dir, 'Nurse.xlsx'), buildXlsx([{ name: 'S', rows: nurse }]));
  let r = run('validate', '--baseline', bf, '--actual', `Provider=${path.join(dir, 'Provider.xlsx')}`, '--actual', `Nurse=${path.join(dir, 'Nurse.xlsx')}`, '--quiet');
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /^PASS/);
  r = run('validate', '--baseline', bf, '--actual-dir', dir, '--quiet'); assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /^PASS/);
  r = run('validate', '--baseline', bf, '--actual', path.join(dir, 'Provider.xlsx'), '--role', 'Provider', '--fail-on', 'none'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Nurse — expected by the baseline but not in eCW — export it from eCW/);
  r = run('validate', '--baseline', bf, '--actual', path.join(dir, 'Provider.xlsx')); assert.equal(r.status, 2); assert.match(r.stderr, /CATALOG[\s\S]*--role/);
  r = run('inspect', path.join(dir, 'Provider.xlsx'), '--role', 'Provider'); assert.equal(r.status, 0); assert.match(r.stdout, /per-role export for "Provider"/);
  const s = await serve({ port: 0 });
  try {
    const u = `http://127.0.0.1:${s.port}`; const b64 = f => fs.readFileSync(f).toString('base64');
    const res = await fetch(u + '/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseline: { name: 'm.xlsx', data: b64(bf) }, actuals: [{ name: 'Provider.xlsx', data: b64(path.join(dir, 'Provider.xlsx')), role: 'Provider' }, { name: 'Nurse.xlsx', data: b64(path.join(dir, 'Nurse.xlsx')), role: 'Nurse' }] }) });
    const j = await res.json(); assert.equal(res.status, 200, j.error); assert.equal(j.pass, true); assert.equal(j.actual.files.length, 2); assert.equal(j.actual.files[1].role, 'Nurse');
  } finally { await s.close(); }
});

// ───────── the browser build's own DEFLATE decoder ─────────

test('inflate: the plain-JS decoder matches node:zlib on stored, fixed and dynamic blocks, and on real workbooks', async () => {
  const zlib = await import('node:zlib');
  const { inflateRaw } = await import('../src/zlib-browser.js');
  const same = (buf, label) => { for (const level of [0, 1, 6, 9]) { const packed = zlib.deflateRawSync(buf, { level }); const back = Buffer.from(inflateRaw(packed)); assert.equal(Buffer.compare(back, buf), 0, `${label} level ${level}`); } };
  same(Buffer.alloc(0), 'empty'); same(Buffer.from('a'), 'one byte'); same(Buffer.from('abcabcabcabcabcabcabcabc'), 'repeats');
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rand = Buffer.alloc(200000); for (let i = 0; i < rand.length; i++) rand[i] = rnd() < 0.7 ? 65 + Math.floor(rnd() * 8) : Math.floor(rnd() * 256);
  same(rand, 'mixed random'); same(Buffer.alloc(70000, 7), 'long run'); same(Buffer.from('x'.repeat(100000) + 'y'.repeat(70000)), 'two runs');
  for (const f of [BASELINE, EXPORT, CATALOG]) { const z = unzip(fs.readFileSync(f)); for (const n of z.names()) assert.ok(z.get(n).length >= 0, n); }
  assert.throws(() => inflateRaw(Buffer.from([7, 0])), /invalid block type/);
});

// ───────── documenting eCW: the per-role exports as one inventory workbook ─────────

test('document: the sample per-role exports become an eCW matrix (settings down, roles across) with descriptions, and compare cleanly except for the planted differences', () => {
  const actuals = ROLE_FILES.map(f => ({ src: f, role: path.basename(f, '.xlsx') }));
  const d = documentEcw(actuals, { catalog: CATALOG });
  assert.deepEqual(d.sheets.map(s => s.name), ['eCW matrix', 'Roles', 'Settings', 'Source']);
  const M = d.sheets[0].rows;
  assert.deepEqual(M[0], ['Group', 'Security setting', 'What it controls', 'Provider', 'Front Desk', 'Nurse', 'Biller', 'Practice Admin', 'Roles holding it', 'In catalog'], 'roles in the order the files were given');
  assert.equal(M.length, 1 + SETTINGS.length + CATALOG_EXTRA.length, 'with the catalog, every eCW setting is a row even if no role holds it');
  const row = M.find(r => r[1] === 'Delete Payments');
  assert.deepEqual(row.slice(3, 8), ['', '', '', '', 'X'], 'Biller had Delete Payments removed in eCW; Practice Admin has it');
  assert.equal(row[8], 1); assert.equal(row[2], 'Grants or denies users permission to delete both patient and insurance payments');
  const lock = M.find(r => r[1] === 'Lock Chart'); assert.equal(lock[3], '', 'Provider lost Lock Chart in eCW');
  const R = d.sheets[1].rows; assert.equal(R.length, 6); assert.deepEqual(R[1].slice(0, 3), ['Provider', 'Provider.xlsx', 14]);
  assert.match(d.sheets[3].rows.find(r => r[0] === 'Catalog')[1], /catalog\.xlsx \(\d+ settings\)/);
  // without a catalog, groups and descriptions come from the exports themselves
  const d2 = documentEcw(actuals);
  assert.equal(d2.sheets[0].rows[0].length, 9); assert.equal(d2.sheets[0].rows.find(r => r[1] === 'Delete Payments')[0], 'Administration / Billing Setup');
  // and the same exports, compared with the matrix, show exactly the planted role-level differences
  const rolesOnly = path.join(tmp, 'matrix-roles.xlsx'); fs.writeFileSync(rolesOnly, buildXlsx(baselineSheets({ users: false })));
  const v = validate(rolesOnly, actuals, { catalog: CATALOG });
  assert.equal(v.result.users.both, 5);
  const types = v.result.findings.filter(f => f.severity !== 'info').map(f => `${f.user}|${f.type}|${f.permission}`).sort();
  assert.deepEqual(types.filter(t => /excess|missing/.test(t)), ['Biller|missing|Administration / Billing Setup > Delete Payments', 'Front Desk|excess|Administration / System Admin Setup > Allow Access to Patient Merge', 'Nurse|excess|SureScripts > SS EPrescription', 'Provider|missing|Progress Notes > Lock Chart']);
});

test('document: CLI and API', async () => {
  const run = (...a) => spawnSync(process.execPath, [path.join(root, 'bin/ecw-validate.js'), ...a], { encoding: 'utf8' });
  const out = path.join(tmp, 'ecw-settings.xlsx');
  let r = run('document', '--actual-dir', path.dirname(ROLE_FILES[0]), '--catalog', CATALOG, '--out', out);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /wrote .*ecw-settings\.xlsx: \d+ settings × 5 role\(s\)/);
  assert.equal(readXlsx(out).sheets[0].rows[0][3], 'Biller', '--actual-dir reads files in name order');
  r = run('document'); assert.equal(r.status, 2); assert.match(r.stderr, /needs at least one --actual/);
  const s = await serve({ port: 0 });
  try {
    const u = `http://127.0.0.1:${s.port}`; const b64 = f => fs.readFileSync(f).toString('base64');
    const res = await fetch(u + '/api/document', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actuals: ROLE_FILES.map(f => ({ name: path.basename(f), data: b64(f), role: path.basename(f, '.xlsx') })), catalog: { name: 'c.xlsx', data: b64(CATALOG) } }) });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-disposition'), /ecw-security-settings-\d{4}-\d\d-\d\d\.xlsx/);
    const wb = readXlsx(Buffer.from(await res.arrayBuffer())); assert.equal(wb.sheets[0].name, 'eCW matrix'); assert.equal(wb.sheets[0].rows.length, 1 + SETTINGS.length + CATALOG_EXTRA.length);
  } finally { await s.close(); }
});
