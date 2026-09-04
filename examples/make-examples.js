// Writes a realistic sample set to try the validator on (and what the tests use). Setting names,
// groups and descriptions are real eCW security attributes, taken from an eCW Security Settings
// catalog export:
//   baseline.xlsx    — sheet "Permissions": settings down, ROLES across (Y/N); sheet "Users": user → role
//   ecw-export.xlsx  — a per-user security settings export: one row per user + setting, the user name
//                      printed once per block, a Category column, a title block above the header
//   catalog.xlsx     — the settings catalog: Security Setting Name | Description | Type | Security group Name
// with a handful of deliberate discrepancies so the report has something to show.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeXlsx, buildXlsx } from '../src/xlsx.js';

export const ROLES = ['Provider', 'Front Desk', 'Nurse', 'Biller', 'Practice Admin'];
// [group, name, description, [Provider, Front Desk, Nurse, Biller, Practice Admin]]
export const SETTINGS = [
  ['Patient Details', 'Allow Access to Pt Hub', 'Grants or denies users access to the Patient Hub.', [1, 1, 1, 1, 1]],
  ['Patient Details', 'Access Problem List', "Provides access to the Patient's Problem List", [1, 0, 1, 0, 1]],
  ['Patient Details', 'AccountNumber Update', 'Allows the user to modify the patients account number in Patient Demographics.', [0, 0, 0, 1, 1]],
  ['Administration / System Admin Setup', 'Allow Access to Patient Merge', 'Allows Access to the Patient Merge Functionalities', [0, 0, 0, 0, 1]],
  ['Administration / System Admin Setup', 'Access to PHI and PII', 'Allow or Deny access to the EMR to restrict access to the PHI and PII.', [1, 1, 1, 1, 1]],
  ['Progress Notes', 'Lock Chart', "Allows the user to lock the chart on a patients Progress Notes.", [1, 0, 0, 0, 0]],
  ['Progress Notes', 'Assessment (including Problem List)', "Grant access to patient's Assessment (including Problem List) in Progress Notes.", [1, 0, 1, 0, 0]],
  ['Progress Notes', 'Access Patient Orders', 'Access Patient Orders', [1, 0, 1, 0, 0]],
  ['Progress Notes', 'Access/View Superbill', 'Allows User to Access/View Superbill on Progress Note and all other areas', [1, 0, 0, 1, 1]],
  ['Locked Progress Notes', 'Edit Addendums', 'Allows the original author of the addendum to edit it on a locked progress note.', [1, 0, 0, 0, 0]],
  ['Locked Progress Notes', 'Clear My Addendums/Delete Addendums', 'Allows the original author to either clear or delete their addendums on a locked note.', [1, 0, 0, 0, 0]],
  ['SureScripts', 'SS EPrescription', 'Allows or denies access to the SureScript ePrescription feature.', [1, 0, 0, 0, 0]],
  ['SureScripts', 'SS Refill Response', 'Allow access to the Refill request window from E Jelly Bean -> Refill Request tab.', [1, 0, 1, 0, 0]],
  ['Billing', 'Batches', 'Allows access to the Batches section in the Billing band.', [0, 1, 0, 1, 1]],
  ['Billing', 'Close Transactions', 'Allows the user to close transactions by time period.', [0, 0, 0, 1, 1]],
  ['Billing', 'Allow users to lock claims', 'Grants or denies users permission to lock claims', [0, 0, 0, 1, 1]],
  ['Billing', 'Allow Postings on Locked Insurance Payments', 'Grants or denies the right to post to a locked insurance payment.', [0, 0, 0, 1, 0]],
  ['Billing', 'Accounts LookUp', 'Allows access to the Accounts Lookup tool in the Billing band.', [0, 1, 0, 1, 1]],
  ['Administration / Billing Setup', 'Delete Payments', 'Grants or denies users permission to delete both patient and insurance payments', [0, 0, 0, 1, 1]],
  ['Administration / Billing Setup', 'Delete Refunds', 'Grants or denies user permission to delete refunds.', [0, 0, 0, 1, 1]],
  ['Administration / Billing Setup', 'Changing Fee schedule', 'Allows the user to create a new fee schedule, or update, copy, or delete an existing fee schedule.', [0, 0, 0, 0, 1]],
  ['Administration / Billing Setup', 'CPT Codes', 'Allows the user to create, update, or delete CPT Codes from the Billing menu.', [0, 0, 0, 1, 1]],
  ['Administration / Billing Setup', 'Insurances', 'Allows the user to create, update, or delete insurances from the File menu.', [0, 1, 0, 1, 1]],
  ['Scheduling', 'Allow Access to Block Hours', 'Allows users access to add, update, or delete Appointment Blocks', [0, 1, 0, 0, 1]],
  ['Scheduling', 'Allow appointment creation outside working hours', 'Allow creating appointment out side of working hours.', [0, 1, 0, 0, 1]],
  ['Scheduling', 'Allow access to Move Appointment to Bump List', 'Grants or denies users permission to move appointments to the Bump List.', [0, 1, 1, 0, 1]],
  ['Documents', 'Delete Reviewed Document', 'Allows the user to delete a reviewed document in the Patient Documents window.', [0, 0, 0, 0, 1]],
  ['Documents', 'Allow user to delete documents from repository', 'Allow user to delete documents from repository', [0, 0, 0, 0, 1]],
  ['Documents', 'Bulk Actions', 'Allow users to access Bulk Actions on the Review Documents window.', [1, 0, 1, 0, 1]],
  ['Reports', 'Report - Billing Summary', 'Allows access to the Billing summary report.', [0, 0, 0, 1, 1]],
  ['Reports', 'Live Operations Dashboard', 'Allow access to Live Operations Dashboard.', [0, 0, 0, 0, 1]],
  ['Patient Portal', 'Permission to web enable patients', 'Grants or denies users permission to web-enable patients for the Patient Portal.', [0, 1, 1, 0, 1]],
  ['Patient Portal', 'Publish/UnPublish Reviewed labs', 'Grants or denies permission to publish reviewed lab results to the Patient Portal.', [1, 0, 1, 0, 0]],
  ['Logs', 'Security Access Logs', 'Grants or denies users permission to view Security Settings Access logs from the Admin Band.', [0, 0, 0, 0, 1]],
  ['Logs', 'Access Log Report', 'Allows the user to view generated access logs.', [0, 0, 0, 0, 1]],
  ['Administration / Users Configuration', 'Change Password', 'The security item provides access to Change Password', [1, 1, 1, 1, 1]],
];
// Catalog-only settings: real eCW attributes the baseline says nothing about (coverage gaps).
export const CATALOG_EXTRA = [
  ['Billing', 'Calculate Finance Charges', 'The user can calculate the finance charges'],
  ['Billing', 'Create Multiple Claims', 'The user can create multiple claims'],
  ['Progress Notes', 'Birth Vitals', 'Allows the user to edit Birth Vitals.'],
  ['Progress Notes', 'Lock Lab Result Grid', 'Lock grid for electronic lab result'],
  ['Scheduling', 'Allow Access to Working Hours Configuration', 'Allows users to access the Working Hours Configuration menu'],
  ['Scheduling', 'Allow Access to Rule Set Configuration', 'This security feature will allow the user to access the Rule Set Configuration functionality.'],
  ['Patient Details', 'Allow Access to Copy Demographics', 'Allows users to access the Copy Demographics feature from the Patient Information screen.'],
  ['Patient Details', 'Access Right Panel', "Provides access to the Patient's Right Chart Panel."],
  ['Documents', 'Bulk Restore Faxes', 'This security feature will allow the user to bulk restore soft deleted incoming faxes.'],
  ['Documents', 'Auto-Assign Document Rules', 'Allows a user access to the Auto-Assign Document Rules window.'],
  ['Administration / System Admin Setup', 'Add Provider by NPI', 'Allows user to add provider demographics by searching through the NPPES Registry.'],
  ['Reports', 'Access QRDA', 'Allows access to QRDA'],
  ['SureScripts', 'SS Message Viewer', 'Allows or denies access to the SureScript message viewer.'],
  ['Patient Portal', 'Blast eMsg', 'Allow access to send blast eMsg.'],
  ['Patient Portal', 'Mass eMsg', 'Allow access to send mass eMsg.'],
  ['Patient Portal', 'Web Encounter', 'Grants or denies user access to add and update Web Encounters.'],
  ['Logs', 'Show user logs', 'Grants or denies administrators permission to view the log file that keeps track of user logins.'],
  ['Administration / Billing Setup', 'ERA', 'Allows or denies access to the ERA (Electronic Remittance Advice) section in the Billing band.'],
  ['Administration / Billing Setup', 'ICD Codes', 'Allows the user to create, update, or delete ICD Codes from the Billing menu.'],
  ['Locked Progress Notes', 'Display Staff Signature', 'Enable this setting to show the "Display My Signature (Staff)" option in the lock menu.'],
];
export const USERS = [
  ['agarcia', 'Provider'], ['bpatel', 'Provider'], ['cnguyen', 'Nurse'], ['dlee', 'Nurse'],
  ['efoster', 'Front Desk'], ['fmorales', 'Front Desk'], ['gkim', 'Biller'], ['hrivera', 'Practice Admin'],
  ['ijones', 'Front Desk'],   // in the baseline but NOT in eCW
];

