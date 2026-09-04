// Writes a realistic sample pair to try the validator on (and what the tests use):
//   baseline.xlsx   — sheet "Permissions": settings down, ROLES across (Y/N); sheet "Users": user → role
//   ecw-export.xlsx — what eCW's Security Settings export looks like: one row per user + setting,
//                     with the user name printed once per block and a Category column
// with a handful of deliberate discrepancies so the report has something to show.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeXlsx } from '../src/xlsx.js';

export const ROLES = ['Provider', 'Front Desk', 'Nurse', 'Biller', 'Practice Admin'];
export const SETTINGS = [
  ['Patient', 'View patient demographics', [1, 1, 1, 1, 1]],
  ['Patient', 'Edit patient demographics', [1, 1, 1, 0, 1]],
  ['Patient', 'Delete patient', [0, 0, 0, 0, 1]],
  ['Patient', 'Merge patients', [0, 0, 0, 0, 1]],
  ['Progress Notes', 'View progress notes', [1, 0, 1, 1, 1]],
  ['Progress Notes', 'Lock progress notes', [1, 0, 0, 0, 0]],
  ['Progress Notes', 'Unlock progress notes', [0, 0, 0, 0, 1]],
  ['Progress Notes', 'Addendum to locked notes', [1, 0, 0, 0, 0]],
  ['Orders', 'Order labs', [1, 0, 1, 0, 0]],
  ['Orders', 'Order imaging', [1, 0, 1, 0, 0]],
  ['Rx', 'Prescribe medications', [1, 0, 0, 0, 0]],
  ['Rx', 'Prescribe controlled substances (EPCS)', [1, 0, 0, 0, 0]],
  ['Rx', 'Refill medications', [1, 0, 1, 0, 0]],
  ['Billing', 'View claims', [0, 1, 0, 1, 1]],
  ['Billing', 'Edit claims', [0, 0, 0, 1, 1]],
  ['Billing', 'Post payments', [0, 1, 0, 1, 1]],
  ['Billing', 'Write-off / adjustments', [0, 0, 0, 1, 1]],
  ['Billing', 'Fee schedule', [0, 0, 0, 0, 1]],
  ['Scheduling', 'View appointments', [1, 1, 1, 1, 1]],
  ['Scheduling', 'Book appointments', [0, 1, 1, 0, 1]],
  ['Scheduling', 'Delete appointments', [0, 1, 0, 0, 1]],
  ['Admin', 'Security settings', [0, 0, 0, 0, 1]],
  ['Admin', 'User administration', [0, 0, 0, 0, 1]],
  ['Admin', 'Audit logs', [0, 0, 0, 0, 1]],
  ['Admin', 'Item / CPT / ICD setup', [0, 0, 0, 1, 1]],
  ['Documents', 'Scan / attach documents', [1, 1, 1, 1, 1]],
  ['Documents', 'Delete documents', [0, 0, 0, 0, 1]],
  ['Labs', 'Enter lab results', [1, 0, 1, 0, 0]],
  ['Labs', 'Release results to portal', [1, 0, 1, 0, 0]],
  ['Reports', 'Run financial reports', [0, 0, 0, 1, 1]],
];
export const USERS = [
  ['agarcia', 'Provider'], ['bpatel', 'Provider'], ['cnguyen', 'Nurse'], ['dlee', 'Nurse'],
  ['efoster', 'Front Desk'], ['fmorales', 'Front Desk'], ['gkim', 'Biller'], ['hrivera', 'Practice Admin'],
  ['ijones', 'Front Desk'],   // in the baseline but NOT in eCW
];

// eCW-side deviations: [user, "Category > Setting", value]
export const DEVIATIONS = [
  ['efoster', 'Admin > Security settings', 'Yes'],            // excess (high): a front-desk user with admin
  ['cnguyen', 'Rx > Prescribe medications', 'Yes'],           // excess (high)
  ['bpatel', 'Progress Notes > Lock progress notes', 'No'],   // missing (medium)
  ['gkim', 'Billing > Post payments', 'No'],                  // missing (medium)
  ['dlee', 'Orders > Order labs', 'View Only'],               // different level (medium)
];
export const EXTRA_USER = ['ztemp', { 'Patient > View patient demographics': 'Yes', 'Billing > Edit claims': 'Yes', 'Scheduling > View appointments': 'Yes' }];   // in eCW, not in the baseline
export const EXTRA_SETTING = ['Telehealth', 'Start video visit'];   // in eCW, not in the baseline

export function baselineSheets() {
  const permissions = [['Category', 'Security Setting', ...ROLES], ...SETTINGS.map(([cat, name, v]) => [cat, name, ...v.map(x => (x ? 'Y' : 'N'))])];
  const users = [['User', 'Role'], ...USERS];
  return [{ name: 'Permissions', rows: permissions, widths: [16, 40, 12, 12, 12, 12, 14] }, { name: 'Users', rows: users, widths: [16, 16] }];
}

export function ecwExportRows() {
  const rows = [['eClinicalWorks — User Security Settings'], ['Practice: Sample Family Medicine', '', 'Printed: 2026-09-01'], [], ['User Name', 'Category', 'Security Setting', 'Value']];
  const dev = new Map(DEVIATIONS.map(([u, p, v]) => [`${u}|${p}`, v]));
  for (const [user, role] of USERS) {
    if (user === 'ijones') continue;
    const ri = ROLES.indexOf(role);
    let first = true;
    for (const [cat, name, v] of SETTINGS) {
      const key = `${user}|${cat} > ${name}`;
      rows.push([first ? user.toUpperCase() : '', cat, name, dev.has(key) ? dev.get(key) : (v[ri] ? 'Yes' : 'No')]);   // eCW prints logins in caps — matching is case-insensitive
      first = false;
    }
    rows.push(['', EXTRA_SETTING[0], EXTRA_SETTING[1], role === 'Provider' ? 'Yes' : 'No']);
  }
  const [zu, zp] = EXTRA_USER; let first = true;
  for (const [cat, name] of SETTINGS) { rows.push([first ? zu : '', cat, name, zp[`${cat} > ${name}`] || 'No']); first = false; }
  return rows;
}

export function writeExamples(dir) {
  const b = path.join(dir, 'baseline.xlsx'), a = path.join(dir, 'ecw-export.xlsx');
  writeXlsx(b, baselineSheets());
  writeXlsx(a, [{ name: 'Security Settings', rows: ecwExportRows(), widths: [16, 16, 40, 10], freeze: false, styles: (r) => (r === 3 ? 1 : 0) }]);
  return [b, a];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const f of writeExamples(path.dirname(fileURLToPath(import.meta.url)))) console.log('wrote', f);
}
