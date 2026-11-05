// Reads package labels off the main thread, so the page stays responsive during a long scan.
import { scanLabels } from './labelscan.js';
self.onmessage = async (e) => {
  const { id, bmp, labels, known, opts } = e.data;
  try {
    const r = await scanLabels(bmp, Object.assign({}, opts || {}, { whiteLabels: labels, known, onProgress: (f, t) => self.postMessage({ id, progress: f, text: t }) }));
    self.postMessage({ id, result: r });
  } catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
  finally { try { bmp.close(); } catch (x) {} }
};
