// Analysis: measure residual entropy of different predictors on a generated rubbing.
import { readFileSync } from 'node:fs';
import { readPgm } from '../src/io/pgm.js';
import { otsuThreshold, computeForegroundMask, fillPaperLayer } from '../src/codec/layers.js';
import { medPredict, gapPredict, residualToSym } from '../src/codec/predict.js';

const { img, w, h } = readPgm(readFileSync(process.argv[2]));
const T = otsuThreshold(img);
const { mask } = computeForegroundMask(img, T);
const paper = fillPaperLayer(img, mask, w, h);

function entropyOf(hist: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (total === 0) return 0;
  let e = 0;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] === 0) continue;
    const p = hist[i] / total;
    e -= p * Math.log2(p);
  }
  return e;
}

const BORDER = 128;
// MED residuals, global + per-context
const medGlobal = new Uint32Array(512);
const medCtx: Uint32Array[] = Array.from({ length: 16 }, () => new Uint32Array(512));
const gapGlobal = new Uint32Array(512);
const gapCtx: Uint32Array[] = Array.from({ length: 16 }, () => new Uint32Array(512));
// raw zero-order on paper values
const rawHist = new Uint32Array(256);

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    rawHist[paper[i]]++;
    const a = x > 0 ? paper[i - 1] : BORDER;
    const b = y > 0 ? paper[i - w] : BORDER;
    const c = x > 0 && y > 0 ? paper[i - w - 1] : BORDER;
    const pm = medPredict(a, b, c);
    const sm = residualToSym(paper[i] - pm);
    medGlobal[sm]++;
    const g = Math.abs(a - c) + Math.abs(b - c);
    const gc = g < 3 ? 0 : g < 8 ? 1 : g < 16 ? 2 : g < 32 ? 3 : g < 64 ? 4 : g < 128 ? 5 : g < 192 ? 6 : 7;
    medCtx[gc][sm]++;
    medCtx[8 + ((x > 0 && mask[i - 1]) || (y > 0 && mask[i - w]) ? 1 : 0) * 0 + gc] ; // noop keep simple
    const W = a, N = b, NW = c;
    const NE = x < w - 1 && y > 0 ? paper[i - w + 1] : BORDER;
    const WW = x > 1 ? paper[i - 2] : BORDER;
    const NN = y > 1 ? paper[i - 2 * w] : BORDER;
    const NNE = x < w - 1 && y > 1 ? paper[i - 2 * w + 1] : BORDER;
    const pg = gapPredict(W, N, NW, NE, WW, NN, NNE);
    gapGlobal[residualToSym(paper[i] - pg)]++;
  }
}

const npix = w * h;
console.log(`image ${w}x${h}, ink threshold ${T}, ink px ${mask.reduce((s, v) => s + v, 0)}`);
console.log(`paper zero-order entropy:        ${entropyOf(rawHist).toFixed(3)} bpp`);
console.log(`MED residual global entropy:     ${entropyOf(medGlobal).toFixed(3)} bpp`);
let medCtxEnt = 0;
for (let c = 0; c < 8; c++) {
  let n = 0;
  for (let i = 0; i < 512; i++) n += medCtx[c][i];
  medCtxEnt += (n / npix) * entropyOf(medCtx[c]);
}
console.log(`MED residual 8-context entropy:  ${medCtxEnt.toFixed(3)} bpp`);
console.log(`GAP residual global entropy:     ${entropyOf(gapGlobal).toFixed(3)} bpp`);

// ink residuals
const inkGlobal = new Uint32Array(512);
let inkN = 0;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    inkN++;
    const hasA = x > 0 && mask[i - 1];
    const hasB = y > 0 && mask[i - w];
    const hasC = x > 0 && y > 0 && mask[i - w - 1];
    let p: number;
    if (hasA && hasB && hasC) p = medPredict(img[i - 1], img[i - w], img[i - w - 1]);
    else if (hasA || hasB) p = hasA ? img[i - 1] : img[i - w];
    else p = paper[i] >> 3;
    inkGlobal[residualToSym(img[i] - p)]++;
  }
}
console.log(`ink residual global entropy:     ${entropyOf(inkGlobal).toFixed(3)} bpp (${inkN} ink px)`);