// eCW-side deviations: [user, "Group > Setting", value]
export const DEVIATIONS = [
  ['efoster', 'Administration / System Admin Setup > Allow Access to Patient Merge', 'Yes'],   // excess (high): front desk can merge patients
  ['cnguyen', 'SureScripts > SS EPrescription', 'Yes'],                                       // excess (high): a nurse can e-prescribe
  ['bpatel', 'Progress Notes > Lock Chart', 'No'],                                            // missing (medium)
  ['gkim', 'Administration / Billing Setup > Delete Payments', 'No'],                         // missing (medium)
  ['dlee', 'Progress Notes > Access Patient Orders', 'View Only'],                            // different level (medium)
];
export const EXTRA_USER = ['ztemp', { 'Patient Details > Allow Access to Pt Hub': 'Yes', 'Billing > Batches': 'Yes', 'Administration / Users Configuration > Change Password': 'Yes' }];   // in eCW, not in the baseline
export const EXTRA_SETTING = ['Patient Portal', 'Blast eMsg'];   // in eCW and the catalog, not in the baseline

/** The master matrix by role; with `users`, a second sheet maps users to roles (for a per-user eCW side). */
export function baselineSheets({ users = true } = {}) {
  const permissions = [['Category', 'Security Setting', 'What it controls', ...ROLES], ...SETTINGS.map(([cat, name, desc, v]) => [cat, name, desc, ...v.map(x => (x ? 'Y' : 'N'))])];
  const sheets = [{ name: 'Permissions', rows: permissions, widths: [30, 44, 60, 12, 12, 12, 12, 14] }];
  if (users) sheets.push({ name: 'Users', rows: [['User', 'Role'], ...USERS], widths: [16, 16] });
  return sheets;
}

