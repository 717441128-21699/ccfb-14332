// Adaptive binary range coder (LZMA-style) used for sparse bitmap data
// (glyph dictionary masks and per-instance XOR deltas). These streams are
// small, so the per-bit cost is fine; the adaptive model gets excellent
// compression on edge-correlated deltas.

const TOP = 1 << 24;
const PROB_BITS = 11;
const PROB_INIT = 1 << (PROB_BITS - 1); // 1024
const PROB_MAX = 1 << PROB_BITS; // 2048
const ADAPT_SHIFT = 5;

export class BitRangeEncoder {
  private low = 0; // may exceed 2^32 between shiftLow calls; kept as exact double
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private out: number[] = [];
  private probs: Uint16Array;

  constructor(nModels: number) {
    this.probs = new Uint16Array(nModels).fill(PROB_INIT);
  }

  encodeBit(model: number, bit: number) {
    const prob = this.probs[model];
    const bound = (this.range >>> PROB_BITS) * prob;
    if (bit === 0) {
      this.range = bound;
      this.probs[model] = prob + ((PROB_MAX - prob) >> ADAPT_SHIFT);
    } else {
      this.low += bound;
      this.range -= bound;
      this.probs[model] = prob - (prob >> ADAPT_SHIFT);
    }
    while (this.range < TOP) {
      this.shiftLow();
      this.range = (this.range << 8) >>> 0;
    }
  }

  private shiftLow() {
    const carry = this.low >= 0x100000000 ? 1 : 0;
    if (this.low < 0xff000000 || carry !== 0) {
      let temp = this.cache;
      do {
        this.out.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / 0x1000000) % 256;
    }
    this.cacheSize++;
    this.low = (this.low * 256) % 0x100000000; // (UInt32)(low << 8)
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return Uint8Array.from(this.out);
  }
}

export class BitRangeDecoder {
  private code = 0;
  private range = 0xffffffff;
  private pos: number;
  private probs: Uint16Array;

  constructor(private buf: Uint8Array, offset: number, nModels: number) {
    this.probs = new Uint16Array(nModels).fill(PROB_INIT);
    this.pos = offset;
    for (let i = 0; i < 5; i++) {
      this.code = (this.code * 256 + (this.buf[this.pos++] ?? 0)) % 0x100000000;
    }
  }

  decodeBit(model: number): number {
    const prob = this.probs[model];
    const bound = (this.range >>> PROB_BITS) * prob;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      this.probs[model] = prob + ((PROB_MAX - prob) >> ADAPT_SHIFT);
      bit = 0;
    } else {
      this.code -= bound;
      this.range -= bound;
      this.probs[model] = prob - (prob >> ADAPT_SHIFT);
      bit = 1;
    }
    while (this.range < TOP) {
      this.code = (this.code * 256 + (this.buf[this.pos++] ?? 0)) % 0x100000000;
      this.range = (this.range << 8) >>> 0;
    }
    return bit;
  }
}
