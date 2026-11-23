// Minimal PNG encoder (8-bit grayscale) used to benchmark our ratio against PNG.
// Uses per-row filter selection (sum-of-absolute-differences heuristic) and
// maximum deflate compression so PNG gets a fair fight.

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcBuf = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(crcBuf));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function writePng(img: Uint8Array, w: number, h: number): Uint8Array {
  // filtered scanlines, each prefixed with filter-type byte
  const raw = new Uint8Array(h * (w + 1));
  const prevRow = new Uint8Array(w);
  const curRow = new Uint8Array(w);
  const cand = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) curRow[x] = img[y * w + x];
    let bestType = 0;
    let bestScore = Infinity;
    let bestRow: Uint8Array = curRow;
    // try filters 0..4
    for (let f = 0; f <= 4; f++) {
      let score = 0;
      for (let x = 0; x < w; x++) {
        const a = x > 0 ? curRow[x - 1] : 0;
        const b = prevRow[x];
        const c = x > 0 ? prevRow[x - 1] : 0;
        let v: number;
        switch (f) {
          case 0: v = curRow[x]; break;
          case 1: v = curRow[x] - a; break;
          case 2: v = curRow[x] - b; break;
          case 3: v = curRow[x] - ((a + b) >> 1); break;
          default: v = curRow[x] - paeth(a, b, c); break;
        }
        v &= 0xff;
        cand[x] = v;
        // signed-byte magnitude heuristic
        const s = v < 128 ? v : 256 - v;
        score += s;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = f;
        bestRow = cand.slice();
      }
    }
    const off = y * (w + 1);
    raw[off] = bestType;
    raw.set(bestRow, off + 1);
    prevRow.set(curRow);
  }

  const compressed = deflateSync(raw, { level: 9 });

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
