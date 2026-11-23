// Byte-level IO helpers: growable writer, reader, varint (LEB128), zigzag.

export class ByteWriter {
  buf: Uint8Array;
  len = 0;
  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity);
  }
  private ensure(n: number) {
    if (this.len + n > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < this.len + n) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  u16(v: number) {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
  }
  u32(v: number) {
    this.ensure(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  varint(v: number) {
    // unsigned LEB128 (v must be < 2^31)
    v = v >>> 0;
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.u8(v);
  }
  svarint(v: number) {
    // zigzag
    this.varint(((v << 1) ^ (v >> 31)) >>> 0);
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  pos = 0;
  constructor(public buf: Uint8Array, offset = 0, public end = buf.length) {
    this.pos = offset;
  }
  u8(): number {
    if (this.pos >= this.end) throw new Error('ByteReader: EOF');
    return this.buf[this.pos++];
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.end) throw new Error('ByteReader: EOF');
    const r = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return r;
  }
  varint(): number {
    let v = 0, shift = 0;
    for (;;) {
      const b = this.u8();
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 31) throw new Error('varint too long');
    }
    return v >>> 0;
  }
  svarint(): number {
    const v = this.varint();
    return (v >>> 1) ^ -(v & 1);
  }
  get remaining() {
    return this.end - this.pos;
  }
}
