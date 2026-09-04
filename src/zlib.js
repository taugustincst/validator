// DEFLATE for the Node build: node:zlib. The browser build swaps this module for zlib-browser.js
// (a plain-JavaScript decoder, and no encoder — entries are then written uncompressed).
import zlib from 'node:zlib';
export const inflateRaw = data => zlib.inflateRawSync(data);
export const deflateRaw = data => zlib.deflateRawSync(data, { level: 6 });
