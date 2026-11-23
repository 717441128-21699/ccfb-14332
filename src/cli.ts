// rubarchive CLI
//   gen        <out.pgm> [--size WxH] [--seed N] [--glyphs K] [--style 0|1|2]
//   compress   <in.pgm> <out.rub> [--tile N]
//   decompress <in.rub> <out.pgm>
//   verify     <in.rub> <orig.pgm>
//   bench      <in.pgm> [--tile N]          compress+png+decompress+verify, print report
//   archive    <in.pgm> <name> [--tile N]   compress into web/data, write sidecar JSON + manifest

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeImage, decodeImage } from './codec/container.js';
import { writePgm, readPgm } from './io/pgm.js';
import { writePng } from './io/png.js';
import { generateRubbing } from './gen/rubbing.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDataDir = join(here, '..', 'web', 'data');

function parseArgs(argv: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      opts[argv[i].slice(2)] = argv[i + 1] ?? '';
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

function fmtBytes(n: number): string {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(2) + ' MiB';
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KiB';
  return n + ' B';
}

function packBits(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

function b64(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64');
}

function cmdGen(pos: string[], opts: Record<string, string>) {
  const out = pos[0];
  if (!out) throw new Error('gen: missing output path');
  let width = 6000;
  let height = 9000;
  if (opts.size) {
    const m = opts.size.match(/^(\d+)x(\d+)$/);
    if (!m) throw new Error('--size WxH');
    width = +m[1];
    height = +m[2];
  }
  const t0 = Date.now();
  const { img, w, h } = generateRubbing({
    width,
    height,
    seed: opts.seed ? +opts.seed : 1,
    numGlyphs: opts.glyphs ? +opts.glyphs : 48,
    style: opts.style ? +opts.style : 0,
    polarity: opts.polarity === 'light-field' ? 'light-field' : 'dark-field',
  });
  writeFileSync(out, writePgm(img, w, h));
  console.log(`generated ${w}x${h} in ${Date.now() - t0} ms -> ${out}`);
}

function cmdCompress(pos: string[], opts: Record<string, string>) {
  const [inp, outp] = pos;
  if (!inp || !outp) throw new Error('compress: need <in.pgm> <out.rub>');
  const { img, w, h } = readPgm(readFileSync(inp));
  const tile = opts.tile ? +opts.tile : undefined;
  const t0 = Date.now();
  const res = encodeImage(img, w, h, tile);
  writeFileSync(outp, res.data);
  const s = res.stats;
  console.log(
    `compressed ${w}x${h}: ${fmtBytes(img.length)} -> ${fmtBytes(s.totalBytes)} ` +
      `(${(img.length / s.totalBytes).toFixed(2)}x) in ${Date.now() - t0} ms`
  );
  console.log(
    `  threshold=${s.threshold} components=${s.numComponents} glyphs=${s.numGlyphs} raw=${s.numRawInstances}`
  );
  console.log(
    `  sections: dict=${fmtBytes(s.dictBytes)} inst=${fmtBytes(s.instBytes)} ` +
      `paper=${fmtBytes(s.paperBytes)} ink=${fmtBytes(s.inkBytes)}`
  );
}

function cmdDecompress(pos: string[]) {
  const [inp, outp] = pos;
  if (!inp || !outp) throw new Error('decompress: need <in.rub> <out.pgm>');
  const t0 = Date.now();
  const res = decodeImage(readFileSync(inp));
  writeFileSync(outp, writePgm(res.img, res.width, res.height));
  console.log(
    `decompressed ${res.width}x${res.height} in ${Date.now() - t0} ms -> ${outp}`
  );
}

function cmdVerify(pos: string[]) {
  const [rubPath, origPath] = pos;
  if (!rubPath || !origPath) throw new Error('verify: need <in.rub> <orig.pgm>');
  const res = decodeImage(readFileSync(rubPath));
  const orig = readPgm(readFileSync(origPath));
  if (res.width !== orig.w || res.height !== orig.h) {
    console.error('FAIL: dimension mismatch');
    process.exit(1);
  }
  let diffs = 0;
  let firstDiff = -1;
  for (let i = 0; i < orig.img.length; i++) {
    if (res.img[i] !== orig.img[i]) {
      diffs++;
      if (firstDiff < 0) firstDiff = i;
    }
  }
  if (diffs === 0) {
    console.log('OK: pixel-exact round trip');
  } else {
    const fx = firstDiff % orig.w;
    const fy = (firstDiff / orig.w) | 0;
    console.error(
      `FAIL: ${diffs} pixels differ; first at (${fx},${fy}): ` +
        `orig=${orig.img[firstDiff]} decoded=${res.img[firstDiff]}`
    );
    process.exit(1);
  }
}

function cmdBench(pos: string[], opts: Record<string, string>) {
  const inp = pos[0];
  if (!inp) throw new Error('bench: need <in.pgm>');
  const { img, w, h } = readPgm(readFileSync(inp));
  const tile = opts.tile ? +opts.tile : undefined;

  const t0 = Date.now();
  const enc = encodeImage(img, w, h, tile);
  const encodeMs = Date.now() - t0;

  const t1 = Date.now();
  const png = writePng(img, w, h);
  const pngMs = Date.now() - t1;

  const t2 = Date.now();
  const dec = decodeImage(enc.data);
  const decodeMs = Date.now() - t2;

  let diffs = 0;
  for (let i = 0; i < img.length; i++) if (dec.img[i] !== img[i]) diffs++;

  const raw = img.length;
  const rub = enc.stats.totalBytes;
  const pngLen = png.length;
  console.log(`image:      ${w} x ${h}  (${fmtBytes(raw)} raw)`);
  console.log(`PNG:        ${fmtBytes(pngLen)}  (${(raw / pngLen).toFixed(2)}x vs raw, encoded in ${pngMs} ms)`);
  console.log(`RUB:        ${fmtBytes(rub)}  (${(raw / rub).toFixed(2)}x vs raw)`);
  console.log(`RUB vs PNG: ${(pngLen / rub).toFixed(2)}x smaller than PNG ${pngLen / rub >= 2 ? '(PASS >= 2x)' : '(below 2x target)'}`);
  console.log(`encode:     ${encodeMs} ms ${encodeMs <= 15000 ? '(PASS <= 15s)' : '(over 15s target)'}`);
  console.log(`decode:     ${decodeMs} ms ${decodeMs <= 3000 ? '(PASS <= 3s)' : '(over 3s target)'}`);
  console.log(`roundtrip:  ${diffs === 0 ? 'PIXEL-EXACT (PASS)' : diffs + ' PIXELS DIFFER (FAIL)'}`);
  const s = enc.stats;
  console.log(
    `sections:   dict=${fmtBytes(s.dictBytes)} inst=${fmtBytes(s.instBytes)} paper=${fmtBytes(s.paperBytes)} ink=${fmtBytes(s.inkBytes)}`
  );
  console.log(
    `glyphs:     ${s.numGlyphs} dictionary entries, ${s.numComponents} components, ${s.numRawInstances} raw instances`
  );
  if (diffs > 0) process.exit(1);
}

function cmdArchive(pos: string[], opts: Record<string, string>) {
  const [inp, name] = pos;
  if (!inp || !name) throw new Error('archive: need <in.pgm> <name>');
  const { img, w, h } = readPgm(readFileSync(inp));
  const tile = opts.tile ? +opts.tile : undefined;

  const t0 = Date.now();
  const enc = encodeImage(img, w, h, tile);
  const encodeMs = Date.now() - t0;
  const png = writePng(img, w, h);
  const t1 = Date.now();
  const dec = decodeImage(enc.data);
  const decodeMs = Date.now() - t1;
  let diffs = 0;
  for (let i = 0; i < img.length; i++) if (dec.img[i] !== img[i]) diffs++;
  if (diffs > 0) throw new Error(`roundtrip failed: ${diffs} pixels differ`);

  mkdirSync(webDataDir, { recursive: true });
  writeFileSync(join(webDataDir, `${name}.rub`), enc.data);

  // thumbnail for the archive UI (box downsample to <= 384 px wide)
  const thumbW = Math.min(384, w);
  const thumbH = Math.round((h * thumbW) / w);
  const thumb = new Uint8Array(thumbW * thumbH);
  const sx = w / thumbW;
  const sy = h / thumbH;
  for (let y = 0; y < thumbH; y++) {
    for (let x = 0; x < thumbW; x++) {
      // sample center of the box (fast; good enough for a preview)
      const gx = Math.min(w - 1, Math.floor((x + 0.5) * sx));
      const gy = Math.min(h - 1, Math.floor((y + 0.5) * sy));
      thumb[y * thumbW + x] = img[gy * w + gx];
    }
  }

  const s = enc.stats;
  const sidecar = {
    name,
    width: w,
    height: h,
    tileSize: tile ?? 512,
    origBytes: img.length,
    rubBytes: s.totalBytes,
    pngBytes: png.length,
    ratioRaw: img.length / s.totalBytes,
    ratioVsPng: png.length / s.totalBytes,
    encodeMs,
    decodeMs,
    threshold: s.threshold,
    numComponents: s.numComponents,
    numGlyphs: s.numGlyphs,
    numRawInstances: s.numRawInstances,
    sections: {
      dict: s.dictBytes,
      instances: s.instBytes,
      tables: s.tableBytes,
      paper: s.paperBytes,
      ink: s.inkBytes,
    },
    thumbW,
    thumbH,
    thumb: b64(thumb),
    glyphs: enc.model.entries.map((e) => ({
      id: e.id,
      w: e.w,
      h: e.h,
      count: e.count,
      bitmap: b64(packBits(e.bits)),
    })),
    instances: enc.model.instances.map((i) => ({
      g: i.glyphId,
      x: i.ux,
      y: i.uy,
      w: i.uw,
      h: i.uh,
    })),
  };
  writeFileSync(join(webDataDir, `${name}.json`), JSON.stringify(sidecar));

  // update manifest
  const manifestPath = join(webDataDir, 'manifest.json');
  let manifest: { rubbings: any[] } = { rubbings: [] };
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  }
  const entry = {
    name,
    width: w,
    height: h,
    origBytes: img.length,
    rubBytes: s.totalBytes,
    pngBytes: png.length,
    ratioRaw: img.length / s.totalBytes,
    ratioVsPng: png.length / s.totalBytes,
    numGlyphs: s.numGlyphs,
    numInstances: enc.model.instances.length,
    encodeMs,
    decodeMs,
  };
  const idx = manifest.rubbings.findIndex((r: any) => r.name === name);
  if (idx >= 0) manifest.rubbings[idx] = entry;
  else manifest.rubbings.push(entry);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(
    `archived ${name}: ${fmtBytes(img.length)} -> ${fmtBytes(s.totalBytes)} ` +
      `(${(png.length / s.totalBytes).toFixed(2)}x vs PNG), pixel-exact verified`
  );
}

const { positional, opts } = parseArgs(process.argv.slice(2));
const cmd = positional[0];
try {
  switch (cmd) {
    case 'gen':
      cmdGen(positional.slice(1), opts);
      break;
    case 'compress':
      cmdCompress(positional.slice(1), opts);
      break;
    case 'decompress':
      cmdDecompress(positional.slice(1));
      break;
    case 'verify':
      cmdVerify(positional.slice(1));
      break;
    case 'bench':
      cmdBench(positional.slice(1), opts);
      break;
    case 'archive':
      cmdArchive(positional.slice(1), opts);
      break;
    default:
      console.log('commands: gen | compress | decompress | verify | bench | archive');
      process.exit(cmd ? 1 : 0);
  }
} catch (e: any) {
  console.error('error:', e.message);
  process.exit(1);
}
