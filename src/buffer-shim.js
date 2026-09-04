// The slice of Node's Buffer the spreadsheet code uses, for the browser build: a Uint8Array with
// little-endian integer reads/writes, utf8/base64 conversion, alloc/concat/from/isBuffer.
const enc = new TextEncoder(), dec = new TextDecoder('utf-8');
export class Buffer extends Uint8Array {
  static from(v, encoding) {
    if (typeof v === 'string') {
      if (encoding === 'base64') { const bin = atob(v.replace(/[^A-Za-z0-9+/=]/g, '')); const b = new Buffer(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
      const u = enc.encode(v); const b = new Buffer(u.length); b.set(u); return b;
    }
    if (v instanceof ArrayBuffer) return new Buffer(v);
    if (ArrayBuffer.isView(v)) return new Buffer(v.buffer, v.byteOffset, v.byteLength);
    const b = new Buffer(v.length); for (let i = 0; i < v.length; i++) b[i] = v[i]; return b;
  }
  static alloc(n) { return new Buffer(n); }
  static isBuffer(v) { return v instanceof Buffer; }
  static concat(list) { const n = list.reduce((a, b) => a + b.length, 0); const out = new Buffer(n); let o = 0; for (const b of list) { out.set(b, o); o += b.length; } return out; }
  subarray(s, e) { const u = super.subarray(s, e); return new Buffer(u.buffer, u.byteOffset, u.byteLength); }
  slice(s, e) { return Buffer.from(super.slice(s, e)); }
  readUInt8(o) { return this[o]; }
  readUInt16LE(o) { return this[o] | (this[o + 1] << 8); }
  readUInt32LE(o) { return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000; }
  writeUInt8(v, o) { this[o] = v & 0xff; return o + 1; }
  writeUInt16LE(v, o) { this[o] = v & 0xff; this[o + 1] = (v >>> 8) & 0xff; return o + 2; }
  writeUInt32LE(v, o) { this[o] = v & 0xff; this[o + 1] = (v >>> 8) & 0xff; this[o + 2] = (v >>> 16) & 0xff; this[o + 3] = (v >>> 24) & 0xff; return o + 4; }
  toString(encoding = 'utf8', s = 0, e = this.length) {
    const part = super.subarray(s, e);
    if (encoding === 'base64') { let bin = ''; for (let i = 0; i < part.length; i += 0x8000) bin += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000)); return btoa(bin); }
    return dec.decode(part);
  }
}
