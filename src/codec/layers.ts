// Ink/paper layer separation.
//
// Losslessness argument: the paper layer replaces ink pixels with a
// *deterministic* filled value; the true ink gray values are stored separately
// in the ink stream. Decoding writes paper everywhere, then overwrites mask
// pixels with their stored ink values, so every pixel round-trips exactly.

export function otsuThreshold(img: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.length; i++) hist[img[i]]++;
  const total = img.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  // clamp to a sane band so degenerate images don't produce absurd splits
  return Math.max(40, Math.min(210, bestT));
}

export function buildInkMask(img: Uint8Array, threshold: number): Uint8Array {
  const mask = new Uint8Array(img.length);
  for (let i = 0; i < img.length; i++) {
    if (img[i] < threshold) mask[i] = 1;
  }
  return mask;
}

// Foreground = the minority class (the glyphs), regardless of polarity:
// 陽文 rubbings are dark glyphs on light paper; 陰文 rubbings (the common
// case) are paper-colored glyphs on a dark ink field. Returns the foreground
// mask plus whether the dark class is the foreground.
export function computeForegroundMask(
  img: Uint8Array,
  threshold: number
): { mask: Uint8Array; darkIsForeground: boolean } {
  const mask = new Uint8Array(img.length);
  let dark = 0;
  for (let i = 0; i < img.length; i++) {
    if (img[i] < threshold) {
      mask[i] = 1;
      dark++;
    }
  }
  const darkIsForeground = dark * 2 <= img.length;
  if (!darkIsForeground) {
    // invert: light pixels (characters on a dark field) become the foreground
    for (let i = 0; i < img.length; i++) mask[i] ^= 1;
  }
  return { mask, darkIsForeground };
}

// Deterministic diffusion fill: ink pixels get a value propagated from nearby
// paper pixels. Two chamfer sweeps (forward then backward), averaging the
// propagated candidates. Runs identically at encode and decode (decode simply
// decodes the filled layer, so this runs only at encode time).
export function fillPaperLayer(img: Uint8Array, mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(img.length);
  out.set(img);
  // forward sweep: propagate from left / up
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      let sum = 0;
      let n = 0;
      if (x > 0) {
        sum += out[i - 1];
        n++;
      }
      if (y > 0) {
        sum += out[i - w];
        n++;
      }
      out[i] = n > 0 ? (sum / n) | 0 : 200;
    }
  }
  // backward sweep: blend with right / down propagated values
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      if (!mask[i]) continue;
      let sum = out[i] * 2;
      let n = 2;
      if (x < w - 1) {
        sum += out[i + 1];
        n++;
      }
      if (y < h - 1) {
        sum += out[i + w];
        n++;
      }
      out[i] = (sum / n) | 0;
    }
  }
  return out;
}
