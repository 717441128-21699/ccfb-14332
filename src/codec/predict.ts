// MED predictor (JPEG-LS) + gradient context classification + residual mapping.

export function medPredict(a: number, b: number, c: number): number {
  // a = left, b = up, c = up-left
  if (c >= Math.max(a, b)) return Math.min(a, b);
  if (c <= Math.min(a, b)) return Math.max(a, b);
  return a + b - c;
}

// GAP (gradient-adjusted predictor, CALIC). Uses 7 neighbors; substantially
// better than MED on smooth correlated texture like stone/paper surfaces.
//   nn  nne
//   nw  n   ne
//   ww  w   ?
export function gapPredict(
  w: number,
  n: number,
  nw: number,
  ne: number,
  ww: number,
  nn: number,
  nne: number
): number {
  const dh = Math.abs(w - ww) + Math.abs(n - nw) + Math.abs(ne - n);
  const dv = Math.abs(w - nw) + Math.abs(n - nn) + Math.abs(ne - nne);
  const diff = dv - dh;
  if (diff > 80) return w;
  if (diff > 32) return (3 * w + n + 2) >> 2;
  if (diff > 8) return (w + n + ne) / 3 | 0;
  if (diff < -80) return n;
  if (diff < -32) return (3 * n + w + 2) >> 2;
  if (diff < -8) return (w + n + nw) / 3 | 0;
  return ((n + w) >> 1) + ((ne - nw) >> 2);
}

// 8 gradient-energy context classes
export const N_CONTEXTS = 8;
const GRAD_THRESHOLDS = [3, 8, 16, 32, 64, 128, 192];

export function gradContext(a: number, b: number, c: number): number {
  const g = Math.abs(a - c) + Math.abs(b - c);
  for (let i = 0; i < GRAD_THRESHOLDS.length; i++) {
    if (g < GRAD_THRESHOLDS[i]) return i;
  }
  return GRAD_THRESHOLDS.length;
}

// gradient energy from the GAP neighborhood (for context classification)
export function gapGradContext(
  w: number,
  n: number,
  nw: number,
  ne: number,
  ww: number,
  nn: number,
  nne: number
): number {
  const dh = Math.abs(w - ww) + Math.abs(n - nw) + Math.abs(ne - n);
  const dv = Math.abs(w - nw) + Math.abs(n - nn) + Math.abs(ne - nne);
  const g = dh + dv;
  for (let i = 0; i < GRAD_THRESHOLDS.length; i++) {
    if (g < GRAD_THRESHOLDS[i] * 2) return i;
  }
  return GRAD_THRESHOLDS.length;
}

// residual in [-255, 255] -> symbol in [0, 510]
export function residualToSym(r: number): number {
  return r >= 0 ? 2 * r : -2 * r - 1;
}

export function symToResidual(s: number): number {
  return s & 1 ? -((s + 1) >> 1) : s >> 1;
}
