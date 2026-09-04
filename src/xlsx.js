// Dependency-free spreadsheet I/O: read .xlsx / .csv / .tsv into arrays of rows, and write .xlsx.
//
// An .xlsx file is a ZIP of XML parts. Reading needs only the ZIP central directory, raw DEFLATE
// (node:zlib) and a small, tolerant XML scan of the workbook, shared-strings and sheet parts —
// enough for what eCW and Excel export: strings, numbers, booleans, inline strings and formulas
// with cached values. Writing produces a minimal but fully valid workbook with inline strings,
// a bold header row, frozen header, autofilter and column widths.
import fs from 'node:fs';
import zlib from 'node:zlib';

// ─────────────────────────────── ZIP ───────────────────────────────

/** Parse a ZIP buffer into { name → Buffer } (entries decompressed lazily on access). */
export function unzip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a ZIP/xlsx file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const xlen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    entries.set(name, { method, csize, usize, lho });
    off += 46 + nlen + xlen + clen;
  }
  const read = e => {
    if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('corrupt ZIP local header');
    const nlen = buf.readUInt16LE(e.lho + 26);
    const xlen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nlen + xlen;
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported ZIP compression method ${e.method}`);
  };
  return {
    names: () => [...entries.keys()],
    has: n => entries.has(n),
    get: n => { const e = entries.get(n); return e ? read(e) : null; },
    text: n => { const b = read(entries.get(n) || fail(`missing part ${n}`)); return b.toString('utf8'); },
  };
}
const fail = m => { throw new Error(m); };
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Build a ZIP from [{ name, data: Buffer|string }] — deflated, single-disk, no extras. */
export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const dosTime = 0x0000, dosDate = 0x21 | (1 << 5) | ((2024 - 1980) << 9);   // 2024-01-01 00:00: stable output
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const data = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ─────────────────────────────── XML helpers ───────────────────────────────

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const unescapeXml = s => String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return e in ENT ? ENT[e] : m;
});
export const escapeXml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
  // Control characters are illegal in XML 1.0; Excel refuses the file. Drop them.
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

const attr = (tag, name) => { const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`)); return m ? unescapeXml(m[1]) : null; };
/** All <t> text inside an element (rich-text runs concatenated). */
const textOf = xml => { let out = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml))) out += unescapeXml(m[1]); return out; };

export function colToIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
export function indexToCol(i) { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }

// ─────────────────────────────── XLSX read ───────────────────────────────

/**
 * Read a workbook. Returns { sheets: [{ name, rows }] } where rows is an array of arrays; cells are
 * strings, numbers or booleans; empty cells are '' and trailing empty cells are trimmed.
 */
export function readXlsx(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const z = unzip(buf);
  if (!z.has('xl/workbook.xml')) throw new Error('not an .xlsx workbook (xl/workbook.xml missing)');
  const wb = z.text('xl/workbook.xml');
  const rels = z.has('xl/_rels/workbook.xml.rels') ? z.text('xl/_rels/workbook.xml.rels') : '';
  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) { const t = m[0]; relMap.set(attr(t, 'Id'), attr(t, 'Target')); }
  const shared = z.has('xl/sharedStrings.xml') ? parseShared(z.text('xl/sharedStrings.xml')) : [];
  const sheets = [];
  let n = 0;
  for (const m of wb.matchAll(/<sheet\s[^>]*\/?>/g)) {
    n++;
    const tag = m[0];
    const name = attr(tag, 'name') || `Sheet${n}`;
    const rid = attr(tag, 'r:id') || attr(tag, 'id');
    let target = relMap.get(rid) || `worksheets/sheet${n}.xml`;
    target = target.replace(/^\/?(xl\/)?/, '');
    const part = `xl/${target}`;
    if (!z.has(part)) continue;
    sheets.push({ name, rows: parseSheet(z.text(part), shared) });
  }
  return { sheets };
}

