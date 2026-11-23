// .rub container format.
//
// Layout:
//   magic "RUB1" u32 | version u32 | width u32 | height u32 | tileSize u32
//   varint dictMetaLen  | dictMeta   (varint count; per entry: varint w, h, svarint dictOffX/Y unused)
//   varint dictBitsLen  | dictBits   (bit-range-coded dictionary bitmaps)
//   varint instMetaLen  | instMeta   (varint count; per instance: glyphId+1, duy, dux, uw, uh, dictOffX, dictOffY)
//   varint instBitsLen  | instBits   (bit-range-coded XOR deltas, concatenated)
//   per tile (raster order): varint paperLen | paperStream | varint inkLen | inkStream
//     paperStream = histograms + rANS bytes; inkStream likewise.
//
// Tiles are independently decodable given the dictionary and instances, which
// enables parallel and progressive decoding.

import { ByteWriter, ByteReader } from './bits.js';
import {
  RansEncoder,
  RansDecoder,
  RansTable,
  normalizeHist,
  writeHistograms,
  readHistograms,
  tablesFromHists,
} from './rans.js';
import { BitRangeEncoder, BitRangeDecoder } from './bitcoder.js';
import {
  medPredict,
  gradContext,
  gapPredict,
  gapGradContext,
  residualToSym,
  symToResidual,
} from './predict.js';
import { otsuThreshold, computeForegroundMask, fillPaperLayer } from './layers.js';
import { labelComponents } from './components.js';
import { buildGlyphModel, GlyphModel, GlyphEntry, InstanceInfo } from './cluster.js';

export const FORMAT_VERSION = 1;
export const MAGIC = 0x31425552; // "RUB1"
export const DEFAULT_TILE = 512;
const BORDER = 128; // predictor fill value at tile borders
// paper contexts: 8 gradient classes x 2 (near-ink flag) x 2 (brightness band)
const PAPER_CONTEXTS = 32;
// ink contexts: 8 gradient (all-ink neighbors) + partial + region-start
const INK_CONTEXTS = 10;

export interface EncodeStats {
  width: number;
  height: number;
  threshold: number;
  numComponents: number;
  numGlyphs: number;
  numRawInstances: number;
  dictBytes: number;
  instBytes: number;
  tableBytes: number;
  paperBytes: number;
  inkBytes: number;
  totalBytes: number;
  encodeMs: number;
}

export interface EncodeResult {
  data: Uint8Array;
  stats: EncodeStats;
  model: GlyphModel;
}

// ---- bitmap <-> bit-range-stream helpers ----
// Context for delta bits: (baseBit << 2) | (upDelta << 1) | leftDelta  => 8 models
// Context for dict bits:  (up << 2) | (left << 1) | upLeft, plus base=0 => 8 models

function encodeBits(
  enc: BitRangeEncoder,
  delta: Uint8Array,
  base: ((vx: number, vy: number) => number) | null,
  w: number,
  h: number
) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const up = y > 0 ? delta[row - w + x] : 0;
      const left = x > 0 ? delta[row + x - 1] : 0;
      const b = base ? base(x, y) : 0;
      enc.encodeBit((b << 2) | (up << 1) | left, delta[row + x]);
    }
  }
}

function decodeBits(
  dec: BitRangeDecoder,
  base: ((vx: number, vy: number) => number) | null,
  w: number,
  h: number
): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const up = y > 0 ? out[row - w + x] : 0;
      const left = x > 0 ? out[row + x - 1] : 0;
      const b = base ? base(x, y) : 0;
      out[row + x] = dec.decodeBit((b << 2) | (up << 1) | left);
    }
  }
  return out;
}

// ---- encode ----

