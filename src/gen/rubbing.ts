// Synthetic rubbing generator for testing/benchmarking.
// Produces 8-bit grayscale images that mimic stele rubbings:
//   - procedural pseudo-glyphs (stroke-based, several calligraphic styles)
//   - traditional layout: columns top-to-bottom, right-to-left
//   - stone/paper texture: low-frequency undulation + grain + scratches
//   - ink density variation (墨色浓淡) via a low-frequency field + per-glyph jitter

export interface GenOptions {
  width?: number;
  height?: number;
  seed?: number;
  numGlyphs?: number; // distinct glyph templates in the "text"
  style?: number; // 0=regular-ish, 1=clerical-ish (flat wide), 2=seal-ish (thin curvy)
  polarity?: 'dark-field' | 'light-field'; // dark-field = 陰文 (paper glyphs on ink)
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// value noise, bilinear
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smoothstep(x - xi);
  const yf = smoothstep(y - yi);
  const v00 = hash2(xi, yi, seed);
  const v10 = hash2(xi + 1, yi, seed);
  const v01 = hash2(xi, yi + 1, seed);
  const v11 = hash2(xi + 1, yi + 1, seed);
  return v00 + (v10 - v00) * xf + (v01 - v00) * yf + (v00 - v10 - v01 + v11) * xf * yf;
}

// ---- glyph templates ----

interface Stroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number; // control point for quadratic curve
  cy: number;
  width: number;
}

const TEMPLATE_SIZE = 64;

function makeGlyph(rand: () => number, style: number): Float32Array {
  const S = TEMPLATE_SIZE;
  const strokes: Stroke[] = [];
  const nStrokes = 3 + Math.floor(rand() * 6);
  for (let s = 0; s < nStrokes; s++) {
    const kind = rand();
    let x0: number, y0: number, x1: number, y1: number;
    if (style === 1 && kind < 0.45) {
      // clerical: emphasized horizontals with "silkworm head" flare
      y0 = y1 = 8 + rand() * (S - 16);
      x0 = 6 + rand() * 14;
      x1 = S - 6 - rand() * 14;
    } else if (kind < 0.3) {
      y0 = y1 = 8 + rand() * (S - 16);
      x0 = 6 + rand() * (S * 0.4);
      x1 = S - 6 - rand() * (S * 0.4);
    } else if (kind < 0.6) {
      x0 = x1 = 8 + rand() * (S - 16);
      y0 = 6 + rand() * (S * 0.35);
      y1 = S - 6 - rand() * (S * 0.35);
    } else if (kind < 0.8) {
      // diagonal
      x0 = 8 + rand() * (S * 0.4);
      y0 = 8 + rand() * (S * 0.4);
      x1 = S - 8 - rand() * (S * 0.4);
      y1 = S - 8 - rand() * (S * 0.4);
      if (rand() < 0.5) {
        const t = x0;
        x0 = x1;
        x1 = t;
      }
    } else {
      // dot / short stroke
      x0 = 10 + rand() * (S - 20);
      y0 = 10 + rand() * (S - 20);
      x1 = x0 + (rand() - 0.5) * 14;
      y1 = y0 + (rand() - 0.5) * 14;
    }
    const curve = style === 2 ? (rand() - 0.5) * 20 : (rand() - 0.5) * 6;
    const width =
      style === 2 ? 2.2 + rand() * 1.6 : style === 1 ? 3 + rand() * 3.5 : 2.6 + rand() * 2.8;
    strokes.push({
      x0,
      y0,
      x1,
      y1,
      cx: (x0 + x1) / 2 + curve,
      cy: (y0 + y1) / 2 + curve * (rand() < 0.5 ? 1 : -1),
      width,
    });
  }
  // rasterize with soft edges
  const alpha = new Float32Array(S * S);
  for (const st of strokes) {
    const minX = Math.max(0, Math.floor(Math.min(st.x0, st.x1, st.cx) - st.width - 2));
    const maxX = Math.min(S - 1, Math.ceil(Math.max(st.x0, st.x1, st.cx) + st.width + 2));
    const minY = Math.max(0, Math.floor(Math.min(st.y0, st.y1, st.cy) - st.width - 2));
    const maxY = Math.min(S - 1, Math.ceil(Math.max(st.y0, st.y1, st.cy) + st.width + 2));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // distance to quadratic bezier (sampled)
        let best = Infinity;
        const STEPS = 16;
        for (let i = 0; i <= STEPS; i++) {
          const t = i / STEPS;
          const mt = 1 - t;
          const px = mt * mt * st.x0 + 2 * mt * t * st.cx + t * t * st.x1;
          const py = mt * mt * st.y0 + 2 * mt * t * st.cy + t * t * st.y1;
          const d = (px - x) * (px - x) + (py - y) * (py - y);
          if (d < best) best = d;
        }
        const dist = Math.sqrt(best);
        // taper: strokes thinner at the ends (brush feel)
        const a = Math.max(0, Math.min(1, (st.width - dist) / 1.6));
        const idx = y * S + x;
        if (a > alpha[idx]) alpha[idx] = a;
      }
    }
  }
  return alpha;
}

