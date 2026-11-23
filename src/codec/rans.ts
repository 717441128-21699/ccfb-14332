// rANS (range Asymmetric Numeral Systems) entropy coder, byte-renormalized.
// Chosen over a classic arithmetic coder for decode speed: each symbol decode is
// a handful of integer ops, which is what lets a 54 Mpx rubbing decode in < 3 s.
//
// Stream layout produced by RansEncoder.finish():
//   [u32 final-state][renormalization bytes in decoder-read order]
// Symbols must be encoded in REVERSE of the desired decode order.

import { ByteWriter, ByteReader } from './bits.js';

export const PROB_BITS = 12;
export const PROB_SCALE = 1 << PROB_BITS;
const RANS_L = 1 << 23; // lower bound of state; invariant x in [2^23, 2^31)

// Deterministic histogram normalization to PROB_SCALE. Both ends run this on the
// same transmitted histogram, so tables always match.
export function normalizeHist(hist: Uint32Array): Uint32Array {
  const n = hist.length;
  const freq = new Uint32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) total += hist[i];
  if (total === 0) return freq;
  const M = PROB_SCALE;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (hist[i] > 0) {
      freq[i] = Math.max(1, Math.floor((hist[i] * M) / total));
      sum += freq[i];
    }
  }
  let diff = M - sum; // |diff| <= number of nonzero symbols
  if (diff !== 0) {
    // Apply the correction to the largest entries first (deterministic: freq desc, index asc).
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
    order.sort((a, b) => freq[b] - freq[a] || a - b);
    if (diff > 0) {
      freq[order[0]] += diff;
    } else {
      let need = -diff;
      let idx = 0;
      // multiple passes if needed; each pass can free (freq[i]-1) from each entry
      while (need > 0) {
        const i = order[idx % order.length];
        if (freq[i] > 1) {
          const take = Math.min(freq[i] - 1, need);
          freq[i] -= take;
          need -= take;
        }
        idx++;
        if (idx > order.length * 64) throw new Error('normalizeHist: cannot balance');
      }
    }
  }
  return freq;
}

export class RansTable {
  freq: Uint32Array;
  cum: Uint32Array;
  slot2sym: Uint16Array;
  constructor(freq: Uint32Array) {
    this.freq = freq;
    const n = freq.length;
    this.cum = new Uint32Array(n);
    let c = 0;
    for (let i = 0; i < n; i++) {
      this.cum[i] = c;
      c += freq[i];
    }
    if (c !== PROB_SCALE) throw new Error('RansTable: freqs do not sum to scale');
    this.slot2sym = new Uint16Array(PROB_SCALE);
    for (let i = 0; i < n; i++) {
      const f = freq[i];
      if (f === 0) continue;
      this.slot2sym.fill(i, this.cum[i], this.cum[i] + f);
    }
  }
}

export class RansEncoder {
  private x = RANS_L;
  private out: number[] = [];
  // Encode one symbol given its (freq, cum). Call in reverse decode order.
  put(freq: number, cum: number) {
    const xMax = (((RANS_L >>> PROB_BITS) << 8) * freq) >>> 0;
    let x = this.x;
    while (x >= xMax) {
      this.out.push(x & 0xff);
      x >>>= 8;
    }
    // x < 2^31 here, x/freq < 2^19 so int32 ops are safe
    this.x = (((x / freq) | 0) << PROB_BITS) + (x % freq) + cum;
  }
  finish(): Uint8Array {
    const w = new ByteWriter(4 + this.out.length);
    w.u32(this.x >>> 0);
    // decoder reads renorm bytes in reverse of emission order
    for (let i = this.out.length - 1; i >= 0; i--) w.u8(this.out[i]);
    return w.finish();
  }
}

export class RansDecoder {
  private x: number;
  private pos: number;
  constructor(private buf: Uint8Array, offset = 0) {
    this.x =
      (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>>
      0;
    this.pos = offset + 4;
  }
  // Decode one symbol using the given table.
  decode(t: RansTable): number {
    const x = this.x;
    const slot = x & (PROB_SCALE - 1);
    const sym = t.slot2sym[slot];
    this.x = (t.freq[sym] * (x >>> PROB_BITS) + slot - t.cum[sym]) >>> 0;
    while (this.x < RANS_L) {
      this.x = ((this.x << 8) | this.buf[this.pos++]) >>> 0;
    }
    return sym;
  }
}

// ---- histogram (de)serialization: sparse, varint-coded ----

export function writeHistograms(w: ByteWriter, hists: Uint32Array[]) {
  w.varint(hists.length);
  for (const h of hists) {
    let nz = 0;
    for (let i = 0; i < h.length; i++) if (h[i] > 0) nz++;
    w.varint(nz);
    let prev = 0;
    for (let i = 0; i < h.length; i++) {
      if (h[i] > 0) {
        w.varint(i - prev);
        w.varint(h[i]);
        prev = i;
      }
    }
  }
}

export function readHistograms(r: ByteReader): Uint32Array[] {
  const nctx = r.varint();
  const hists: Uint32Array[] = [];
  for (let c = 0; c < nctx; c++) {
    const nz = r.varint();
    // alphabet size is fixed by caller convention; use 512 (max we use)
    const h = new Uint32Array(512);
    let sym = 0;
    for (let k = 0; k < nz; k++) {
      sym += r.varint();
      h[sym] = r.varint();
    }
    hists.push(h);
  }
  return hists;
}

export function tablesFromHists(hists: Uint32Array[]): RansTable[] {
  return hists.map((h) => {
    let total = 0;
    for (let i = 0; i < h.length; i++) total += h[i];
    if (total === 0) {
      // context never used: substitute a dummy so table construction succeeds
      h = new Uint32Array(h.length);
      h[0] = 1;
    }
    return new RansTable(normalizeHist(h));
  });
}
