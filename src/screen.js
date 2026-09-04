// Reading eCW's Security Settings screen from captured frames.
//
// eCW shows the selected role's settings as a table: a beige column-header row (Security Setting
// Name | Description | Security Group Name | Permission), group rows with an orange "−" box and the
// group name, and data rows in alternating white / cream bands with a blue checkbox in the
// Permission column when the role holds the setting. This module finds those rows and checkboxes
// from pixels alone; an OCR step (pluggable, in the page) reads the setting names, and the catalog
// turns OCR text into exact setting names. Frames are merged as the user scrolls.
//
// Images are { width, height, data } with RGBA bytes, the shape of a canvas ImageData.

const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const isBlue = ([r, g, b]) => b > 150 && b - r > 60 && b - g > 30;            // a checked box: saturated blue
const isOrange = ([r, g, b]) => r > 200 && g > 90 && g < 180 && b < 90;        // eCW's orange group-row icon / header bars
const isBeige = ([r, g, b]) => r > 225 && g > 205 && g < 240 && b > 160 && b < 215 && r - b > 20;   // the column-header row
const isCream = ([r, g, b]) => r > 240 && g > 232 && b > 210 && r - b > 8 && r - b < 40;             // the alternating row band
const isWhite = ([r, g, b]) => r > 245 && g > 245 && b > 245;
const isGreyLine = ([r, g, b]) => r < 235 && r > 170 && Math.abs(r - g) < 12 && Math.abs(g - b) < 12;

/** Fraction of pixels along a row segment that satisfy `test` (sampled every `step` px). */
function rowFraction(img, y, x0, x1, test, step = 2) {
  let n = 0, hit = 0;
  for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x += step) { n++; if (test(px(img, x, y))) hit++; }
  return n ? hit / n : 0;
}

/**
 * The table's horizontal extent and its Permission column: the checkbox column is where blue
 * squares stack vertically. Returns { left, right, boxX, boxW } or null when no checkbox is seen.
 */
export function findTable(img) {
  // Column histogram of blue pixels.
  const cols = new Float32Array(img.width);
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 1) if (isBlue(px(img, x, y))) cols[x]++;
  let best = -1, bestV = 0;
  for (let x = 0; x < img.width; x++) if (cols[x] > bestV) { bestV = cols[x]; best = x; }
  if (bestV < 4) return null;
  let x0 = best, x1 = best;
  while (x0 > 0 && cols[x0 - 1] >= bestV * 0.3) x0--;
  while (x1 < img.width - 1 && cols[x1 + 1] >= bestV * 0.3) x1++;
  const boxW = x1 - x0 + 1;
  if (boxW < 6 || boxW > 40) return null;
  // The table spans from the left edge of the cream/white bands to a little right of the checkbox.
  const mid = Math.round((x0 + x1) / 2);
  let left = 0;
  for (let x = mid; x > 0; x--) { const frac = colFraction(img, x, isCream); if (frac > 0.08) left = x; }
  return { left: Math.max(0, left - 4), right: Math.min(img.width - 1, x1 + boxW * 2), boxX: x0, boxW };
}
function colFraction(img, x, test, step = 3) { let n = 0, hit = 0; for (let y = 0; y < img.height; y += step) { n++; if (test(px(img, x, y))) hit++; } return n ? hit / n : 0; }

/**
 * Horizontal bands: [{ top, bottom, kind: 'header'|'group'|'data', checked }] between the table's
 * left edge and its checkbox column. The frame is cut at the thin grey separator lines (and at
 * cream ↔ white tone changes where a separator is missing); each segment is then classified as a
 * whole: the column header is beige, a group row carries the orange icon at the left, a data row
 * has text in the name area. `checked` is whether the segment's checkbox column holds a blue square.
 */
