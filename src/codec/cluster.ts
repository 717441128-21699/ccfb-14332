// Glyph clustering: group ink connected components of similar shape into a
// dictionary. Repeated glyphs are stored once (dictionary mask) plus, per
// occurrence, a position and a sparse XOR delta bitmap.

import { Component, extractBitmap } from './components.js';

export interface GlyphEntry {
  id: number;
  w: number;
  h: number;
  bits: Uint8Array; // row-major 0/1, w*h
  count: number;
}

export interface InstanceInfo {
  glyphId: number; // -1 => raw (no dictionary reference)
  ux: number; // union-bbox origin (absolute image coords)
  uy: number;
  uw: number;
  uh: number;
  dictOffX: number; // dictionary bitmap top-left within union bbox (0 for raw)
  dictOffY: number;
  delta?: Uint8Array | null; // XOR bitmap over union bbox (encode side only)
}

const NORM = 24;
const NORM_WORDS = (NORM * NORM) / 32; // 18
const IOU_THRESHOLD = 0.78;

function normalizeBits(bits: Uint8Array, w: number, h: number): Uint32Array {
  const out = new Uint32Array(NORM_WORDS);
  for (let gy = 0; gy < NORM; gy++) {
    const sy = Math.min(h - 1, Math.floor(((gy + 0.5) * h) / NORM));
    for (let gx = 0; gx < NORM; gx++) {
      const sx = Math.min(w - 1, Math.floor(((gx + 0.5) * w) / NORM));
      if (bits[sy * w + sx]) {
        const idx = gy * NORM + gx;
        out[idx >>> 5] |= 1 << (idx & 31);
      }
    }
  }
  return out;
}

