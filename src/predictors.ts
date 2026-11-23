// Predictor shootout: residual entropy of candidate predictors on the field layer.
import { readFileSync } from 'node:fs';
import { readPgm } from '../src/io/pgm.js';
import { otsuThreshold, computeForegroundMask, fillPaperLayer } from '../src/codec/layers.js';
import { medPredict, gapPredict } from '../src/codec/predict.js';

const { img, w, h } = readPgm(readFileSync(process.argv[2]));
const T = otsuThreshold(img);
const { mask } = computeForegroundMask(img, T);
const paper = fillPaperLayer(img, mask, w, h);

function makeEnt() {
  return { hist: new Uint32Array(1024), n: 0 };
}
function add(e: { hist: Uint32Array; n: number }, r: number) {
  e.hist[Math.max(0, Math.min(1023, r + 512))]++;
  e.n++;
}
function ent(e: { hist: Uint32Array; n: number }): number {
  let s = 0;
  for (let i = 0; i < 1024; i++) {
    if (e.hist[i] === 0) continue;
    const p = e.hist[i] / e.n;
    s -= p * Math.log2(p);
  }
  return s;
}

const preds: Record<string, { hist: Uint32Array; n: number }> = {
  med: makeEnt(),
  gap: makeEnt(),
  avg2: makeEnt(), // (a+b)/2
  avg4: makeEnt(), // (a+b+c+ne)/4
  fir: makeEnt(), // (5a+5b-2c+... )/8
  fir2: makeEnt(), // (4a+4b-2c+2ne)/8
  paeth: makeEnt(),
};
const BORDER = 128;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const v = paper[i];
    const a = x > 0 ? paper[i - 1] : BORDER;
    const b = y > 0 ? paper[i - w] : BORDER;
    const c = x > 0 && y > 0 ? paper[i - w - 1] : BORDER;
    const d = x < w - 1 && y > 0 ? paper[i - w + 1] : BORDER;
    const e2 = x > 1 ? paper[i - 2] : BORDER;
    const f = y > 1 ? paper[i - 2 * w] : BORDER;
    add(preds.med, v - medPredict(a, b, c));
    add(preds.gap, v - gapPredict(a, b, c, d, e2, f, y > 1 && x < w - 1 ? paper[i - 2 * w + 1] : BORDER));
    add(preds.avg2, v - ((a + b) >> 1));
    add(preds.avg4, v - ((a + b + c + d) >> 2));
    add(preds.fir, v - ((5 * a + 5 * b - 2 * c + 4) >> 3));
    add(preds.fir2, v - ((4 * a + 4 * b - 2 * c + 2 * d + 4) >> 3));
    add(preds.paeth, v - paeth(a, b, c));
  }
}
for (const [name, e] of Object.entries(preds)) {
  console.log(`${name.padEnd(6)} ${ent(e).toFixed(3)} bpp`);
}
