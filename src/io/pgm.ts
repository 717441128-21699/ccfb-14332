// PGM (P5) grayscale image IO — interchange format for the CLI.

import { ByteWriter } from '../codec/bits.js';

export function writePgm(img: Uint8Array, w: number, h: number): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
  const out = new Uint8Array(header.length + img.length);
  out.set(header, 0);
  out.set(img, header.length);
  return out;
}

export function readPgm(buf: Uint8Array): { img: Uint8Array; w: number; h: number } {
  // tokenizer: skip whitespace and # comments
  let pos = 0;
  const nextToken = (): string => {
    for (;;) {
      while (pos < buf.length && (buf[pos] === 32 || buf[pos] === 9 || buf[pos] === 10 || buf[pos] === 13)) pos++;
      if (buf[pos] === 35) {
        while (pos < buf.length && buf[pos] !== 10) pos++;
        continue;
      }
      break;
    }
    let s = '';
    while (pos < buf.length && buf[pos] > 32) s += String.fromCharCode(buf[pos++]);
    return s;
  };
  const magic = nextToken();
  if (magic !== 'P5') throw new Error('not a P5 PGM');
  const w = parseInt(nextToken(), 10);
  const h = parseInt(nextToken(), 10);
  const maxval = parseInt(nextToken(), 10);
  if (maxval !== 255) throw new Error('only 8-bit PGM supported');
  pos++; // single whitespace after maxval
  if (buf.length < pos + w * h) throw new Error('PGM truncated');
  return { img: buf.slice(pos, pos + w * h), w, h };
}
