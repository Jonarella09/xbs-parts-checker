// PaddleOCR (PP-OCRv4) running in the browser with ONNX Runtime Web: a text detector (DBNet) that finds
// lines of text, and a recogniser (SVTR + CTC) that reads them. Much better than Tesseract on small,
// blurry text like package labels in a photo. Models download once (about 16 MB) and are cached.
export const PP = {
  ort: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.min.mjs',
  wasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/',
  det: 'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_det_infer.onnx',
  rec: 'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_rec_infer.onnx',
  dict: 'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/ppocr_keys_v1.txt',
};
let state = null, loading = null;

async function fetchBuf(url, onProgress, share) {
  const r = await fetch(url); if (!r.ok) throw new Error('Could not download the text reader (' + r.status + ').');
  const len = +r.headers.get('content-length') || 0; if (!r.body || !len) return new Uint8Array(await r.arrayBuffer());
  const rd = r.body.getReader(); const out = new Uint8Array(len); let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; out.set(value, got); got += value.length; onProgress && onProgress(share(got / len)); }
  return out;
}
/** Load the models (once). onProgress(fraction, text). */
export async function load(onProgress) {
  if (state) return state; if (loading) return loading;
  loading = (async () => {
    onProgress && onProgress(0, 'Getting the text reader ready (about 30 MB the first time)');
    const ort = await import(PP.ort);
    ort.env.wasm.wasmPaths = PP.wasm;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    let a = 0, b = 0; const tell = () => onProgress && onProgress(0.05 + 0.9 * (a * 0.3 + b * 0.7), 'Downloading the text reader');
    const [detB, recB, dictT] = await Promise.all([
      fetchBuf(PP.det, null, (f) => { a = f; tell(); }), fetchBuf(PP.rec, null, (f) => { b = f; tell(); }),
      fetch(PP.dict).then((r) => r.text()),
    ]);
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const det = await ort.InferenceSession.create(detB, opt);
    const rec = await ort.InferenceSession.create(recB, opt);
    const dict = dictT.split(/\r?\n/); if (dict[dict.length - 1] === '') dict.pop();
    state = { ort, det, rec, chars: ['', ...dict, ' '] };
    onProgress && onProgress(1, 'Text reader ready');
    return state;
  })();
  try { return await loading; } finally { loading = null; }
}

/* ---------------- detection ---------------- */
function canvasOf(w, h) { const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }); return c; }
/** Find text lines in an image region. src: canvas/image; rect: [x, y, w, h] in src pixels; scale: how much to enlarge first.
    Returns boxes in src coordinates: {cx, cy, w, h, ang (radians), score}. */