export function findBands(img, table) {
  const { left, boxX, boxW } = table;
  const textL = left + 4, textR = Math.max(textL + 20, boxX - 10);
  const line = y => rowFraction(img, y, textL, textR, isGreyLine, 2) > 0.5;
  const tone = y => { const c = rowFraction(img, y, textL, textR, isCream), w = rowFraction(img, y, textL, textR, isWhite), b = rowFraction(img, y, textL, textR, isBeige); return b > 0.5 ? 'beige' : c > 0.5 ? 'cream' : w > 0.5 ? 'white' : 'text'; };
  // 1. cut points: separator lines, and tone changes between two non-text rows
  const cuts = [0];
  let prevTone = null;
  for (let y = 0; y < img.height; y++) {
    if (line(y)) { cuts.push(y); while (y + 1 < img.height && line(y + 1)) y++; cuts.push(y + 1); prevTone = null; continue; }
    const t = tone(y);
    if (t !== 'text') { if (prevTone && t !== prevTone) cuts.push(y); prevTone = t; }
  }
  cuts.push(img.height);
  // 2. classify each segment
  const bands = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const top = cuts[i], bottom = cuts[i + 1] - 1;
    if (bottom - top < 8) continue;
    let orange = 0, beige = 0, text = 0, blue = 0, boxN = 0, nonWhite = 0;
    for (let y = top; y <= bottom; y++) {
      if (rowFraction(img, y, left, left + Math.max(40, boxW * 4), isOrange, 2) > 0.15) orange++;
      const t = tone(y); if (t === 'beige') beige++; if (t === 'text') text++;
      for (let x = boxX; x < boxX + boxW; x += 2) { boxN++; if (isBlue(px(img, x, y))) blue++; }
      if (rowFraction(img, y, textL, textR, c => !isWhite(c), 4) > 0.02) nonWhite++;
    }
    const h = bottom - top + 1;
    const kind = orange >= 3 ? 'group' : beige / h > 0.5 ? 'header' : (text > 0 || nonWhite > 0) ? 'data' : null;
    if (!kind) continue;   // blank space above or below the table
    bands.push({ top, bottom, kind, checked: kind === 'data' ? boxN > 0 && blue / boxN > 0.15 : undefined });
  }
  return bands;
}

/** Match an OCR line to the setting it names: the catalog's closest name above a threshold. `names` is Map(normKey → display). */
export function matchName(text, names, closest, normKey, threshold = 0.6) {
  const k = normKey(String(text || '').replace(/[|_]+/g, ' '));
  if (!k) return null;
  if (names.has(k)) return { name: names.get(k), score: 1 };
  const near = closest(k, names, threshold);
  return near ? { name: near.name, score: near.score } : null;
}

/**
 * A capture session for one role: frames come in as { bands, lines } where lines are OCR results
 * [{ text, top, bottom }] positioned in the same pixel space as the bands; each data band takes the
 * OCR line(s) whose vertical centre falls inside it, the text is matched to a catalog setting, and
 * the checkbox state is recorded. Later frames overwrite earlier ones (the last sighting wins).
 */
export class RoleCapture {
  constructor(role, names, { closest, normKey, threshold = 0.6 } = {}) { this.role = role; this.names = names; this.closest = closest; this.normKey = normKey; this.threshold = threshold; this.seen = new Map(); this.unmatched = []; this.frames = 0; this.group = ''; }
  addFrame({ bands, lines, groups = null }) {
    this.frames++;
    let got = 0;
    for (const b of bands) {
      const inside = lines.filter(l => { const c = (l.top + l.bottom) / 2; return c >= b.top && c <= b.bottom; });
      if (!inside.length) continue;
      const text = inside.map(l => l.text).join(' ').trim();
      if (b.kind === 'group') { if (groups) { const g = this.closest(this.normKey(text), groups, 0.5); if (g) this.group = g.name; } continue; }
      if (b.kind !== 'data') continue;
      const m = matchName(text, this.names, this.closest, this.normKey, this.threshold);
      if (!m) { if (text.length > 3) this.unmatched.push(text); continue; }
      this.seen.set(this.normKey(m.name), { name: m.name, checked: !!b.checked, score: m.score, group: this.group }); got++;
    }
    return got;
  }
  /** Records in the shape the validator uses for a role export with a Permission column. */
  records(groupOf = () => '') {
    return [...this.seen.values()].map(s => { const g = s.group || groupOf(s.name); return { subject: this.role, permission: g ? `${g} > ${s.name}` : s.name, value: s.checked ? 'Y' : 'N', raw: s.checked ? 'checked' : 'unchecked', row: 0, role: this.role, listedOnly: false }; });
  }
  get counts() { let c = 0; for (const s of this.seen.values()) if (s.checked) c++; return { seen: this.seen.size, checked: c, frames: this.frames, unmatched: this.unmatched.length }; }
}