export function ecwExportRows() {
  const rows = [['eClinicalWorks — User Security Settings'], ['Practice: Sample Family Medicine', '', 'Printed: 2026-09-01'], [], ['User Name', 'Category', 'Security Setting', 'Value']];
  const dev = new Map(DEVIATIONS.map(([u, p, v]) => [`${u}|${p}`, v]));
  for (const [user, role] of USERS) {
    if (user === 'ijones') continue;
    const ri = ROLES.indexOf(role);
    let first = true;
    for (const [cat, name, , v] of SETTINGS) {
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

export function catalogRows() {
  const all = [...SETTINGS.map(([g, n, d]) => [g, n, d]), ...CATALOG_EXTRA].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return [['Security Setting Name', 'Security Setting Description', 'Security Setting Type', 'Security group Name'], ...all.map(([g, n, d]) => [n, d, 'Old', g])];
}

/** eCW's per-ROLE export, as Export to Excel writes it: the catalog columns, only the settings the role holds. */
export function roleExportRows(role) {
  const ri = ROLES.indexOf(role);
  const dev = new Map(DEVIATIONS.filter(([u]) => USERS.find(([user]) => user === u)?.[1] === role).map(([, p, v]) => [p, v]));   // the planted differences, by role
  const rows = [['Security Setting Name', 'Security Setting Description', 'Security Setting Type', 'Security group Name']];
  for (const [g, n, d, v] of SETTINGS) { const key = `${g} > ${n}`; const has = dev.has(key) ? dev.get(key) !== 'No' : !!v[ri]; if (has) rows.push([n, d, 'Old', g]); }
  if (role === 'Provider') rows.push([EXTRA_SETTING[1], 'Allow access to send blast eMsg.', 'Old', EXTRA_SETTING[0]]);
  return rows;
}

/** The sample set for the web page: the matrix by role (no user list) and one export per role. */
export function webSamples() { return { 'baseline.xlsx': buildXlsx(baselineSheets({ users: false })), 'catalog.xlsx': buildXlsx([{ name: 'Sheet1', rows: catalogRows() }]), ...Object.fromEntries(ROLES.map(role => [`roles/${role}.xlsx`, buildXlsx([{ name: 'Sheet1', rows: roleExportRows(role) }])])) }; }

export function writeExamples(dir) {
  const b = path.join(dir, 'baseline.xlsx'), a = path.join(dir, 'ecw-export.xlsx'), c = path.join(dir, 'catalog.xlsx');
  writeXlsx(b, baselineSheets());
  writeXlsx(a, [{ name: 'Security Settings', rows: ecwExportRows(), widths: [16, 34, 44, 10], freeze: false, styles: (r) => (r === 3 ? 1 : 0) }]);
  writeXlsx(c, [{ name: 'Sheet1', rows: catalogRows(), widths: [44, 80, 10, 34] }]);
  const rolesDir = path.join(dir, 'roles'); fs.mkdirSync(rolesDir, { recursive: true });
  const out = [b, a, c];
  for (const role of ROLES) { const f = path.join(rolesDir, `${role}.xlsx`); writeXlsx(f, [{ name: 'Sheet1', rows: roleExportRows(role), widths: [44, 80, 10, 34] }]); out.push(f); }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const f of writeExamples(path.dirname(fileURLToPath(import.meta.url)))) console.log('wrote', f);
}