// ---- main generator ----

export function generateRubbing(opts: GenOptions = {}): { img: Uint8Array; w: number; h: number } {
  const w = opts.width ?? 6000;
  const h = opts.height ?? 9000;
  const seed = opts.seed ?? 1;
  const numGlyphs = opts.numGlyphs ?? 48;
  const style = opts.style ?? 0;
  const darkField = (opts.polarity ?? 'dark-field') === 'dark-field';
  const rand = mulberry32(seed);

  const img = new Uint8Array(w * h);

  // 1) base layer. Grain is correlated (value noise at pixel scale), like
  // real sensor noise after the scanner MTF, not iid salt noise.
  const base = darkField ? 34 + rand() * 10 : 198 + rand() * 14;
  const lowAmp = darkField ? 10 : 20;
  const midAmp = darkField ? 2 : 4;
  const grainAmp = darkField ? 0.5 : 1.0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const low = valueNoise(x / 340, y / 340, seed) - 0.5; // undulation / 墨色浓淡
      const mid = valueNoise(x / 46, y / 46, seed + 7) - 0.5;
      const grain = valueNoise(x / 2.2, y / 2.2, seed + 13) - 0.5;
      let v = base + low * lowAmp + mid * midAmp + grain * grainAmp;
      img[row + x] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
  }

  // scratches and 石花 spots
  const nScratch = Math.floor((w * h) / 4_000_000);
  for (let s = 0; s < nScratch; s++) {
    let x = rand() * w;
    let y = rand() * h;
    const ang = rand() * Math.PI * 2;
    const len = 40 + rand() * 300;
    const flip = rand() < 0.5;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    for (let i = 0; i < len; i++) {
      const px = (x + dx * i) | 0;
      const py = (y + dy * i) | 0;
      if (px < 0 || py < 0 || px >= w || py >= h) break;
      const idx = py * w + px;
      const v = img[idx] + (flip ? -14 : 12);
      img[idx] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  if (darkField) {
    // 石花: light weathering spots in the ink field
    const nSpots = Math.floor((w * h) / 2_000_000);
    for (let s = 0; s < nSpots; s++) {
      const cx = rand() * w;
      const cy = rand() * h;
      const r = 3 + rand() * 20;
      const lift = 30 + rand() * 60;
      const y0 = Math.max(0, Math.floor(cy - r));
      const y1 = Math.min(h - 1, Math.ceil(cy + r));
      const x0 = Math.max(0, Math.floor(cx - r));
      const x1 = Math.min(w - 1, Math.ceil(cx + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, y - cy) / r;
          if (d > 1) continue;
          const a = (1 - d) * (0.4 + hash2(x, y, seed + 91) * 0.6);
          const idx = y * w + x;
          const v = img[idx] + lift * a;
          img[idx] = v > 255 ? 255 : v | 0;
        }
      }
    }
  }

  // 2) glyph templates
  const templates: Float32Array[] = [];
  for (let g = 0; g < numGlyphs; g++) templates.push(makeGlyph(rand, style));

  // 3) layout: columns right-to-left, characters top-to-bottom
  const marginX = Math.round(w * 0.05);
  const marginY = Math.round(h * 0.04);
  const cellW = Math.round(w / 20);
  const cellH = Math.round(cellW * 1.25);
  const cols = Math.max(1, Math.floor((w - 2 * marginX) / cellW));
  const rows = Math.max(1, Math.floor((h - 2 * marginY) / cellH));
  const glyphSize = Math.min(cellW, cellH) - Math.round(cellW * 0.12);

  for (let col = 0; col < cols; col++) {
    // right-to-left
    const cellX = w - marginX - (col + 1) * cellW;
    for (let row = 0; row < rows; row++) {
      const cellY = marginY + row * cellH;
      // Zipf-ish template choice: a few glyphs dominate, long tail repeats
      const t = Math.floor(numGlyphs * Math.pow(rand(), 1.8));
      const tmpl = templates[Math.min(numGlyphs - 1, t)];
      const scale = 0.9 + rand() * 0.2;
      const rot = (rand() - 0.5) * 0.06;
      const density = 0.62 + rand() * 0.38;
      const jx = (rand() - 0.5) * cellW * 0.08;
      const jy = (rand() - 0.5) * cellH * 0.06;
      const gs = Math.round(glyphSize * scale);
      const ox = Math.round(cellX + (cellW - gs) / 2 + jx);
      const oy = Math.round(cellY + (cellH - gs) / 2 + jy);
      stampGlyph(img, w, h, tmpl, ox, oy, gs, rot, density, seed + col * 131 + row * 17, darkField);
    }
  }

  return { img, w, h };
}