function parseShared(xml) {
  const out = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) out.push(textOf(m[1]));
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  const cellRe = /<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
  let m, rowIdx = -1, colIdx = -1;
  while ((m = cellRe.exec(xml))) {
    const head = m[1]; const inner = m[3] || '';
    const ref = attr(head, 'r');
    if (ref) { const rm = ref.match(/^([A-Z]+)(\d+)$/); if (rm) { rowIdx = Number(rm[2]) - 1; colIdx = colToIndex(rm[1]); } else { colIdx++; } }
    else colIdx++;
    if (rowIdx < 0) rowIdx = 0;
    const t = attr(head, 't');
    let v = '';
    if (t === 'inlineStr') v = textOf(inner);
    else {
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      const raw = vm ? unescapeXml(vm[1]) : '';
      if (t === 's') v = shared[Number(raw)] ?? '';
      else if (t === 'b') v = raw === '1';
      else if (t === 'str' || t === 'e') v = raw;
      else if (raw === '') v = '';
      else { const num = Number(raw); v = Number.isFinite(num) ? num : raw; }
    }
    while (rows.length <= rowIdx) rows.push([]);
    const row = rows[rowIdx];
    while (row.length < colIdx) row.push('');
    row[colIdx] = v;
  }
  for (const r of rows) while (r.length && (r[r.length - 1] === '' || r[r.length - 1] == null)) r.pop();
  return rows;
}

// ─────────────────────────────── CSV read ───────────────────────────────

export function parseCsv(text, delimiter) {
  text = String(text).replace(/^﻿/, '');
  if (!delimiter) { const head = text.split(/\r?\n/, 1)[0] || ''; delimiter = (head.match(/\t/g) || []).length > (head.match(/,/g) || []).length ? '\t' : ','; }
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  for (const r of rows) { for (let i = 0; i < r.length; i++) { const t = r[i].trim(); if (t !== '' && /^-?\d+(\.\d+)?$/.test(t)) r[i] = Number(t); } while (r.length && r[r.length - 1] === '') r.pop(); }
  return rows.filter(r => r.length);
}

/** Read any supported file (by extension, or sniffing the ZIP signature) into { sheets }. */
export function readSpreadsheet(input, name = '') {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const fname = Buffer.isBuffer(input) ? name : input;
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip) return readXlsx(buf);
  if (/\.xls$/i.test(fname) && buf.length > 8 && buf.readUInt32LE(0) === 0xe011cfd0) throw new Error(`${fname}: legacy .xls (BIFF) is not supported — open it in Excel and save as .xlsx or .csv`);
  const ext = (fname.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  const text = buf.toString('utf8');
  return { sheets: [{ name: 'Sheet1', rows: parseCsv(text, ext === 'tsv' ? '\t' : undefined) }] };
}

// ─────────────────────────────── XLSX write ───────────────────────────────

/**
 * Write a workbook. sheets: [{ name, rows, widths?: number[], styles?: (row, col, value) => styleId }]
 * Style ids: 0 normal, 1 bold header, 2 red fill, 3 amber fill, 4 green fill, 5 grey text, 6 blue fill.
 */
export function buildXlsx(sheets) {
  const files = [];
  const sheetXml = (s, i) => {
    const rows = s.rows || [];
    const cols = s.widths?.length ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const body = rows.map((r, ri) => {
      const cells = r.map((v, ci) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = `${indexToCol(ci)}${ri + 1}`;
        const st = s.styles ? s.styles(ri, ci, v) : (ri === 0 ? 1 : 0);
        const sa = st ? ` s="${st}"` : '';
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sa}><v>${v}</v></c>`;
        if (typeof v === 'boolean') return `<c r="${ref}" t="b"${sa}><v>${v ? 1 : 0}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${sa}><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    const maxCols = rows.reduce((a, r) => Math.max(a, r.length), 0);
    const dim = rows.length ? `<dimension ref="A1:${indexToCol(Math.max(0, maxCols - 1))}${rows.length}"/>` : '';
    const freeze = s.freeze !== false && rows.length > 1 ? `<sheetViews><sheetView workbookViewId="0"${i === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
    const filter = s.autofilter && rows.length > 1 && maxCols ? `<autoFilter ref="A1:${indexToCol(maxCols - 1)}${rows.length}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${dim}${freeze}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData>${filter}</worksheet>`;
  };
  const safeName = n => String(n).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` });
  files.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(safeName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: 'xl/styles.xml', data: STYLES });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, i) }));
  return zip(files);
}

export function writeXlsx(file, sheets) { fs.writeFileSync(file, buildXlsx(sheets)); return file; }

// Fonts: 0 normal, 1 bold, 2 grey. Fills: 0/1 reserved, 2 red, 3 amber, 4 green, 5 blue.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF808080"/><name val="Calibri"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF8CBAD"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6E0B4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFBDD7EE"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
export const STYLE = { normal: 0, header: 1, red: 2, amber: 3, green: 4, grey: 5, blue: 6 };