/** The captured roles as a workbook: one sheet per role, catalog columns plus Permission — what eCW's export would carry if it kept the checkbox. */
export function capturedSheets(captures, catalog = null) {
  return captures.map(c => {
    const rows = [['Security Setting Name', 'Security Setting Description', 'Security Setting Type', 'Security group Name', 'Permission']];
    for (const s of [...c.seen.values()].sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.name.localeCompare(b.name))) {
      const k = catalog?.byKey?.get(c.normKey(s.name));
      rows.push([s.name, k?.description || '', k?.type || 'Old', s.group || k?.group || '', s.checked ? 'TRUE' : 'FALSE']);
    }
    return { name: c.role.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), rows, widths: [44, 70, 8, 34, 10] };
  });
}

// ─────────────────────────── reading by position, no OCR ───────────────────────────
//
// eCW lists a role's settings in a fixed order: the groups in the order the catalog export uses,
// and within a group the settings in the catalog's order. So when the list is read from the top
// without skipping, the k-th data row under the g-th group header IS the catalog's k-th setting of
// that group — no text has to be read. Rows are told apart across overlapping frames by a
// fingerprint of the name cell's pixels, which is the same in every frame it appears in.

/**
 * A fingerprint of a band's name cell (x0..x1): the amount of dark "ink" (text) in each of `w`
 * vertical strips, 0..255. A column profile does not move when the band's top edge is found a pixel
 * off in another frame, and two different labels give clearly different profiles.
 */
export function fingerprint(img, band, x0, x1, w = 96) {
  const out = new Array(w).fill(0);
  const bw = Math.max(1, x1 - x0), y0 = band.top, y1 = band.bottom;
  for (let i = 0; i < w; i++) {
    const xa = x0 + Math.floor(i * bw / w), xb = Math.max(xa + 1, x0 + Math.floor((i + 1) * bw / w));
    let ink = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = xa; x < xb; x++) { const [r, g, b] = px(img, Math.min(x, img.width - 1), Math.min(y, img.height - 1)); if ((r + g + b) / 3 < 150) ink++; n++; }
    out[i] = n ? Math.round(255 * ink / n) : 0;
  }
  return out;
}
/** Do two fingerprints show the same cell? Both must carry ink, and the profiles must mostly coincide. */
export const sameCell = (a, b, tol = 0.12) => {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0, u = 0;
  for (let i = 0; i < a.length; i++) { d += Math.abs(a[i] - b[i]); u += Math.max(a[i], b[i]); }
  return u > 0 && d / u < tol;
};

/**
 * Reads one role's list by position. Feed it frames as { bands } where each band carries a
 * fingerprint (`fp`) of its name cell, in screen order, top to bottom. The first frame must show
 * the top of the list (its column header); later frames must overlap the previous one — the
 * capture says when they do not, so the user can scroll back.
 *
 *   catalogOrder: [{ group, settings: [name, …] }] in eCW's display order (the catalog export's order)
 */
