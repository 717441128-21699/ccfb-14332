// Progressive decode worker: decodes a .rub file tile by tile and posts each
// tile back for immediate display ("边解边显示").
import { decodeImage } from '../dist/codec/container.js';

self.onmessage = (e) => {
  try {
    const buf = new Uint8Array(e.data);
    // header: magic(4) version(4) width(4) height(4) tileSize(4)
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const width = dv.getUint32(8, true);
    const height = dv.getUint32(12, true);
    const tileSize = dv.getUint32(16, true);
    const total = Math.ceil(width / tileSize) * Math.ceil(height / tileSize);
    self.postMessage({ type: 'header', width, height, tileSize, total });
    const t0 = performance.now();
    let done = 0;
    decodeImage(buf, (tileIndex, x0, y0, tw, th, img, w) => {
      const tile = new Uint8Array(tw * th);
      for (let y = 0; y < th; y++) {
        tile.set(img.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + tw), y * tw);
      }
      done++;
      self.postMessage(
        { type: 'tile', tileIndex, x0, y0, tw, th, pixels: tile.buffer, done, total },
        [tile.buffer]
      );
    });
    self.postMessage({ type: 'done', ms: performance.now() - t0, width, height });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