function iou(a: Uint32Array, b: Uint32Array): number {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < NORM_WORDS; i++) {
    let x = a[i] & b[i];
    let y = a[i] | b[i];
    // popcount
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    inter += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    y = y - ((y >>> 1) & 0x55555555);
    y = (y & 0x33333333) + ((y >>> 2) & 0x33333333);
    uni += (((y + (y >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return uni === 0 ? 1 : inter / uni;
}

interface Cluster {
  repNorm: Uint32Array;
  repW: number;
  repH: number;
  members: number[]; // component indices
}

export interface GlyphModel {
  entries: GlyphEntry[];
  instances: InstanceInfo[]; // one per component, raster-sorted
  clusterSizes: number[]; // members per dictionary entry (for stats)
  instanceComp: Int32Array; // instance index -> component id
  compToInstance: Int32Array; // component id -> instance index
}

export function buildGlyphModel(
  comps: Component[],
  labels: Int32Array,
  imgW: number
): GlyphModel {
  const n = comps.length;
  const bitmaps: Uint8Array[] = new Array(n);
  const norms: Uint32Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    bitmaps[i] = extractBitmap(labels, imgW, comps[i]);
    norms[i] = normalizeBits(bitmaps[i], comps[i].w, comps[i].h);
  }

  // greedy clustering with bucket index on rounded size
  const clusters: Cluster[] = [];
  const buckets = new Map<string, number[]>();
  const compCluster = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const c = comps[i];
    const bw = c.w >> 2;
    const bh = c.h >> 2;
    let best = -1;
    let bestIou = IOU_THRESHOLD;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(`${bw + dx},${bh + dy}`);
        if (!list) continue;
        for (const ci of list) {
          const cl = clusters[ci];
          // size compatibility (normalized IoU alone is too forgiving across scales)
          if (Math.abs(c.w - cl.repW) > Math.max(2, cl.repW * 0.2)) continue;
          if (Math.abs(c.h - cl.repH) > Math.max(2, cl.repH * 0.2)) continue;
          const v = iou(norms[i], cl.repNorm);
          if (v >= bestIou) {
            bestIou = v;
            best = ci;
          }
        }
      }
    }
    if (best >= 0) {
      clusters[best].members.push(i);
      compCluster[i] = best;
    } else {
      const ci = clusters.length;
      clusters.push({ repNorm: norms[i], repW: c.w, repH: c.h, members: [i] });
      compCluster[i] = ci;
      const key = `${bw},${bh}`;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(ci);
    }
  }

  // dictionary entries for clusters with >= 2 members; singletons stay raw
  const entries: GlyphEntry[] = [];
  const clusterSizes: number[] = [];
  const clusterToGlyph = new Int32Array(clusters.length).fill(-1);
  for (let ci = 0; ci < clusters.length; ci++) {
    const members = clusters[ci].members;
    if (members.length < 2) continue;
    const gid = entries.length;
    clusterToGlyph[ci] = gid;
    entries.push(buildEntry(gid, members, comps, bitmaps));
    clusterSizes.push(members.length);
  }

  // instances (sorted raster order by component position)
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => comps[a].y - comps[b].y || comps[a].x - comps[b].x);

  const instances: InstanceInfo[] = [];
  const instanceComp = new Int32Array(n);
  const compToInstance = new Int32Array(n);
  for (const i of order) {
    instanceComp[instances.length] = i;
    compToInstance[i] = instances.length;
    const c = comps[i];
    const ci = compCluster[i];
    const gid = ci >= 0 ? clusterToGlyph[ci] : -1;
    if (gid >= 0) {
      const e = entries[gid];
      const placeOffX = Math.round((c.w - e.w) / 2);
      const placeOffY = Math.round((c.h - e.h) / 2);
      const ox = Math.min(0, placeOffX);
      const oy = Math.min(0, placeOffY);
      const uw = Math.max(c.w, placeOffX + e.w) - ox;
      const uh = Math.max(c.h, placeOffY + e.h) - oy;
      const delta = new Uint8Array(uw * uh);
      // instance bits start at (-ox, -oy) in union coords; dict at (placeOff- o?)
      const instBaseX = -ox;
      const instBaseY = -oy;
      const dictBaseX = placeOffX - ox;
      const dictBaseY = placeOffY - oy;
      const cb = bitmaps[i];
      const db = e.bits;
      for (let vy = 0; vy < uh; vy++) {
        const iy = vy - instBaseY;
        const dy = vy - dictBaseY;
        const instRow = iy * c.w;
        const dictRow = dy * e.w;
        const row = vy * uw;
        const instRowOk = iy >= 0 && iy < c.h;
        const dictRowOk = dy >= 0 && dy < e.h;
        for (let vx = 0; vx < uw; vx++) {
          const ix = vx - instBaseX;
          const dx = vx - dictBaseX;
          const ib = instRowOk && ix >= 0 && ix < c.w ? cb[instRow + ix] : 0;
          const gb = dictRowOk && dx >= 0 && dx < e.w ? db[dictRow + dx] : 0;
          if (ib !== gb) delta[row + vx] = 1;
        }
      }
      instances.push({
        glyphId: gid,
        ux: c.x + ox,
        uy: c.y + oy,
        uw,
        uh,
        dictOffX: dictBaseX,
        dictOffY: dictBaseY,
        delta,
      });
    } else {
      // raw instance: delta against an empty base == the component bitmap itself
      instances.push({
        glyphId: -1,
        ux: c.x,
        uy: c.y,
        uw: c.w,
        uh: c.h,
        dictOffX: 0,
        dictOffY: 0,
        delta: bitmaps[i],
      });
    }
  }

  return { entries, instances, clusterSizes, instanceComp, compToInstance };
}

function buildEntry(
  gid: number,
  members: number[],
  comps: Component[],
  bitmaps: Uint8Array[]
): GlyphEntry {
  // canvas = median member size
  const ws = members.map((m) => comps[m].w).sort((a, b) => a - b);
  const hs = members.map((m) => comps[m].h).sort((a, b) => a - b);
  const cw = ws[ws.length >> 1];
  const ch = hs[hs.length >> 1];
  const votes = new Uint16Array(cw * ch);
  for (const m of members) {
    const c = comps[m];
    const offX = Math.round((cw - c.w) / 2);
    const offY = Math.round((ch - c.h) / 2);
    const b = bitmaps[m];
    for (let y = 0; y < c.h; y++) {
      const dy = y + offY;
      if (dy < 0 || dy >= ch) continue;
      for (let x = 0; x < c.w; x++) {
        const dx = x + offX;
        if (dx < 0 || dx >= cw) continue;
        if (b[y * c.w + x]) votes[dy * cw + dx]++;
      }
    }
  }
  const half = members.length / 2;
  const bits = new Uint8Array(cw * ch);
  let minX = cw,
    minY = ch,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (votes[y * cw + x] > half) {
        bits[y * cw + x] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    // degenerate: no majority pixels; fall back to first member's bitmap
    const c = comps[members[0]];
    return { id: gid, w: c.w, h: c.h, bits: bitmaps[members[0]], count: members.length };
  }
  // crop to bounding box
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const cropped = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      cropped[y * w + x] = bits[(y + minY) * cw + (x + minX)];
    }
  }
  return { id: gid, w, h, bits: cropped, count: members.length };
}
