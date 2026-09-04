// Raw DEFLATE decoder in plain JavaScript (RFC 1951), for the browser build where node:zlib does
// not exist. Reads stored, fixed-Huffman and dynamic-Huffman blocks. There is no encoder: the
// browser build writes ZIP entries uncompressed ("stored"), which every spreadsheet program reads.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Build a canonical Huffman decoding table from code lengths: { count[len], symbol[] }. */
function buildTable(lengths) {
  const count = new Uint16Array(16), symbol = new Uint16Array(lengths.length);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

let FIXED_LIT = null, FIXED_DIST = null;
function fixedTables() {
  if (FIXED_LIT) return;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8; for (let i = 144; i < 256; i++) l[i] = 9; for (let i = 256; i < 280; i++) l[i] = 7; for (let i = 280; i < 288; i++) l[i] = 8;
  FIXED_LIT = buildTable(l);
  FIXED_DIST = buildTable(new Uint8Array(30).fill(5));
}

export function inflateRaw(input) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = new Uint8Array(Math.max(1024, src.length * 4)), outLen = 0;
  let pos = 0, bitBuf = 0, bitCnt = 0;
  const ensure = n => { if (outLen + n > out.length) { let cap = out.length * 2; while (cap < outLen + n) cap *= 2; const nb = new Uint8Array(cap); nb.set(out.subarray(0, outLen)); out = nb; } };
  const bits = n => { while (bitCnt < n) { if (pos >= src.length) throw new Error('inflate: unexpected end of data'); bitBuf |= src[pos++] << bitCnt; bitCnt += 8; } const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v; };
  const decode = t => {   // canonical Huffman decode, one bit at a time (puff.c style)
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = t.count[len];
      if (code - count < first) return t.symbol[index + (code - first)];
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: bad Huffman code');
  };
  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {   // stored
      bitBuf = 0; bitCnt = 0;
      if (pos + 4 > src.length) throw new Error('inflate: truncated stored block');
      const len = src[pos] | (src[pos + 1] << 8); const nlen = src[pos + 2] | (src[pos + 3] << 8); pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored block length check failed');
      if (pos + len > src.length) throw new Error('inflate: truncated stored block');
      ensure(len); out.set(src.subarray(pos, pos + len), outLen); outLen += len; pos += len;
      continue;
    }
    let lit, dist;
    if (type === 1) { fixedTables(); lit = FIXED_LIT; dist = FIXED_DIST; }
    else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[CL_ORDER[i]] = bits(3);
      const clt = buildTable(cl);
      const lengths = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(clt);
        if (sym < 16) lengths[i++] = sym;
        else {
          let rep = 0, val = 0;
          if (sym === 16) { if (i === 0) throw new Error('inflate: repeat with no previous length'); val = lengths[i - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > nlen + ndist) throw new Error('inflate: too many lengths');
          while (rep--) lengths[i++] = val;
        }
      }
      lit = buildTable(lengths.subarray(0, nlen)); dist = buildTable(lengths.subarray(nlen));
    } else throw new Error('inflate: invalid block type');
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { ensure(1); out[outLen++] = sym; continue; }
      if (sym === 256) break;
      const li = sym - 257; if (li >= 29) throw new Error('inflate: bad length symbol');
      const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
      const di = decode(dist); if (di >= 30) throw new Error('inflate: bad distance symbol');
      const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
      if (d > outLen) throw new Error('inflate: distance too far back');
      ensure(len);
      for (let k = 0; k < len; k++) { out[outLen] = out[outLen - d]; outLen++; }
    }
  } while (!last);
  return out.subarray(0, outLen);
}

/** No encoder in the browser: the ZIP writer stores entries uncompressed when this returns null. */
export const deflateRaw = () => null;
