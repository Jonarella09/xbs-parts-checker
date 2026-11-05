// Talks to the photo engine worker, and prepares images for it.
import { LAYOUTS } from './mat.js';

let w = null, seq = 0; const pend = new Map();
function worker() {
  if (w) return w;
  w = new Worker(new URL('./worker.js', import.meta.url));
  w.onmessage = (e) => {
    const { id, ok, r, err, progress, text } = e.data; const p = pend.get(id); if (!p) return;
    if (progress != null) { p.onProgress && p.onProgress(progress, text); return; }
    pend.delete(id); if (ok) p.res(r); else p.rej(new Error(err));
  };
  w.onerror = (e) => { for (const p of pend.values()) p.rej(new Error(e.message || 'The photo engine stopped.')); pend.clear(); w = null; };
  return w;
}
/** Stop whatever the photo engine is doing (it restarts by itself on the next call). */
export function stopEngine() {
  if (w) { try { w.terminate(); } catch (e) {} w = null; }
  for (const p of pend.values()) p.rej(Object.assign(new Error('Stopped'), { stopped: true }));
  pend.clear();
}
export function call(cmd, data, transfer = [], onProgress) {
  return new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej, onProgress }); worker().postMessage({ id, cmd, data }, transfer); });
}

/** Decode a photo, respecting camera rotation, and scale it to at most maxPx pixels. */
export async function decode(blob, maxPx = 7e6, maxSide = 4200) {
  let bmp; try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(blob); }
  const s = Math.min(1, Math.sqrt(maxPx / (bmp.width * bmp.height)), maxSide / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * s), H = Math.round(bmp.height * s);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, W, H); bmp.close && bmp.close();
  return { canvas: c, W, H, scale: s };
}
export function pixels(canvas) { return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height); }
export function canvasFromRGBA(buf, W, H) { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), W, H), 0, 0); return c; }
export const toJpeg = (canvas, q = 0.88) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));
export function thumbOf(canvas, max = 360) { const s = Math.min(1, max / Math.max(canvas.width, canvas.height)); const c = document.createElement('canvas'); c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s); c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height); return toJpeg(c, 0.8); }

/** Run the engine on a canvas. opts: {mat, ppm, shadow, minMM, split, mode} */
export async function analyzeCanvas(canvas, opts, onProgress) {
  const id = pixels(canvas);
  return call('analyze', { rgba: id.data.buffer, W: id.width, H: id.height, opts: Object.assign({ layouts: LAYOUTS }, opts) }, [id.data.buffer], onProgress);
}
export async function silhouettes(pos) { const copy = new Float32Array(pos); return call('silhouettes', { pos: copy.buffer, res: 6 }, [copy.buffer]); }