export function encodeImage(
  img: Uint8Array,
  w: number,
  h: number,
  tileSize: number = DEFAULT_TILE
): EncodeResult {
  const t0 = Date.now();
  if (img.length !== w * h) throw new Error('image size mismatch');

  const threshold = otsuThreshold(img);
  // foreground = glyph pixels (minority class, either polarity)
  const { mask, darkIsForeground } = computeForegroundMask(img, threshold);
  const paper = fillPaperLayer(img, mask, w, h);
  const { comps, labels } = labelComponents(mask, w, h);
  const model = buildGlyphModel(comps, labels, w);

  // Per-instance mean foreground value (墨色浓淡 per glyph). The ink stream
  // codes deviations from the instance mean, so per-glyph density shifts cost
  // one varint instead of inflating every residual.
  const compSum = new Uint32Array(comps.length);
  const compCnt = new Uint32Array(comps.length);
  for (let i = 0; i < img.length; i++) {
    const l = labels[i];
    if (l >= 0) {
      compSum[l] += img[i];
      compCnt[l]++;
    }
  }
  const compMean = new Uint8Array(comps.length);
  for (let k = 0; k < comps.length; k++) {
    compMean[k] = compCnt[k] > 0 ? Math.round(compSum[k] / compCnt[k]) : 0;
  }
  const instMean = new Uint8Array(model.instances.length);
  for (let k = 0; k < instMean.length; k++) instMean[k] = compMean[model.instanceComp[k]];
  const pixelMean = new Uint8Array(w * h);
  for (let i = 0; i < img.length; i++) {
    const l = labels[i];
    if (l >= 0) pixelMean[i] = compMean[l];
  }

  // -- dictionary --
  const dictMeta = new ByteWriter();
  dictMeta.varint(model.entries.length);
  for (const e of model.entries) {
    dictMeta.varint(e.w);
    dictMeta.varint(e.h);
  }
  const dictBitEnc = new BitRangeEncoder(8);
  for (const e of model.entries) encodeBits(dictBitEnc, e.bits, null, e.w, e.h);
  const dictBits = dictBitEnc.finish();

  // -- instances --
  const instMeta = new ByteWriter();
  instMeta.varint(model.instances.length);
  let prevUx = 0;
  let prevUy = 0;
  for (let k = 0; k < model.instances.length; k++) {
    const inst = model.instances[k];
    instMeta.svarint(inst.glyphId + 1);
    instMeta.svarint(inst.uy - prevUy);
    instMeta.svarint(inst.ux - prevUx);
    prevUy = inst.uy;
    prevUx = inst.ux;
    instMeta.varint(inst.uw);
    instMeta.varint(inst.uh);
    instMeta.svarint(inst.dictOffX);
    instMeta.svarint(inst.dictOffY);
    instMeta.varint(instMean[k]);
  }
  const instBitEnc = new BitRangeEncoder(8);
  for (const inst of model.instances) {
    const base = makeBaseFn(inst, model.entries);
    encodeBits(instBitEnc, inst.delta!, base, inst.uw, inst.uh);
  }
  const instBits = instBitEnc.finish();

  // -- tiles --
  const tilesX = Math.ceil(w / tileSize);
  const tilesY = Math.ceil(h / tileSize);
  const tileChunks: Uint8Array[] = [];
  let paperBytes = 0;
  let inkBytes = 0;

  const maxTile = tileSize * tileSize;
  const syms = new Uint16Array(maxTile);
  const ctxs = new Uint8Array(maxTile);

  // Shared global histograms, stored once in the header. Tiles remain
  // independently decodable (they all reference these tables), but we avoid
  // re-transmitting 16 sparse histograms per tile.
  const paperHists: Uint32Array[] = [];
  for (let c = 0; c < PAPER_CONTEXTS; c++) paperHists.push(new Uint32Array(512));
  const inkHists: Uint32Array[] = [];
  for (let c = 0; c < INK_CONTEXTS; c++) inkHists.push(new Uint32Array(512));

  // pass 1: statistics
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tileSize;
      const y0 = ty * tileSize;
      const tw = Math.min(tileSize, w - x0);
      const th = Math.min(tileSize, h - y0);
      for (let y = 0; y < th; y++) {
        const rowBase = (y0 + y) * w + x0;
        for (let x = 0; x < tw; x++) {
          const i = rowBase + x;
          const a = x > 0 ? paper[i - 1] : BORDER;
          const b = y > 0 ? paper[i - w] : BORDER;
          const c = x > 0 && y > 0 ? paper[i - w - 1] : BORDER;
          const p = medPredict(a, b, c);
          const nearInk = (x > 0 && mask[i - 1]) || (y > 0 && mask[i - w]) ? 1 : 0;
          const ctx = gradContext(a, b, c) + (nearInk << 3) + (p >= 128 ? 16 : 0);
          paperHists[ctx][residualToSym(paper[i] - p)]++;
          if (!mask[i]) continue;
          const hasA = x > 0 && mask[i - 1];
          const hasB = y > 0 && mask[i - w];
          const hasC = x > 0 && y > 0 && mask[i - w - 1];
          let ip: number;
          let ictx: number;
          if (hasA && hasB && hasC) {
            const da = img[i - 1] - pixelMean[i - 1];
            const db = img[i - w] - pixelMean[i - w];
            const dc = img[i - w - 1] - pixelMean[i - w - 1];
            ip = pixelMean[i] + medPredict(da, db, dc);
            ictx = gradContext(da, db, dc);
          } else if (hasA || hasB) {
            ip =
              pixelMean[i] +
              (hasA ? img[i - 1] - pixelMean[i - 1] : img[i - w] - pixelMean[i - w]);
            ictx = 8;
          } else {
            ip = pixelMean[i];
            ictx = 9;
          }
          if (ip < 0) ip = 0;
          else if (ip > 255) ip = 255;
          inkHists[ictx][residualToSym(img[i] - ip)]++;
        }
      }
    }
  }
  const paperTables = tablesFromHists(paperHists);
  const inkTables = tablesFromHists(inkHists);
  const paperHistW = new ByteWriter();
  writeHistograms(paperHistW, paperHists);
  const paperHistBuf = paperHistW.finish();
  const inkHistW = new ByteWriter();
  writeHistograms(inkHistW, inkHists);
  const inkHistBuf = inkHistW.finish();

  // pass 2: encode with the shared tables
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tileSize;
      const y0 = ty * tileSize;
      const tw = Math.min(tileSize, w - x0);
      const th = Math.min(tileSize, h - y0);
      const npix = tw * th;

      for (let y = 0; y < th; y++) {
        const rowBase = (y0 + y) * w + x0;
        for (let x = 0; x < tw; x++) {
          const i = rowBase + x;
          const a = x > 0 ? paper[i - 1] : BORDER;
          const b = y > 0 ? paper[i - w] : BORDER;
          const c = x > 0 && y > 0 ? paper[i - w - 1] : BORDER;
          const p = medPredict(a, b, c);
          const nearInk = (x > 0 && mask[i - 1]) || (y > 0 && mask[i - w]) ? 1 : 0;
          const k = y * tw + x;
          ctxs[k] = gradContext(a, b, c) + (nearInk << 3) + (p >= 128 ? 16 : 0);
          syms[k] = residualToSym(paper[i] - p);
        }
      }
      const enc = new RansEncoder();
      for (let k = npix - 1; k >= 0; k--) {
        const t = paperTables[ctxs[k]];
        const s = syms[k];
        enc.put(t.freq[s], t.cum[s]);
      }
      const paperStream = enc.finish();

      let inkCount = 0;
      for (let y = 0; y < th; y++) {
        const rowBase = (y0 + y) * w + x0;
        for (let x = 0; x < tw; x++) {
          const i = rowBase + x;
          if (!mask[i]) continue;
          const hasA = x > 0 && mask[i - 1];
          const hasB = y > 0 && mask[i - w];
          const hasC = x > 0 && y > 0 && mask[i - w - 1];
          let p: number;
          let ctx: number;
          if (hasA && hasB && hasC) {
            const da = img[i - 1] - pixelMean[i - 1];
            const db = img[i - w] - pixelMean[i - w];
            const dc = img[i - w - 1] - pixelMean[i - w - 1];
            p = pixelMean[i] + medPredict(da, db, dc);
            ctx = gradContext(da, db, dc);
          } else if (hasA || hasB) {
            p =
              pixelMean[i] +
              (hasA ? img[i - 1] - pixelMean[i - 1] : img[i - w] - pixelMean[i - w]);
            ctx = 8;
          } else {
            p = pixelMean[i];
            ctx = 9;
          }
          if (p < 0) p = 0;
          else if (p > 255) p = 255;
          syms[inkCount] = residualToSym(img[i] - p);
          ctxs[inkCount] = ctx;
          inkCount++;
        }
      }
      const inkEnc = new RansEncoder();
      for (let k = inkCount - 1; k >= 0; k--) {
        const t = inkTables[ctxs[k]];
        const s = syms[k];
        inkEnc.put(t.freq[s], t.cum[s]);
      }
      const inkStream = inkEnc.finish();

      const chunk = new ByteWriter(paperStream.length + inkStream.length + 16);
      chunk.varint(paperStream.length);
      chunk.bytes(paperStream);
      chunk.varint(inkStream.length);
      chunk.bytes(inkStream);
      tileChunks.push(chunk.finish());
      paperBytes += paperStream.length;
      inkBytes += inkStream.length;
    }
  }

  // -- assemble --
  const dictMetaBuf = dictMeta.finish();
  const instMetaBuf = instMeta.finish();
  const out = new ByteWriter();
  out.u32(MAGIC);
  out.u32(FORMAT_VERSION);
  out.u32(w);
  out.u32(h);
  out.u32(tileSize);
  out.u32(darkIsForeground ? 1 : 0); // flags
  out.varint(dictMetaBuf.length);
  out.bytes(dictMetaBuf);
  out.varint(dictBits.length);
  out.bytes(dictBits);
  out.varint(instMetaBuf.length);
  out.bytes(instMetaBuf);
  out.varint(instBits.length);
  out.bytes(instBits);
  out.varint(paperHistBuf.length);
  out.bytes(paperHistBuf);
  out.varint(inkHistBuf.length);
  out.bytes(inkHistBuf);
  for (const c of tileChunks) out.bytes(c);

  const data = out.finish();
  const stats: EncodeStats = {
    width: w,
    height: h,
    threshold,
    numComponents: comps.length,
    numGlyphs: model.entries.length,
    numRawInstances: model.instances.filter((i) => i.glyphId < 0).length,
    dictBytes: dictMetaBuf.length + dictBits.length,
    instBytes: instMetaBuf.length + instBits.length,
    tableBytes: paperHistBuf.length + inkHistBuf.length,
    paperBytes,
    inkBytes,
    totalBytes: data.length,
    encodeMs: Date.now() - t0,
  };
  return { data, stats, model };
}

