// Connected-component labeling of the ink mask, run-length based (8-connectivity).
// Much faster than per-pixel flood fill on 54 Mpx images.

export interface Component {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

interface Run {
  x0: number; // inclusive
  x1: number; // exclusive
  y: number;
}

export function labelComponents(
  mask: Uint8Array,
  w: number,
  h: number
): { comps: Component[]; labels: Int32Array } {
  const runs: Run[] = [];
  let prevRowStart = 0;
  let prevRowY = -1;

  const parent: number[] = [];
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const p = parent[i];
      parent[i] = r;
      i = p;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    const curRowStart = runs.length;
    let x = 0;
    while (x < w) {
      if (mask[rowOff + x] === 0) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < w && mask[rowOff + x] !== 0) x++;
      const x1 = x;
      const id = runs.length;
      runs.push({ x0, x1, y });
      parent.push(id);
      // 8-connectivity with previous row: intervals [x0-1, x1] and
      // [pr.x0, pr.x1 - 1] intersect  <=>  pr.x0 <= x1 && pr.x1 >= x0
      if (prevRowY === y - 1) {
        for (let j = prevRowStart; j < curRowStart; j++) {
          const pr = runs[j];
          if (pr.x1 < x0) continue;
          if (pr.x0 > x1) break; // runs are x-sorted within a row
          union(id, j);
        }
      }
    }
    prevRowStart = curRowStart;
    prevRowY = y;
  }

  // group runs by root, accumulate bbox extents
  const rootToComp = new Map<number, number>();
  const minX: number[] = [];
  const minY: number[] = [];
  const maxX: number[] = [];
  const maxY: number[] = [];
  const area: number[] = [];
  const runComp = new Int32Array(runs.length);
  for (let i = 0; i < runs.length; i++) {
    const r = find(i);
    let ci = rootToComp.get(r);
    if (ci === undefined) {
      ci = minX.length;
      rootToComp.set(r, ci);
      minX.push(runs[i].x0);
      minY.push(runs[i].y);
      maxX.push(runs[i].x1);
      maxY.push(runs[i].y + 1);
      area.push(0);
    }
    runComp[i] = ci;
    if (runs[i].x0 < minX[ci]) minX[ci] = runs[i].x0;
    if (runs[i].y < minY[ci]) minY[ci] = runs[i].y;
    if (runs[i].x1 > maxX[ci]) maxX[ci] = runs[i].x1;
    if (runs[i].y + 1 > maxY[ci]) maxY[ci] = runs[i].y + 1;
    area[ci] += runs[i].x1 - runs[i].x0;
  }

  const comps: Component[] = [];
  for (let i = 0; i < minX.length; i++) {
    comps.push({
      id: i,
      x: minX[i],
      y: minY[i],
      w: maxX[i] - minX[i],
      h: maxY[i] - minY[i],
      area: area[i],
    });
  }

  // second pass: per-pixel labels
  const labels = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const ci = runComp[i];
    const off = r.y * w;
    for (let x = r.x0; x < r.x1; x++) labels[off + x] = ci;
  }

  return { comps, labels };
}

// Extract a component's bitmap (row-major, 0/1) over its bounding box.
export function extractBitmap(
  labels: Int32Array,
  w: number,
  comp: Component
): Uint8Array {
  const bits = new Uint8Array(comp.w * comp.h);
  for (let y = 0; y < comp.h; y++) {
    const srcOff = (comp.y + y) * w + comp.x;
    const dstOff = y * comp.w;
    for (let x = 0; x < comp.w; x++) {
      if (labels[srcOff + x] === comp.id) bits[dstOff + x] = 1;
    }
  }
  return bits;
}
