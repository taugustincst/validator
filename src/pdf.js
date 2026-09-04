// A small PDF writer (text only, Helvetica, US Letter, multi-page) and the role-differences summary
// laid out with it. No libraries: the file is plain PDF 1.4 with uncompressed content streams,
// which every viewer opens. Text is WinAnsi; characters outside it are approximated.
import { summaryDoc } from './summary.js';

// Helvetica advance widths for WinAnsi 32..255 (per 1000 em), from the Adobe AFM.
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
const WB = W.map(w => Math.round(w * 1.06));   // Helvetica-Bold is a little wider; close enough for wrapping
const WINANSI = { '–': 150, '—': 151, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '…': 133, '€': 128, '™': 153 };
const codeOf = ch => { const c = ch.charCodeAt(0); if (c < 128) return c; if (WINANSI[ch]) return WINANSI[ch]; if (c >= 160 && c <= 255) return c; if (ch === '→' || ch === '➔') return 62; if (ch === '✓' || ch === '✔') return 42; if (ch === '×') return 120; return 63; };
const width = (s, size, bold) => { let w = 0; for (const ch of s) { const c = codeOf(ch); w += (bold ? WB : W)[c - 32] ?? 556; } return w * size / 1000; };
const pdfString = s => { let out = ''; for (const ch of s) { const c = codeOf(ch); if (c === 40 || c === 41 || c === 92) out += '\\' + String.fromCharCode(c); else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0'); else out += String.fromCharCode(c); } return `(${out})`; };

/** Wrap text to a width, breaking on spaces (a single over-long word is cut). */
function wrap(text, size, bold, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean); const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (width(t, size, bold) <= maxW) { cur = t; continue; }
    if (cur) lines.push(cur);
    if (width(w, size, bold) <= maxW) cur = w; else { let piece = ''; for (const ch of w) { if (width(piece + ch, size, bold) > maxW) { lines.push(piece); piece = ch; } else piece += ch; } cur = piece; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Page layout engine: call text()/rule()/space(); pages break themselves. Colours are [r,g,b] 0..1. */
class Doc {
  constructor({ pageW = 612, pageH = 792, margin = 54 } = {}) { this.pageW = pageW; this.pageH = pageH; this.m = margin; this.pages = []; this.newPage(); }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = this.pageH - this.m; }
  ensure(h) { if (this.y - h < this.m + 24) this.newPage(); }
  text(str, { size = 10, bold = false, color = [0, 0, 0], indent = 0, maxW, lineGap = 1.25, keepWith = 0 } = {}) {
    const x = this.m + indent; const mw = maxW ?? (this.pageW - this.m - x);
    const lines = wrap(str, size, bold, mw); const lh = size * lineGap;
    this.ensure(lh * lines.length + keepWith);
    for (const line of lines) { this.y -= lh; this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color.map(c => c.toFixed(3)).join(' ')} rg ${x.toFixed(1)} ${this.y.toFixed(1)} Td ${pdfString(line)} Tj ET`); }
    return lines.length;
  }
  rule(color = [0.85, 0.87, 0.89], w = 0.6) { this.ensure(8); this.y -= 4; this.ops.push(`${color.map(c => c.toFixed(3)).join(' ')} RG ${w} w ${this.m} ${this.y.toFixed(1)} m ${this.pageW - this.m} ${this.y.toFixed(1)} l S`); this.y -= 4; }
  box(h, color) { this.ensure(h); this.y -= h; this.ops.push(`${color.map(c => c.toFixed(3)).join(' ')} rg ${this.m} ${this.y.toFixed(1)} ${this.pageW - 2 * this.m} ${h} re f`); return this.y; }
  bar(color, h) { this.ops.push(`${color.map(c => c.toFixed(3)).join(' ')} rg ${this.m} ${this.y.toFixed(1)} 4 ${h} re f`); }
  space(h) { this.y -= h; }
  build(footer = '') {
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    const fontN = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objs.length + 1 + this.pages.length * 2;   // reserve: each page = content + page object, then the Pages node
    const pageIds = [];
    this.pages.forEach((ops, i) => {
      const foot = `BT /F1 8 Tf 0.45 0.5 0.55 rg ${this.m} ${(this.m - 24).toFixed(1)} Td ${pdfString(footer)} Tj ET BT /F1 8 Tf 0.45 0.5 0.55 rg ${(this.pageW - this.m - width(`Page ${i + 1} of ${this.pages.length}`, 8, false)).toFixed(1)} ${(this.m - 24).toFixed(1)} Td ${pdfString(`Page ${i + 1} of ${this.pages.length}`)} Tj ET`;
      const stream = ops.join('\n') + '\n' + foot;
      const bytes = Buffer.byteLength(stream, 'latin1');
      const cid = add(`<< /Length ${bytes} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.pageW} ${this.pageH}] /Resources << /Font << /F1 ${fontN} 0 R /F2 ${fontB} 0 R >> >> /Contents ${cid} 0 R >>`));
    });
    const pid = add(`<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`);
    if (pid !== pagesId) throw new Error('pdf: object numbering drifted');
    const cat = add(`<< /Type /Catalog /Pages ${pid} 0 R >>`);
    let out = '%PDF-1.4\n%âãÏÓ\n'; const offsets = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

const INK = [0.106, 0.141, 0.188], MUTED = [0.373, 0.424, 0.467], RED = [0.702, 0.149, 0.118], AMBER = [0.541, 0.353, 0], BLUE = [0.169, 0.373, 0.549], GREEN = [0.118, 0.482, 0.271];

/** The role-differences summary as a PDF (Buffer). */
export function buildSummaryPdf(result, meta = {}) {
  const S = summaryDoc(result, meta);
  const d = new Doc();
  d.text(S.title, { size: 17, bold: true, color: INK });
  if (S.subtitle) d.text(S.subtitle, { size: 9, color: MUTED });
  d.space(6);
  for (const [k, v] of S.meta) { d.text(`${k}: ${v}`, { size: 9, color: MUTED }); }
  d.space(8);
  // verdict block
  const vcol = S.verdict.pass ? GREEN : RED;
  const dl = wrap(S.verdict.detail, 10, false, d.pageW - 2 * d.m - 14).length;
  const h = 14 + 16 + dl * 12.5 + 6;
  d.ensure(h);
  const top = d.y; d.y -= 0; d.ops.push(`${vcol.map(c => c.toFixed(3)).join(' ')} rg ${d.m} ${(top - h).toFixed(1)} 4 ${h} re f`);
  d.space(4);
  d.text(S.verdict.headline, { size: 14, bold: true, color: vcol, indent: 12 });
  d.text(S.verdict.detail, { size: 10, color: INK, indent: 12 });
  d.y = top - h; d.space(10);
  // per role
  if (!S.roles.length) d.text('Nothing to change: every role matches the matrix.', { size: 11, color: GREEN });
  for (const r of S.roles) {
    d.rule();
    d.text(r.name + (r.mappedFrom ? `   (${r.mappedFrom})` : ''), { size: 12, bold: true, color: INK, keepWith: 30 });
    if (r.status) d.text(r.status, { size: 9.5, color: MUTED, indent: 0 });
    for (const g of r.groups) {
      const col = g.kind === 'remove' ? RED : g.kind === 'grant' ? AMBER : BLUE;
      d.space(3);
      d.text(g.heading.toUpperCase(), { size: 8.5, bold: true, color: col, keepWith: 14 });
      for (const it of g.items) {
        d.text('• ' + it.text, { size: 10, color: INK, indent: 8 });
        if (it.detail) d.text(it.detail, { size: 8.5, color: MUTED, indent: 18 });
      }
    }
    d.space(6);
  }
  if (S.matched.length) { d.rule(); d.text(`Roles that match the matrix exactly (${S.matched.length})`, { size: 10, bold: true, color: GREEN, keepWith: 14 }); d.text(S.matched.join(', '), { size: 9.5, color: INK }); }
  d.space(8); d.text(S.footer, { size: 8, color: MUTED });
  return d.build('eCW Security Validator');
}
