// Main-thread side of label reading: find the white label rectangles, then hand the photo to the OCR worker.
// A scan can be stopped at any time (the worker is shut down), and a watchdog stops it if the reader goes quiet.
import { call } from '../vision/client.js';
let w = null, seq = 0; const pend = new Map();
const QUIET_MS = 120000; // no news from the reader for 2 minutes: something is stuck

export const stoppedError = () => Object.assign(new Error('Stopped'), { stopped: true });
function kill(err) {
  if (w) { try { w.terminate(); } catch (e) {} w = null; }
  for (const p of pend.values()) p.fail(err);
  pend.clear();
}
function worker() {
  if (w) return w;
  w = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => { const { id, progress, text, result, error } = e.data; const p = pend.get(id); if (!p) return;
    p.beat = Date.now();
    if (progress != null) { p.onProgress && p.onProgress(progress, text); return; }
    pend.delete(id); if (error) p.fail(new Error(error)); else p.done(result); };
  w.onerror = (e) => { e.preventDefault && e.preventDefault(); kill(new Error(e.message || 'The text reader couldn’t start. Check the internet connection (it’s needed the first time).')); };
  w.onmessageerror = () => kill(new Error('The text reader sent something unreadable.'));
  return w;
}
/** Stop every label reading in progress. */
export function stopScans() { kill(stoppedError()); }

/** Read every package label in a photo (canvas). Resolves with packages (see labelscan.js).
    signal: an AbortSignal; aborting stops the scan and rejects with an error that has .stopped = true. */
export async function scanPhoto(canvas, { onProgress, known = [], opts = {}, signal } = {}) {
  if (signal && signal.aborted) throw stoppedError();
  onProgress && onProgress(0.01, 'Looking for labels');
  const W = canvas.width, H = canvas.height;
  const idata = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const fl = await call('findLabels', { rgba: idata.data.buffer, W, H, opts: {} }, [idata.data.buffer]);
  if (signal && signal.aborted) throw stoppedError();
  onProgress && onProgress(0.02, `Found ${fl.labels.length} label${fl.labels.length === 1 ? '' : 's'}`);
  const bmp = await createImageBitmap(canvas);
  return new Promise((res, rej) => {
    const id = ++seq; let tick = null;
    const end = () => { clearInterval(tick); if (signal) signal.removeEventListener('abort', onAbort); };
    const p = { onProgress, beat: Date.now(), done: (r) => { end(); res(r); }, fail: (e) => { end(); rej(e); } };
    const onAbort = () => { if (pend.has(id)) kill(stoppedError()); };
    if (signal) signal.addEventListener('abort', onAbort);
    tick = setInterval(() => { if (pend.has(id) && Date.now() - p.beat > QUIET_MS) kill(new Error('The text reader stopped responding.')); }, 5000);
    pend.set(id, p);
    try { worker().postMessage({ id, bmp, labels: fl.labels, known, opts }, [bmp]); } catch (e) { pend.delete(id); p.fail(e); }
  });
}