export class PositionalCapture {
  constructor(role, catalogOrder) {
    this.role = role; this.order = catalogOrder; this.rows = [];   // [{ kind, fp, checked }] in list order
    this.started = false; this.gaps = 0; this.frames = 0; this.lastWarning = '';
  }
  addFrame({ bands, height }) {
    this.frames++;
    const hasHeader = bands.some(b => b.kind === 'header');
    // A row cut by the frame's top edge was seen whole in the previous frame: drop it. A row cut by
    // the bottom edge is kept but marked partial, and replaced once a later frame shows it whole.
    // (eCW keeps the column header pinned while the list scrolls, so a row cut by the header's bottom edge is cut too.)
    const header = bands.find(b => b.kind === 'header');
    const edge = b => (b.top <= 1 || (this.started && header && b.top <= header.bottom + 3 && b.top > header.top)) ? 'top' : (height && b.bottom >= height - 2) ? 'bottom' : '';
    const content = bands.filter(b => b.kind !== 'header' && edge(b) !== 'top').map(b => ({ kind: b.kind, fp: b.fp, checked: b.checked, partial: edge(b) === 'bottom' }));
    if (!this.started) {
      if (!hasHeader) { this.lastWarning = 'scroll to the top of the list first: the column header row must be in view when reading starts'; return 0; }
      this.started = true; this.rows = content; this.lastWarning = ''; return this.rows.length;
    }
    if (!content.length) return 0;
    // Align: find where the frame's first whole band sits in what we already have (search from the end, whole rows only).
    const lead = content.findIndex(b => !b.partial);
    let at = -1;
    if (lead >= 0) {
      const same = (r, b) => r.kind === b.kind && (r.partial || b.partial || sameCell(r.fp, b.fp));
      for (let i = this.rows.length - 1; i >= 0; i--) {
        if (this.rows[i].partial || !same(this.rows[i], content[lead])) continue;
        const start = i - lead; let ok = 0, bad = 0;
        for (let k = 0; k < content.length && start + k < this.rows.length; k++) { if (start + k < 0) continue; if (same(this.rows[start + k], content[k])) ok++; else bad++; }
        if (!bad && ok >= 1) { at = start; break; }   // the latest clean alignment: scrolling moves forward
      }
    }
    if (at < 0) {
      this.gaps++; this.lastWarning = 'no overlap with the previous frame — scroll back up until a row you already passed is in view, then continue more slowly'; return 0;
    }
    let added = 0;
    content.forEach((b, i) => {
      const j = at + i;
      if (j < 0) return;
      if (j < this.rows.length) { const r = this.rows[j]; if (r.partial && !b.partial) Object.assign(r, b); else if (b.kind === 'data' && !b.partial) r.checked = b.checked; }
      else { this.rows.push(b); added++; }
    });
    this.lastWarning = '';
    return added;
  }
  /** Assign settings by position: group headers advance through the catalog's groups; data rows take the group's settings in order. */
  assign() {
    const out = []; const problems = [];
    let g = -1, k = 0;
    for (const r of this.rows) {
      if (r.kind === 'group') { if (g >= 0 && k !== (this.order[g]?.settings.length || 0)) problems.push(`${this.order[g].group}: ${k} rows seen, ${this.order[g].settings.length} expected`); g++; k = 0; continue; }
      if (g < 0) { problems.push('rows before the first group header'); continue; }
      const grp = this.order[g]; if (!grp) { problems.push('more group headers than the catalog has groups'); break; }
      const name = grp.settings[k];
      if (name) out.push({ group: grp.group, name, checked: !!r.checked, position: k + 1 });
      else problems.push(`${grp.group}: more rows than the catalog's ${grp.settings.length} settings`);
      k++;
    }
    if (g >= 0 && this.order[g] && k !== this.order[g].settings.length && k > 0) problems.push(`${this.order[g].group}: ${k} of ${this.order[g].settings.length} rows seen so far`);
    return { settings: out, problems: [...new Set(problems)], groupsSeen: g + 1, groupsTotal: this.order.length, complete: g + 1 === this.order.length && k === (this.order[g]?.settings.length || 0) && problems.length === 0 };
  }
  get counts() { const a = this.assign(); return { seen: a.settings.length, checked: a.settings.filter(s => s.checked).length, frames: this.frames, gaps: this.gaps, groups: `${a.groupsSeen}/${a.groupsTotal}`, complete: a.complete, problems: a.problems }; }
  /** Records in the validator's shape (a Permission column, so absence is not "not granted"). */
  records() { return this.assign().settings.map(s => ({ subject: this.role, permission: s.group ? `${s.group} > ${s.name}` : s.name, value: s.checked ? 'Y' : 'N', raw: s.checked ? 'checked' : 'unchecked', row: 0, role: this.role, listedOnly: false })); }
}

/** The catalog in eCW's display order: groups as they first appear in the export, settings in export order within each. */
export function displayOrder(catalog) {
  const groups = new Map();
  for (const s of catalog.settings) { if (!groups.has(s.group)) groups.set(s.group, []); groups.get(s.group).push(s.name); }
  return [...groups].map(([group, settings]) => ({ group, settings }));
}

/** capturedSheets() for positional captures: same workbook shape. */
export function positionalSheets(captures, catalog) {
  return captures.map(c => {
    const rows = [['Security Setting Name', 'Security Setting Description', 'Security Setting Type', 'Security group Name', 'Permission']];
    for (const s of c.assign().settings) { const k = catalog.byKey.get(s.name.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, ' ').trim()); rows.push([s.name, k?.description || '', k?.type || 'Old', s.group, s.checked ? 'TRUE' : 'FALSE']); }
    return { name: c.role.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), rows, widths: [44, 70, 8, 34, 10] };
  });
}
