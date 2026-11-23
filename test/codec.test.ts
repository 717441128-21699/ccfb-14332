import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RansEncoder,
  RansDecoder,
  RansTable,
  normalizeHist,
  PROB_SCALE,
  writeHistograms,
  readHistograms,
  tablesFromHists,
} from '../src/codec/rans.js';
import { BitRangeEncoder, BitRangeDecoder } from '../src/codec/bitcoder.js';
import { ByteWriter, ByteReader } from '../src/codec/bits.js';
import { residualToSym, symToResidual, medPredict } from '../src/codec/predict.js';
import { labelComponents, extractBitmap } from '../src/codec/components.js';
import { buildGlyphModel } from '../src/codec/cluster.js';
import { encodeImage, decodeImage } from '../src/codec/container.js';
import { generateRubbing, mulberry32 } from '../src/gen/rubbing.js';

test('normalizeHist sums to scale and keeps present symbols nonzero', () => {
  const rand = mulberry32(42);
  for (let trial = 0; trial < 200; trial++) {
    const hist = new Uint32Array(512);
    const n = 1 + Math.floor(rand() * 300);
    for (let i = 0; i < n; i++) hist[Math.floor(rand() * 512)] = 1 + Math.floor(rand() * 10000);
    const f = normalizeHist(hist);
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += f[i];
      if (hist[i] > 0) assert.ok(f[i] > 0, `symbol ${i} lost`);
    }
    assert.equal(sum, PROB_SCALE);
  }
});

test('rANS round trip with random histograms', () => {
  const rand = mulberry32(7);
  for (let trial = 0; trial < 50; trial++) {
    const hist = new Uint32Array(512);
    const nSym = 1 + Math.floor(rand() * 200);
    for (let i = 0; i < nSym; i++) hist[Math.floor(rand() * 512)] += 1 + Math.floor(rand() * 1000);
    const table = new RansTable(normalizeHist(hist));
    const n = 1 + Math.floor(rand() * 5000);
    const syms: number[] = [];
    for (let i = 0; i < n; i++) {
      // pick a symbol with nonzero freq
      let s = Math.floor(rand() * 512);
      while (hist[s] === 0) s = Math.floor(rand() * 512);
      syms.push(s);
    }
    const enc = new RansEncoder();
    for (let i = n - 1; i >= 0; i--) enc.put(table.freq[syms[i]], table.cum[syms[i]]);
    const stream = enc.finish();
    const dec = new RansDecoder(stream, 0);
    for (let i = 0; i < n; i++) {
      assert.equal(dec.decode(table), syms[i], `trial ${trial} symbol ${i}`);
    }
  }
});

test('histogram serialization round trip', () => {
  const rand = mulberry32(3);
  const hists: Uint32Array[] = [];
  for (let c = 0; c < 8; c++) {
    const h = new Uint32Array(512);
    for (let i = 0; i < 100; i++) h[Math.floor(rand() * 512)] = 1 + Math.floor(rand() * 500);
    hists.push(h);
  }
  const w = new ByteWriter();
  writeHistograms(w, hists);
  const r = new ByteReader(w.finish());
  const back = readHistograms(r);
  assert.equal(back.length, 8);
  for (let c = 0; c < 8; c++) assert.deepEqual([...back[c]], [...hists[c]]);
});

test('binary range coder round trip', () => {
  const rand = mulberry32(11);
  const enc = new BitRangeEncoder(8);
  const bits: { m: number; b: number }[] = [];
  for (let i = 0; i < 20000; i++) {
    const m = Math.floor(rand() * 8);
    const b = rand() < 0.2 ? 1 : 0;
    bits.push({ m, b });
    enc.encodeBit(m, b);
  }
  const stream = enc.finish();
  const dec = new BitRangeDecoder(stream, 0, 8);
  for (let i = 0; i < bits.length; i++) {
    assert.equal(dec.decodeBit(bits[i].m), bits[i].b, `bit ${i}`);
  }
});

