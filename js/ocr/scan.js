// Main-thread side of label reading: find the white label rectangles, then hand the photo to the OCR worker.
import { call } from '../vision/client.js';
let w = null, seq = 0; const pend = new Map();
function worker() {
  if (w) return w;
  w = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => { const { id, progress, text, result, error } = e.data; const p = pend.get(id); if (!p) return;
    if (progress != null) { p.onProgress && p.onProgress(progress, text); return; }
    pend.delete(id); if (error) p.rej(new Error(error)); else p.res(result); };
  w.onerror = (e) => { for (const p of pend.values()) p.rej(new Error(e.message || 'The text reader stopped.')); pend.clear(); w = null; };
  return w;
}
/** Read every package label in a photo (canvas). Resolves with packages (see labelscan.js). */
export async function scanPhoto(canvas, { onProgress, known = [], opts = {} } = {}) {
  onProgress && onProgress(0.01, 'Looking for labels');
  const W = canvas.width, H = canvas.height;
  const idata = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const fl = await call('findLabels', { rgba: idata.data.buffer, W, H, opts: {} }, [idata.data.buffer]);
  const bmp = await createImageBitmap(canvas);
  return new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej, onProgress }); worker().postMessage({ id, bmp, labels: fl.labels, known, opts }, [bmp]); });
}