export async function detect(src, rect, { scale = 2, maxSide = 1600, thresh = 0.3, boxThresh = 0.55, unclip = 1.7, minSize = 3 } = {}) {
  const { ort, det } = state; const [rx, ry, rw, rh] = rect;
  let s = scale; if (Math.max(rw, rh) * s > maxSide) s = maxSide / Math.max(rw, rh);
  const W = Math.max(32, Math.round((rw * s) / 32) * 32), H = Math.max(32, Math.round((rh * s) / 32) * 32);
  const sx = W / rw, sy = H / rh;
  const c = canvasOf(W, H); const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high';
  g.drawImage(src, rx, ry, rw, rh, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data; const N = W * H; const t = new Float32Array(3 * N);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < N; i++) for (let ch = 0; ch < 3; ch++) t[ch * N + i] = (px[i * 4 + ch] / 255 - mean[ch]) / std[ch];
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, H, W]) });
  const P = out[det.outputNames[0]].data;
  // components of the probability map
  const lab = new Int32Array(N); let n = 0; const boxes = []; const stack = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (lab[i] || P[i] <= thresh) continue; n++; let sp = 0; stack[sp++] = i; lab[i] = n; const pts = []; let sum = 0;
    while (sp) { const j = stack[--sp]; const x = j % W, y = (j / W) | 0; pts.push(x, y); sum += P[j];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const k = Y * W + X; if (!lab[k] && P[k] > thresh) { lab[k] = n; stack[sp++] = k; } } }
    const np = pts.length / 2; if (np < 8) continue; const score = sum / np; if (score < boxThresh) continue;
    const r = minRect(pts); if (Math.min(r.w, r.h) < minSize) continue;
    const d = (r.w * r.h * unclip) / (2 * (r.w + r.h));
    let bw = r.w + 2 * d, bh = r.h + 2 * d, ang = r.ang;
    if (bh > bw) { const tt = bw; bw = bh; bh = tt; ang += Math.PI / 2; }
    while (ang > Math.PI / 2) ang -= Math.PI; while (ang < -Math.PI / 2) ang += Math.PI;
    boxes.push({ cx: rx + r.cx / sx, cy: ry + r.cy / sy, w: bw / sx, h: bh / sy, ang, score: +score.toFixed(3) });
  }
  return boxes;
}
function minRect(pts) {
  // convex hull, then rotating calipers
  const P = []; for (let i = 0; i < pts.length; i += 2) P.push([pts[i], pts[i + 1]]);
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = []; for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop(); const h = lo.concat(up); let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length]; const ang = Math.atan2(b[1] - a[1], b[0] - a[0]); const c = Math.cos(ang), s = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of h) { const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const w = u1 - u0 + 1, hh = v1 - v0 + 1; if (!best || w * hh < best.w * best.h) { const um = (u0 + u1) / 2, vm = (v0 + v1) / 2; best = { w, h: hh, ang, cx: um * c - vm * s, cy: um * s + vm * c }; }
  }
  if (!best) { const p = P[0] || [0, 0]; return { w: 1, h: 1, ang: 0, cx: p[0], cy: p[1] }; }
  return best;
}

/* ---------------- recognition ---------------- */
/** Read one text line. box in src coordinates (from detect). Returns {text, conf}. */
export async function recognize(src, box, { height = 48, maxW = 960, pad = 0.08 } = {}) {
  const { ort, rec, chars } = state;
  const bw = box.w * (1 + pad), bh = box.h * (1 + pad * 2.5);
  const s = height / bh; const W = Math.max(16, Math.min(maxW, Math.round(bw * s)));
  const c = canvasOf(W, height); const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high';
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, height);
  g.translate(W / 2, height / 2); g.scale(W / bw, s); g.rotate(-box.ang); g.translate(-box.cx, -box.cy); g.drawImage(src, 0, 0);
  const px = g.getImageData(0, 0, W, height).data; const N = W * height; const t = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let ch = 0; ch < 3; ch++) t[ch * N + i] = (px[i * 4 + ch] / 255 - 0.5) / 0.5;
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, height, W]) });
  const o = out[rec.outputNames[0]]; const [, T, C] = o.dims; const d = o.data;
  let text = '', prev = -1, cs = 0, cn = 0; const chs = [];
  for (let k = 0; k < T; k++) {
    let bi = 0, bv = -Infinity; const off = k * C; for (let j = 0; j < C; j++) { const v = d[off + j]; if (v > bv) { bv = v; bi = j; } }
    if (bi !== 0 && bi !== prev) { text += chars[bi] || ''; cs += bv; cn++; chs.push({ ch: chars[bi], p: bv }); }
    prev = bi;
  }
  return { text, conf: cn ? cs / cn : 0, chars: chs };
}
/** Detect and read every line in a region. Returns lines sorted top to bottom: {text, conf, cx, cy, w, h, ang}. */
export async function readRegion(src, rect, opts = {}) {
  const boxes = await detect(src, rect, opts);
  const lines = [];
  for (const b of boxes) { if (b.w < 6 || b.h < 4) continue; const r = await recognize(src, b, opts); if (r.text.trim()) lines.push(Object.assign({}, b, r)); }
  lines.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  return lines;
}
export const ready = () => !!state;
