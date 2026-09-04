// Library entry point: one call from two files (or buffers) to a result + report.
import fs from 'node:fs';
import path from 'node:path';
import { readSpreadsheet, buildXlsx } from './xlsx.js';
import { workbookToRecords } from './parse.js';
import { compare } from './validate.js';
import { buildReport, textSummary, findingsCsv, reportSheets } from './report.js';

export { readSpreadsheet, buildXlsx, workbookToRecords, compare, buildReport, textSummary, findingsCsv, reportSheets };
export * from './parse.js';
export { perUser, SEVERITY } from './validate.js';

/**
 * Validate an eCW export against a baseline.
 *   baseline / actual: a file path, or { name, data: Buffer }
 *   opts.baseline / opts.actual: per-file parse options ({ sheet, layout, subjectCol, permissionCol, valueCol, categoryCol, orientation, blankIsNo, rolesSheet })
 *   opts.compare: { ignoreUsers, ignorePermissions, onlyUsers, reportUnknownPermissions, reportOk }
 * Returns { result, meta, baseline: { sheet, layout, records }, actual: {...} }.
 */
export function validate(baseline, actual, opts = {}) {
  const load = (src, o, label) => {
    const name = typeof src === 'string' ? src : (src?.name || label);
    let wb;
    try { wb = typeof src === 'string' ? readSpreadsheet(src) : readSpreadsheet(src.data, src.name || ''); }
    catch (e) { throw new Error(`${label} (${name}): ${e.message}`); }
    try { return { name, ...workbookToRecords(wb, o || {}) }; }
    catch (e) { throw new Error(`${label} (${name}): ${e.message}`); }
  };
  const b = load(baseline, opts.baseline, 'baseline');
  const a = load(actual, opts.actual, 'eCW export');
  if (!b.records.length) throw new Error(`baseline (${b.name}): no permission records found on sheet "${b.sheet}"`);
  if (!a.records.length) throw new Error(`eCW export (${a.name}): no permission records found on sheet "${a.sheet}"`);
  const result = compare(b.records, a.records, opts.compare || {});
  const meta = {
    when: new Date().toISOString(),
    baseline: path.basename(b.name), baselineSheet: b.sheet, baselineLayout: describeLayout(b),
    actual: path.basename(a.name), actualSheet: a.sheet, actualLayout: describeLayout(a),
  };
  return { result, meta, baseline: b, actual: a };
}

export const describeLayout = x => x.layout.layout === 'long' ? 'long (one row per user + setting)' : `matrix (${x.layout.orientation})${x.expanded ? ', roles expanded to users' : ''}`;

/** Validate and write the report file(s). out may end in .xlsx, .csv or .json. */
export function validateToFile(baseline, actual, out, opts = {}) {
  const v = validate(baseline, actual, opts);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    if (/\.csv$/i.test(out)) fs.writeFileSync(out, findingsCsv(v.result));
    else if (/\.json$/i.test(out)) fs.writeFileSync(out, JSON.stringify({ meta: v.meta, ...v.result }, null, 2));
    else fs.writeFileSync(out, buildReport(v.result, v.meta));
  }
  return v;
}
