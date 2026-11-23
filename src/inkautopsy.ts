// Ink-stream autopsy: where does the foreground-value entropy live?
import { readFileSync } from 'node:fs';
import { readPgm } from '../src/io/pgm.js';
import { otsuThreshold, computeForegroundMask, fillPaperLayer } from '../src/codec/layers.js';
import { medPredict, residualToSym } from '../src/codec/predict.js';

const { img, w, h } = readPgm(readFileSync(process.argv[2]));
const T = otsuThreshold(img);
const { mask } = computeForegroundMask(img, T);

function ent(hist: Uint32Array, n: number): number {
  let s = 0;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] === 0) continue;
    const p = hist[i] / n;
    s -= p * Math.log2(p);
  }
  return s;
}

const zeroOrder = new Uint32Array(256);
const interior = new Uint32Array(1024); // all 4 neighbors ink, MED pred
const edge = new Uint32Array(1024); // some neighbors ink
const start = new Uint32Array(1024); // no neighbors
let nInt = 0, nEdge = 0, nStart = 0, nInk = 0;

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    nInk++;
    zeroOrder[img[i]]++;
    const hasA = x > 0 && mask[i - 1];
    const hasB = y > 0 && mask[i - w];
    const hasC = x > 0 && y > 0 && mask[i - w - 1];
    const hasD = x < w - 1 && y > 0 && mask[i - w + 1];
    if (hasA && hasB && hasC && hasD) {
      const p = medPredict(img[i - 1], img[i - w], img[i - w - 1]);
      interior[residualToSym(img[i] - p)]++;
      nInt++;
    } else if (hasA || hasB) {
      const p = hasA ? img[i - 1] : img[i - w];
      edge[residualToSym(img[i] - p)]++;
      nEdge++;
    } else {
      start[residualToSym(img[i] - 128)]++;
      nStart++;
    }
  }
}
console.log(`ink px: ${nInk}  interior ${nInt} edge ${nEdge} start ${nStart}`);
console.log(`zero-order:        ${ent(zeroOrder, nInk).toFixed(3)} bpp`);
console.log(`interior residual: ${ent(interior, nInt).toFixed(3)} bpp`);
console.log(`edge residual:     ${ent(edge, nEdge).toFixed(3)} bpp`);
console.log(`start residual:    ${ent(start, nStart).toFixed(3)} bpp`);
const total =
  (ent(interior, nInt) * nInt + ent(edge, nEdge) * nEdge + ent(start, nStart) * nStart) / nInk;
console.log(`weighted total:    ${total.toFixed(3)} bpp`);