function stampGlyph(
  img: Uint8Array,
  w: number,
  h: number,
  tmpl: Float32Array,
  ox: number,
  oy: number,
  size: number,
  rot: number,
  density: number,
  noiseSeed: number,
  darkField: boolean
) {
  const S = TEMPLATE_SIZE;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const cx = size / 2;
  const cy = size / 2;
  const inkBase = 24 + hash2(ox, oy, noiseSeed) * 26; // dark ink tone
  const paperBase = 196 + hash2(ox, oy, noiseSeed + 3) * 18; // paper showing through
  for (let y = 0; y < size; y++) {
    const gy = oy + y;
    if (gy < 0 || gy >= h) continue;
    const rowBase = gy * w;
    for (let x = 0; x < size; x++) {
      const gx = ox + x;
      if (gx < 0 || gx >= w) continue;
      // inverse transform: rotate about center, map to template coords
      const lx = x - cx;
      const ly = y - cy;
      const rx = lx * cos - ly * sin + cx;
      const ry = lx * sin + ly * cos + cy;
      const tx = (rx / size) * S;
      const ty = (ry / size) * S;
      if (tx < 0 || ty < 0 || tx >= S - 1 || ty >= S - 1) continue;
      // bilinear sample of template alpha
      const x0 = tx | 0;
      const y0 = ty | 0;
      const fx = tx - x0;
      const fy = ty - y0;
      const i00 = y0 * S + x0;
      const a =
        tmpl[i00] * (1 - fx) * (1 - fy) +
        tmpl[i00 + 1] * fx * (1 - fy) +
        tmpl[i00 + S] * (1 - fx) * fy +
        tmpl[i00 + S + 1] * fx * fy;
      if (a <= 0.02) continue;
      // rough ink edge: threshold jitter, spatially correlated like fiber bleed
      const rough = (valueNoise(gx / 2.5, gy / 2.5, noiseSeed + 1) - 0.5) * 0.34;
      let alpha = a + rough * (1 - a);
      if (alpha <= 0.05) continue;
      alpha = Math.min(1, alpha);
      const i = rowBase + gx;
      const fieldV = img[i];
      const blend = alpha * density;
      let glyphV: number;
      if (darkField) {
        // un-inked character: paper/stone color showing through
        glyphV =
          paperBase +
          (valueNoise(gx / 46, gy / 46, noiseSeed + 7) - 0.5) * 10 +
          (valueNoise(gx / 2.2, gy / 2.2, noiseSeed + 13) - 0.5) * 4;
      } else {
        // inked character on paper
        glyphV = inkBase + (valueNoise(gx / 3.2, gy / 3.2, noiseSeed + 5) - 0.5) * 10;
      }
      const v = fieldV * (1 - blend) + glyphV * blend;
      img[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
  }
}