test('residual mapping round trip', () => {
  for (let r = -255; r <= 255; r++) {
    assert.equal(symToResidual(residualToSym(r)), r);
  }
});

test('MED predictor edge cases', () => {
  assert.equal(medPredict(10, 20, 5), 20); // c <= min -> max(a,b)
  assert.equal(medPredict(10, 20, 30), 10); // c >= max -> min(a,b)
  assert.equal(medPredict(10, 20, 15), 15); // a+b-c
});

test('connected components: 8-connectivity and bboxes', () => {
  // 8x8 mask: two diagonal-touching pixels (one comp), one separate pixel
  const w = 8;
  const h = 8;
  const mask = new Uint8Array(w * h);
  mask[1 * 8 + 1] = 1;
  mask[2 * 8 + 2] = 1; // diagonal to first -> same component
  mask[5 * 8 + 6] = 1; // separate
  const { comps, labels } = labelComponents(mask, w, h);
  assert.equal(comps.length, 2);
  const big = comps.find((c) => c.area === 2)!;
  assert.equal(big.w, 2);
  assert.equal(big.h, 2);
  assert.equal(labels[1 * 8 + 1], labels[2 * 8 + 2]);
  assert.notEqual(labels[1 * 8 + 1], labels[5 * 8 + 6]);
});

test('glyph clustering groups repeated shapes', () => {
  // build a mask with the same 6x6 "L" shape stamped 5 times + 1 different shape
  const w = 120;
  const h = 20;
  const mask = new Uint8Array(w * h);
  const stampL = (ox: number) => {
    for (let y = 0; y < 6; y++) mask[(5 + y) * w + ox] = 1;
    for (let x = 0; x < 5; x++) mask[(5 + 5) * w + ox + x] = 1;
  };
  for (let i = 0; i < 5; i++) stampL(5 + i * 20);
  // different shape: filled square
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) mask[(8 + y) * w + 105 + x] = 1;
  const { comps, labels } = labelComponents(mask, w, h);
  assert.equal(comps.length, 6);
  const model = buildGlyphModel(comps, labels, w);
  assert.equal(model.entries.length, 1, 'L shapes should form one dictionary entry');
  assert.equal(model.entries[0].count, 5);
  const raw = model.instances.filter((i) => i.glyphId < 0);
  assert.equal(raw.length, 1, 'square stays raw');
});

test('container round trip is pixel-exact on synthetic rubbing', () => {
  const { img, w, h } = generateRubbing({ width: 480, height: 640, seed: 5, numGlyphs: 8 });
  const enc = encodeImage(img, w, h, 128);
  const dec = decodeImage(enc.data);
  assert.equal(dec.width, w);
  assert.equal(dec.height, h);
  assert.deepEqual(dec.img, img);
});

test('container round trip: degenerate images', () => {
  // all paper (no ink)
  const w = 300;
  const h = 200;
  const blank = new Uint8Array(w * h).fill(190);
  const enc1 = encodeImage(blank, w, h, 128);
  const dec1 = decodeImage(enc1.data);
  assert.deepEqual(dec1.img, blank);

  // gradient with a few ink dots
  const grad = new Uint8Array(w * h);
  for (let i = 0; i < grad.length; i++) grad[i] = 150 + (i % 60);
  grad[50 * w + 50] = 10;
  grad[100 * w + 200] = 20;
  const enc2 = encodeImage(grad, w, h, 128);
  const dec2 = decodeImage(enc2.data);
  assert.deepEqual(dec2.img, grad);
});

test('dictionary actually saves bytes on repeated glyphs', () => {
  // image with many identical glyphs should compress far below raw
  const { img, w, h } = generateRubbing({ width: 960, height: 1280, seed: 9, numGlyphs: 6 });
  const enc = encodeImage(img, w, h, 256);
  assert.ok(enc.stats.numGlyphs >= 3, 'expected several dictionary glyphs');
  assert.ok(enc.stats.totalBytes < img.length / 4, 'should beat 4x on synthetic data');
});