function makeBaseFn(
  inst: InstanceInfo,
  entries: GlyphEntry[]
): ((vx: number, vy: number) => number) | null {
  if (inst.glyphId < 0) return null;
  const e = entries[inst.glyphId];
  const ox = inst.dictOffX;
  const oy = inst.dictOffY;
  const ew = e.w;
  const eh = e.h;
  const bits = e.bits;
  return (vx, vy) => {
    const dx = vx - ox;
    const dy = vy - oy;
    if (dx < 0 || dy < 0 || dx >= ew || dy >= eh) return 0;
    return bits[dy * ew + dx];
  };
}

// ---- decode ----

export interface RubHeader {
  version: number;
  width: number;
  height: number;
  tileSize: number;
}

export interface DecodeResult {
  img: Uint8Array;
  width: number;
  height: number;
  entries: GlyphEntry[];
  instances: InstanceInfo[];
}

export interface TileCallback {
  (tileIndex: number, x0: number, y0: number, tw: number, th: number, img: Uint8Array, width: number): void;
}

export function decodeImage(
  buf: Uint8Array,
  onTile?: TileCallback,
  onlyTiles?: Set<number>
): DecodeResult {
  const r = new ByteReader(buf);
  if (r.u32() !== MAGIC) throw new Error('not a RUB file');
  const version = r.u32();
  if (version !== FORMAT_VERSION) throw new Error(`unsupported version ${version}`);
  const w = r.u32();
  const h = r.u32();
  const tileSize = r.u32();
  const flags = r.u32(); // bit 0: dark class is foreground (informational)

  // dictionary
  const dictMetaLen = r.varint();
  const dictMeta = new ByteReader(buf, r.pos, r.pos + dictMetaLen);
  r.pos += dictMetaLen;
  const numEntries = dictMeta.varint();
  const entryDims: [number, number][] = [];
  for (let i = 0; i < numEntries; i++) entryDims.push([dictMeta.varint(), dictMeta.varint()]);
  const dictBitsLen = r.varint();
  const dictDec = new BitRangeDecoder(buf, r.pos, 8);
  r.pos += dictBitsLen;
  const entries: GlyphEntry[] = [];
  for (let i = 0; i < numEntries; i++) {
    const [ew, eh] = entryDims[i];
    const bits = decodeBits(dictDec, null, ew, eh);
    entries.push({ id: i, w: ew, h: eh, bits, count: 0 });
  }

  // instances
  const instMetaLen = r.varint();
  const instMeta = new ByteReader(buf, r.pos, r.pos + instMetaLen);
  r.pos += instMetaLen;
  const numInst = instMeta.varint();
  const instBitsLen = r.varint();
  const instDec = new BitRangeDecoder(buf, r.pos, 8);
  r.pos += instBitsLen;
  const mask = new Uint8Array(w * h);
  const pixelMean = new Uint8Array(w * h);
  const instances: InstanceInfo[] = [];
  let prevUx = 0;
  let prevUy = 0;
  for (let k = 0; k < numInst; k++) {
    const glyphId = instMeta.svarint() - 1;
    const uy = prevUy + instMeta.svarint();
    const ux = prevUx + instMeta.svarint();
    prevUy = uy;
    prevUx = ux;
    const uw = instMeta.varint();
    const uh = instMeta.varint();
    const dictOffX = instMeta.svarint();
    const dictOffY = instMeta.svarint();
    const mean = instMeta.varint();
    const inst: InstanceInfo = { glyphId, ux, uy, uw, uh, dictOffX, dictOffY, delta: null as any };
    const base = makeBaseFn(inst, entries);
    const delta = decodeBits(instDec, base, uw, uh);
    instances.push(inst);
    // stamp reconstructed bitmap (base XOR delta) into the mask
    const e = glyphId >= 0 ? entries[glyphId] : null;
    for (let vy = 0; vy < uh; vy++) {
      const gy = uy + vy;
      if (gy < 0 || gy >= h) continue;
      const rowBase = gy * w;
      const dRow = vy * uw;
      for (let vx = 0; vx < uw; vx++) {
        const gx = ux + vx;
        if (gx < 0 || gx >= w) continue;
        let bit = delta[dRow + vx];
        if (e) {
          const dx = vx - dictOffX;
          const dy = vy - dictOffY;
          if (dx >= 0 && dy >= 0 && dx < e.w && dy < e.h && e.bits[dy * e.w + dx]) bit ^= 1;
        }
        if (bit) {
          mask[rowBase + gx] = 1;
          pixelMean[rowBase + gx] = mean;
        }
      }
    }
  }

  // shared histogram tables
  const paperHistLen = r.varint();
  const paperHistR = new ByteReader(buf, r.pos, r.pos + paperHistLen);
  const tables = tablesFromHists(readHistograms(paperHistR));
  r.pos += paperHistLen;
  const inkHistLen = r.varint();
  const inkHistR = new ByteReader(buf, r.pos, r.pos + inkHistLen);
  const inkTables = tablesFromHists(readHistograms(inkHistR));
  r.pos += inkHistLen;

  // tiles
  const img = new Uint8Array(w * h);
  const tilesX = Math.ceil(w / tileSize);
  const tilesY = Math.ceil(h / tileSize);
  let tileIndex = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++, tileIndex++) {
      const paperLen = r.varint();
      const paperEnd = r.pos + paperLen;
      const x0 = tx * tileSize;
      const y0 = ty * tileSize;
      const tw = Math.min(tileSize, w - x0);
      const th = Math.min(tileSize, h - y0);
      const doTile = !onlyTiles || onlyTiles.has(tileIndex);

      if (doTile) {
        const dec = new RansDecoder(buf, r.pos);
        for (let y = 0; y < th; y++) {
          const rowBase = (y0 + y) * w + x0;
          for (let x = 0; x < tw; x++) {
            const i = rowBase + x;
            const a = x > 0 ? img[i - 1] : BORDER;
            const b = y > 0 ? img[i - w] : BORDER;
            const c = x > 0 && y > 0 ? img[i - w - 1] : BORDER;
            const p = medPredict(a, b, c);
            const nearInk = (x > 0 && mask[i - 1]) || (y > 0 && mask[i - w]) ? 1 : 0;
            const ctx = gradContext(a, b, c) + (nearInk << 3) + (p >= 128 ? 16 : 0);
            const sym = dec.decode(tables[ctx]);
            img[i] = p + symToResidual(sym);
          }
        }
      }
      // ink stream follows paper stream
      const ir = new ByteReader(buf, paperEnd);
      const inkLen = ir.varint();
      const inkEnd = ir.pos + inkLen;
      if (doTile) {
        const dec = new RansDecoder(buf, ir.pos);
        for (let y = 0; y < th; y++) {
          const rowBase = (y0 + y) * w + x0;
          for (let x = 0; x < tw; x++) {
            const i = rowBase + x;
            if (!mask[i]) continue;
            const hasA = x > 0 && mask[i - 1];
            const hasB = y > 0 && mask[i - w];
            const hasC = x > 0 && y > 0 && mask[i - w - 1];
            let p: number;
            let ctx: number;
            if (hasA && hasB && hasC) {
              const da = img[i - 1] - pixelMean[i - 1];
              const db = img[i - w] - pixelMean[i - w];
              const dc = img[i - w - 1] - pixelMean[i - w - 1];
              p = pixelMean[i] + medPredict(da, db, dc);
              ctx = gradContext(da, db, dc);
            } else if (hasA || hasB) {
              p =
                pixelMean[i] +
                (hasA ? img[i - 1] - pixelMean[i - 1] : img[i - w] - pixelMean[i - w]);
              ctx = 8;
            } else {
              p = pixelMean[i];
              ctx = 9;
            }
            if (p < 0) p = 0;
            else if (p > 255) p = 255;
            const sym = dec.decode(inkTables[ctx]);
            img[i] = p + symToResidual(sym);
          }
        }
        onTile?.(tileIndex, x0, y0, tw, th, img, w);
      }
      r.pos = inkEnd;
    }
  }

  return { img, width: w, height: h, entries, instances };
}
