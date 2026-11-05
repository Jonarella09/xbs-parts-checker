/* The Indexer photo engine (Web Worker, classic script).
   1. Counting mat: find the ArUco markers, straighten the photo and get an exact mm scale.
   2. Background model: learn the table/mat colour (with lighting changes) and mark everything that isn't it.
      Shadows are kept as background: same colour as the table, just darker (brightness/chromaticity model).
   3. Clean up, find separate pieces, fill holes (but remember them: washers, nuts, gears).
   4. Split touching pieces with a distance-transform watershed.
   5. Measure each piece: area, length, width, shape, holes, width profile, outline harmonics, colour.
   Everything here is plain JavaScript: no network, no AI service. */
'use strict';
let arucoReady = false;
function loadAruco() { if (!arucoReady) { importScripts('../../lib/aruco/cv.js', '../../lib/aruco/aruco.js'); arucoReady = true; } }

const CMDS = {
  analyze, silhouettes, findLabels,
  ping: () => ({ out: 'pong' }),
};
self.onmessage = async (e) => {
  const { id, cmd, data } = e.data;
  try { const r = await CMDS[cmd](data, (f, t) => self.postMessage({ id, progress: f, text: t })); self.postMessage({ id, ok: true, r: r.out }, r.transfer || []); }
  catch (err) { self.postMessage({ id, ok: false, err: String((err && err.message) || err), stack: err && err.stack }); }
};

/* ------------------------------------------------------------------ */
/* main entry                                                          */
/* ------------------------------------------------------------------ */
function analyze(d, progress) {
  let img = new Uint8ClampedArray(d.rgba); let W = d.W, H = d.H; const o = d.opts || {};
  let ppm = o.ppm || null, scaleSrc = o.ppm ? (o.scaleSrc || 'given') : null, mat = null, rect = null, mask0 = null;
  progress(0.05, 'Looking for the counting mat');
  if (o.mat !== false && o.layouts) {
    try {
      const m = findMat(img, W, H, o.layouts);
      if (m) {
        progress(0.15, 'Straightening the photo');
        const out = warpMat(img, W, H, m, o.matPpm || 0);
        img = out.rgba; W = out.W; H = out.H; ppm = out.ppm; scaleSrc = 'mat'; mat = { layout: m.layout.id, name: m.layout.name, found: m.found, err: m.err };
        mask0 = out.exclude; rect = out.rgba.buffer.slice(0);
      }
    } catch (err) { /* no mat: carry on with the plain photo */ }
  }
  progress(0.25, 'Learning the background');
  const seg = segment(img, W, H, Object.assign({}, o, { ppm }), mask0, progress);
  progress(0.85, 'Measuring pieces');
  const objs = measureAll(img, W, H, seg, Object.assign({}, o, { ppm }));
  progress(1, 'Done');
  const out = { W, H, ppm, scaleSrc, mat, objs, bg: seg.bgStats };
  const transfer = [];
  if (rect) { out.rgba = rect; transfer.push(rect); }
  if (o.wantMask) { out.mask = seg.lab.buffer; transfer.push(out.mask); }
  return { out, transfer };
}

/* ------------------------------------------------------------------ */
/* counting mat                                                        */
/* ------------------------------------------------------------------ */
function findMat(img, W, H, layouts) {
  loadAruco();
  const det = new self.AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12', maxHammingDistance: 5 });
  // detect on a version no larger than ~1600 px for speed, then scale corners back
  const s = Math.min(1, 1600 / Math.max(W, H));
  let src = { width: W, height: H, data: img };
  if (s < 1) src = resizeRGBA(img, W, H, Math.round(W * s), Math.round(H * s));
  const markers = det.detect(src).map((mk) => ({ id: mk.id, corners: mk.corners.map((c) => [c.x / s, c.y / s]) }));
  let best = null;
  for (const L of layouts) {
    const found = markers.filter((mk) => L.ids.includes(mk.id));
    const ids = new Set(found.map((f) => f.id)); if (ids.size < 3) continue;
    if (!best || ids.size > best.found) best = { layout: L, markers: found, found: ids.size };
  }
  if (!best) return null;
  const L = best.layout; const src2 = [], dst = [];
  for (const mk of best.markers) {
    const k = L.ids.indexOf(mk.id); const [cx, cy] = L.centers[k]; const h = L.marker / 2;
    const mmC = [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
    for (let j = 0; j < 4; j++) { src2.push(mmC[j]); dst.push(mk.corners[j]); }
  }
  const Hm = homography(src2, dst); if (!Hm) return null;
  let err = 0; for (let i = 0; i < src2.length; i++) { const q = applyH(Hm, src2[i][0], src2[i][1]); err += Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]); }
  err /= src2.length;
  if (err > 6) return null;
  return { layout: L, H: Hm, found: best.found, err: +err.toFixed(2) };
}
function warpMat(img, W, H, m, wantPpm) {
  const L = m.layout; const [x0, y0, x1, y1] = L.area;
  // source resolution at the mat: px per mm along the top edge
  const a = applyH(m.H, x0, y0), b = applyH(m.H, x1, y0), c = applyH(m.H, x0, y1);
  const srcPpm = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]) / (x1 - x0), Math.hypot(c[0] - a[0], c[1] - a[1]) / (y1 - y0));
  let ppm = wantPpm || Math.max(3, Math.min(9, srcPpm));
  const maxPx = 4.2e6; if ((x1 - x0) * (y1 - y0) * ppm * ppm > maxPx) ppm = Math.sqrt(maxPx / ((x1 - x0) * (y1 - y0)));
  ppm = Math.round(ppm * 100) / 100;
  const OW = Math.round((x1 - x0) * ppm), OH = Math.round((y1 - y0) * ppm);
  const out = new Uint8ClampedArray(OW * OH * 4); const ex = new Uint8Array(OW * OH);
  const h = m.H;
  for (let v = 0; v < OH; v++) {
    const Y = y0 + (v + 0.5) / ppm;
    for (let u = 0; u < OW; u++) {
      const X = x0 + (u + 0.5) / ppm;
      const w = h[6] * X + h[7] * Y + h[8]; const sx = (h[0] * X + h[1] * Y + h[2]) / w - 0.5, sy = (h[3] * X + h[4] * Y + h[5]) / w - 0.5;
      const o = (v * OW + u) * 4;
      if (sx < 0 || sy < 0 || sx >= W - 1 || sy >= H - 1) { ex[v * OW + u] = 1; out[o + 3] = 255; continue; }
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy; const i0 = (iy * W + ix) * 4, i1 = i0 + W * 4;
      for (let ch = 0; ch < 3; ch++) out[o + ch] = (img[i0 + ch] * (1 - fx) + img[i0 + 4 + ch] * fx) * (1 - fy) + (img[i1 + ch] * (1 - fx) + img[i1 + 4 + ch] * fx) * fy;
      out[o + 3] = 255;
    }
  }
  // keep the marker corners out of the counting area
  const cz = L.cornerZone;
  for (const [cx, cy] of L.centers) {
    const ux0 = Math.floor((cx - cz / 2 - x0) * ppm), ux1 = Math.ceil((cx + cz / 2 - x0) * ppm), vy0 = Math.floor((cy - cz / 2 - y0) * ppm), vy1 = Math.ceil((cy + cz / 2 - y0) * ppm);
    for (let v = Math.max(0, vy0); v < Math.min(OH, vy1); v++) for (let u = Math.max(0, ux0); u < Math.min(OW, ux1); u++) ex[v * OW + u] = 1;
  }
  return { rgba: out, W: OW, H: OH, ppm, exclude: ex };
}
function homography(src, dst) {
  // normalised DLT with h33 = 1, least squares
  const norm = (pts) => { let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length; let d = 0; for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my); d = d / pts.length || 1; const s = Math.SQRT2 / d; return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], P: pts.map((p) => [(p[0] - mx) * s, (p[1] - my) * s]) }; };
  const A = norm(src), B = norm(dst); const M = Array.from({ length: 8 }, () => new Float64Array(9));
  for (let i = 0; i < A.P.length; i++) {
    const [x, y] = A.P[i], [u, v] = B.P[i];
    const r1 = [x, y, 1, 0, 0, 0, -u * x, -u * y, u], r2 = [0, 0, 0, x, y, 1, -v * x, -v * y, v];
    for (const r of [r1, r2]) for (let a = 0; a < 8; a++) { for (let b = 0; b < 8; b++) M[a][b] += r[a] * r[b]; M[a][8] += r[a] * r[8]; }
  }
  const h = solve(M); if (!h) return null; const Hn = [...h, 1];
  // H = inv(TB) * Hn * TA
  const TBi = inv3(B.T); return mul3(mul3(TBi, Hn), A.T);
}
function solve(M) {
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null; [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return Array.from({ length: n }, (_, i) => M[i][n] / M[i][i]);
}
function mul3(a, b) { const r = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]; return r; }
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m; const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g; const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
function applyH(h, x, y) { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; }
function resizeRGBA(img, W, H, w, h) {
  const out = new Uint8ClampedArray(w * h * 4); const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) { const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) { const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)); let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * W + xx) * 4; r += img[i]; g += img[i + 1]; b += img[i + 2]; n++; }
      const o = (y * w + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255; } }
  return { width: w, height: h, data: out };
}

/* ------------------------------------------------------------------ */
/* segmentation                                                        */
/* ------------------------------------------------------------------ */
function segment(img, W, H, o, exclude, progress) {
  const N = W * H; const ppm = o.ppm || null;
  // 1. dominant colour = first guess of the background
  const hist = new Uint32Array(4096), step = Math.max(1, Math.floor(Math.sqrt(N / 300000)));
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) { const i = (y * W + x) * 4; if (exclude && exclude[y * W + x]) continue; hist[((img[i] >> 4) << 8) | ((img[i + 1] >> 4) << 4) | (img[i + 2] >> 4)]++; }
  let bestBin = 0, bestS = -1;
  for (let r = 0; r < 16; r++) for (let g = 0; g < 16; g++) for (let b = 0; b < 16; b++) {
    let s = 0; for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) { const R = r + dr, G = g + dg, B = b + db; if (R < 0 || G < 0 || B < 0 || R > 15 || G > 15 || B > 15) continue; s += hist[(R << 8) | (G << 4) | B]; }
    if (s > bestS) { bestS = s; bestBin = (r << 8) | (g << 4) | b; }
  }
  const bg0 = [((bestBin >> 8) & 15) * 16 + 8, ((bestBin >> 4) & 15) * 16 + 8, (bestBin & 15) * 16 + 8];
  const userBg = o.bgColor; if (userBg) { bg0[0] = userBg[0]; bg0[1] = userBg[1]; bg0[2] = userBg[2]; }
  // 2. background grid: mean colour of background-like pixels per block, holes filled from neighbours
  const bs = Math.max(8, Math.round(Math.max(W, H) / 48)); const gw = Math.ceil(W / bs), gh = Math.ceil(H / bs);
  const gr = new Float32Array(gw * gh), gg = new Float32Array(gw * gh), gb = new Float32Array(gw * gh), gv = new Uint8Array(gw * gh);
  const like = (r, g, b, R, G, B, tcd) => { const bb = R * R + G * G + B * B + 1; const a = (r * R + g * G + b * B) / bb; if (a < 0.4 || a > 1.7) return false; const dr = r - a * R, dg = g - a * G, db = b - a * B; return Math.sqrt((dr * dr + dg * dg + db * db) / bb) < tcd; };
  for (let pass = 0; pass < 2; pass++) {
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      const R0 = pass ? gr[by * gw + bx] : bg0[0], G0 = pass ? gg[by * gw + bx] : bg0[1], B0 = pass ? gb[by * gw + bx] : bg0[2];
      let sr = 0, sg = 0, sb = 0, n = 0, tot = 0;
      for (let y = by * bs; y < Math.min(H, by * bs + bs); y += 2) for (let x = bx * bs; x < Math.min(W, bx * bs + bs); x += 2) {
        tot++; if (exclude && exclude[y * W + x]) continue; const i = (y * W + x) * 4;
        if (like(img[i], img[i + 1], img[i + 2], R0, G0, B0, pass ? 0.08 : 0.14)) { sr += img[i]; sg += img[i + 1]; sb += img[i + 2]; n++; }
      }
      const k = by * gw + bx; if (n > tot * 0.12 && n > 6) { gr[k] = sr / n; gg[k] = sg / n; gb[k] = sb / n; gv[k] = 1; } else if (!pass) gv[k] = 0;
    }
    fillGrid(gr, gg, gb, gv, gw, gh, bg0);
    for (let it = 0; it < 2; it++) smoothGrid(gr, gg, gb, gw, gh);
  }
  // 3. classify pixels
  progress(0.4, 'Finding pieces');
  const bgR = new Float32Array(W), bgG = new Float32Array(W), bgB = new Float32Array(W);
  const alpha = new Float32Array(N), cd = new Float32Array(N);
  const sampA = [], sampC = [];
  for (let y = 0; y < H; y++) {
    rowBg(gr, gg, gb, gw, gh, bs, y, W, bgR, bgG, bgB);
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4; const R = bgR[x], G = bgG[x], B = bgB[x]; const bb = R * R + G * G + B * B + 1;
      const r = img[i], g = img[i + 1], b = img[i + 2]; const a = (r * R + g * G + b * B) / bb; const dr = r - a * R, dg = g - a * G, db = b - a * B;
      alpha[p] = a; cd[p] = Math.sqrt((dr * dr + dg * dg + db * db) / bb);
      if ((p & 511) === 0) { sampA.push(Math.abs(a - 1)); sampC.push(cd[p]); }
    }
  }
  // noise level of the background (robust: lower half of the samples is mostly background)
  const q = (arr, f) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * f))] || 0; };
  const nA = q(sampA, 0.4), nC = q(sampC, 0.4);
  const tCD = Math.max(o.minChroma || 0.075, nC * 3.2 + 0.02);
  // on a coloured surface (wood, green mat) neutral pieces stand out by colour, so shadows can be cut harder
  const bgC = (Math.max(...bg0) - Math.min(...bg0)) / Math.max(1, Math.max(...bg0));
  const tLo = Math.min(o.shadow != null ? o.shadow : (bgC > 0.2 ? 0.52 : 0.66), 1 - Math.max(0.12, nA * 4));
  const tHi = 1 + Math.max(0.16, nA * 4);
  const fg = new Uint8Array(N);
  for (let p = 0; p < N; p++) if (cd[p] > tCD || alpha[p] < tLo || alpha[p] > tHi) fg[p] = 1;
  // 3b. on white or grey surfaces, shiny metal looks like the paper and its shadow: use sharp outlines too.
  //     Shadows have soft edges, pieces have sharp ones; closed outlines are filled in.
  let edgeInfo = null;
  if (o.edges !== false && (o.edges === true || bgC < 0.25)) edgeInfo = edgeCue(img, W, H, fg, alpha, exclude);
  if (exclude) for (let p = 0; p < N; p++) if (exclude[p]) fg[p] = 0;
  // 4. clean up: remove speckles, close small gaps
  const r1 = 1, rc = ppm ? Math.max(1, Math.round(0.35 * ppm)) : 2;
  let m = erode(fg, W, H, r1); m = dilate(m, W, H, r1);
  m = dilate(m, W, H, rc); m = erode(m, W, H, rc);
  // 5. connected components
  progress(0.55, 'Separating pieces');
  const minA = o.minArea || (ppm ? Math.max(12, Math.round((o.minMM || 1.6) * (o.minMM || 1.6) * ppm * ppm)) : Math.max(24, Math.round(N * 2e-5)));
  const { lab, n } = components(m, W, H);
  const comps = compStats(lab, n, W, H);
  const keep = comps.filter((c) => c.a >= minA);
  // 6. holes, splitting
  const lab2 = new Int32Array(N); let next = 1; const objs = [];
  const maxSplit = o.mode === 'labels' ? false : o.split !== false;
  for (const c of keep) {
    const loc = local(lab, W, c); const holes = fillHoles(loc, lab, W, c);
    let parts = [loc.filled];
    if (maxSplit && c.a > minA * 2.2) parts = splitTouching(loc.filled, loc.w, loc.h, Math.max(minA, c.a * 0.06), ppm);
    for (const pm of parts) {
      const id = next++; let a = 0;
      for (let yy = 0; yy < loc.h; yy++) for (let xx = 0; xx < loc.w; xx++) { if (!pm[yy * loc.w + xx]) continue; a++; const P = (c.y0 + yy) * W + c.x0 + xx; if (lab[P] === c.id || !lab2[P]) lab2[P] = id; }
      if (a < minA * 0.6) continue;
      objs.push({ id, x0: c.x0, y0: c.y0, w: loc.w, h: loc.h, m: pm, holes: parts.length === 1 ? holes : holesIn(pm, loc.w, loc.h, loc.own) });
    }
  }
  return { lab: lab2, objs, bgStats: { bg: bg0, bgC: +bgC.toFixed(2), edges: edgeInfo, tCD: +tCD.toFixed(3), tLo: +tLo.toFixed(3), tHi: +tHi.toFixed(3), minA, n: objs.length, grid: { gw, gh } } };
}
function edgeCue(img, W, H, fg, alpha, exclude) {
  const N = W * H; const lum = new Float32Array(N);
  for (let p = 0, i = 0; p < N; p++, i += 4) lum[p] = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
  const G = new Float32Array(N); const samp = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x;
    const gx = lum[p - W + 1] + 2 * lum[p + 1] + lum[p + W + 1] - lum[p - W - 1] - 2 * lum[p - 1] - lum[p + W - 1];
    const gy = lum[p + W - 1] + 2 * lum[p + W] + lum[p + W + 1] - lum[p - W - 1] - 2 * lum[p - W] - lum[p - W + 1];
    const bl = alpha[p] > 0.05 ? lum[p] / alpha[p] : 255; // brightness of the background here
    G[p] = Math.hypot(gx, gy) / (bl + 10);
    if (!fg[p] && (p % 13) === 0 && !(exclude && exclude[p])) samp.push(G[p]);
  }
  samp.sort((a, b) => a - b); const p90 = samp[Math.floor(samp.length * 0.9)] || 0.02;
  const thr = Math.max(0.16, 4.5 * p90);
  let e = new Uint8Array(N); let ne = 0;
  for (let p = 0; p < N; p++) if (G[p] > thr && !(exclude && exclude[p])) { e[p] = 1; ne++; }
  if (ne > N * 0.25) return { thr: +thr.toFixed(3), used: false }; // a busy, textured surface: outlines don't help
  e = dilate(e, W, H, 1);
  // fill what the outlines enclose (not connected to the photo border)
  const inv = new Uint8Array(N); for (let p = 0; p < N; p++) inv[p] = e[p] ? 0 : 1;
  const { lab, n } = components(inv, W, H); const touch = new Uint8Array(n + 1); const area = new Int32Array(n + 1);
  for (let p = 0; p < N; p++) { const l = lab[p]; if (!l) continue; area[l]++; const x = p % W, y = (p / W) | 0; if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touch[l] = 1; }
  let added = 0;
  for (let p = 0; p < N; p++) { const l = lab[p]; if ((e[p] || (l && !touch[l] && area[l] < N * 0.02)) && !fg[p]) { fg[p] = 1; added++; } }
  return { thr: +thr.toFixed(3), used: true, added };
}
function fillGrid(gr, gg, gb, gv, gw, gh, bg0) {
  let any = false; for (let k = 0; k < gv.length; k++) if (gv[k]) { any = true; break; }
  if (!any) { gr.fill(bg0[0]); gg.fill(bg0[1]); gb.fill(bg0[2]); gv.fill(1); return; }
  const v = Uint8Array.from(gv);
  for (let it = 0; it < gw + gh; it++) {
    let changed = false; const nv = Uint8Array.from(v);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const k = y * gw + x; if (v[k]) continue; let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue; const kk = Y * gw + X; if (v[kk]) { r += gr[kk]; g += gg[kk]; b += gb[kk]; n++; } }
      if (n) { gr[k] = r / n; gg[k] = g / n; gb[k] = b / n; nv[k] = 1; changed = true; }
    }
    v.set(nv); if (!changed) break;
  }
}
function smoothGrid(gr, gg, gb, gw, gh) {
  for (const A of [gr, gg, gb]) { const c = Float32Array.from(A);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue; s += c[Y * gw + X]; n++; } A[y * gw + x] = s / n; } }
}
function rowBg(gr, gg, gb, gw, gh, bs, y, W, R, G, B) {
  const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / bs - 0.5)); const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
  for (let x = 0; x < W; x++) {
    const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / bs - 0.5)); const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
    const k00 = y0 * gw + x0, k01 = y0 * gw + x1, k10 = y1 * gw + x0, k11 = y1 * gw + x1;
    const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
    R[x] = gr[k00] * w00 + gr[k01] * w01 + gr[k10] * w10 + gr[k11] * w11;
    G[x] = gg[k00] * w00 + gg[k01] * w01 + gg[k10] * w10 + gg[k11] * w11;
    B[x] = gb[k00] * w00 + gb[k01] * w01 + gb[k10] * w10 + gb[k11] * w11;
  }
}
/* square-kernel binary morphology via running sums (O(N) whatever the radius) */
function boxCount(m, W, H, r) {
  const tmp = new Uint16Array(W * H), out = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) { let s = 0; const o = y * W; for (let x = -r; x < W; x++) { if (x + r < W) s += m[o + x + r]; if (x - r - 1 >= 0) s -= m[o + x - r - 1]; if (x >= 0) tmp[o + x] = s; } }
  for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y < H; y++) { if (y + r < H) s += tmp[(y + r) * W + x]; if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * W + x]; if (y >= 0) out[y * W + x] = s; } }
  return out;
}
function dilate(m, W, H, r) { if (r <= 0) return m; const c = boxCount(m, W, H, r); const o = new Uint8Array(W * H); for (let i = 0; i < o.length; i++) o[i] = c[i] > 0 ? 1 : 0; return o; }
function erode(m, W, H, r) {
  if (r <= 0) return m; const c = boxCount(m, W, H, r); const o = new Uint8Array(W * H); const full = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!m[i]) continue; const ax = Math.min(x + r, W - 1) - Math.max(x - r, 0) + 1, ay = Math.min(y + r, H - 1) - Math.max(y - r, 0) + 1; o[i] = c[i] >= Math.min(full, ax * ay) ? 1 : 0; }
  return o;
}
function components(m, W, H) {
  const lab = new Int32Array(W * H); const par = [0]; let n = 0;
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!m[i]) continue; let l = 0;
    const nb = [x > 0 ? lab[i - 1] : 0, y > 0 ? lab[i - W] : 0, y > 0 && x > 0 ? lab[i - W - 1] : 0, y > 0 && x < W - 1 ? lab[i - W + 1] : 0];
    for (const v of nb) if (v) { if (!l) l = v; else if (v !== l) { const a = find(l), b = find(v); if (a !== b) par[Math.max(a, b)] = Math.min(a, b); } }
    if (!l) { n++; par.push(n); l = n; } lab[i] = l;
  }
  const map = new Int32Array(n + 1); let k = 0; for (let i = 1; i <= n; i++) { const r = find(i); if (!map[r]) map[r] = ++k; map[i] = map[r]; }
  for (let i = 0; i < lab.length; i++) if (lab[i]) lab[i] = map[lab[i]];
  return { lab, n: k };
}
function compStats(lab, n, W, H) {
  const c = Array.from({ length: n + 1 }, (_, id) => ({ id, a: 0, x0: W, y0: H, x1: -1, y1: -1 }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const l = lab[y * W + x]; if (!l) continue; const s = c[l]; s.a++; if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y; }
  return c.slice(1).filter((s) => s.a > 0);
}
function local(lab, W, c) {
  const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1; const own = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lab[(c.y0 + y) * W + c.x0 + x] === c.id) own[y * w + x] = 1;
  return { w, h, own, filled: null };
}
/* fill holes; return list of holes (area) – washers, nuts and gears have them */
function fillHoles(loc, lab, W, c) {
  const { w, h, own } = loc; const out = new Uint8Array(w * h); const q = new Int32Array(w * h); let qh = 0, qt = 0;
  for (let x = 0; x < w; x++) { for (const y of [0, h - 1]) { const i = y * w + x; if (!own[i] && !out[i]) { out[i] = 2; q[qt++] = i; } } }
  for (let y = 0; y < h; y++) { for (const x of [0, w - 1]) { const i = y * w + x; if (!own[i] && !out[i]) { out[i] = 2; q[qt++] = i; } } }
  while (qh < qt) { const i = q[qh++]; const x = i % w, y = (i / w) | 0; const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]; for (const j of nb) if (j >= 0 && !own[j] && !out[j]) { out[j] = 2; q[qt++] = j; } }
  const filled = new Uint8Array(w * h); const holeMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { if (out[i] !== 2) { filled[i] = 1; if (!own[i]) { const gl = lab[(c.y0 + ((i / w) | 0)) * W + c.x0 + (i % w)]; if (!gl) holeMask[i] = 1; } } }
  loc.filled = filled; loc.holeMask = holeMask;
  return holeList(holeMask, w, h, c.a);
}
function holesIn(pm, w, h, own) {
  const hm = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) if (pm[i] && !own[i]) hm[i] = 1;
  let a = 0; for (let i = 0; i < w * h; i++) a += pm[i]; return holeList(hm, w, h, a);
}
function holeList(hm, w, h, area) {
  const { lab, n } = components(hm, w, h); if (!n) return [];
  const s = compStats(lab, n, w, h); const min = Math.max(4, area * 0.004);
  return s.filter((x) => x.a >= min).map((x) => ({ a: x.a, cx: (x.x0 + x.x1) / 2, cy: (x.y0 + x.y1) / 2 }));
}

/* ------------------------------------------------------------------ */
/* splitting touching pieces: distance transform + watershed with h-maxima merging */
/* ------------------------------------------------------------------ */
function edt(mask, w, h) {
  const INF = 1e20; const f = new Float64Array(Math.max(w, h) + 2); const d = new Float64Array(Math.max(w, h) + 2); const v = new Int32Array(Math.max(w, h) + 2); const z = new Float64Array(Math.max(w, h) + 3);
  const D = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) D[i] = mask[i] ? INF : 0;
  const pass = (n, get, set) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) { let s; do { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k]) k--; else break; } while (k >= 0); k++; v[k] = q; z[k] = s; z[k + 1] = INF; }
    k = 0; for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
    for (let i = 0; i < n; i++) set(i, d[i]);
  };
  // pad: treat outside as background by running on rows/cols including border zeros
  for (let x = 0; x < w; x++) { const col = new Float64Array(h + 2); col[0] = 0; col[h + 1] = 0; for (let y = 0; y < h; y++) col[y + 1] = D[y * w + x]; pass(h + 2, (i) => col[i], (i, val) => { if (i > 0 && i <= h) D[(i - 1) * w + x] = val; }); }
  for (let y = 0; y < h; y++) { const row = new Float64Array(w + 2); for (let x = 0; x < w; x++) row[x + 1] = D[y * w + x]; pass(w + 2, (i) => row[i], (i, val) => { if (i > 0 && i <= w) D[y * w + i - 1] = val; }); }
  for (let i = 0; i < w * h; i++) D[i] = Math.sqrt(D[i]);
  return D;
}
function splitTouching(mask, w, h, minPart, ppm) {
  const D = edt(mask, w, h); let maxD = 0; for (let i = 0; i < w * h; i++) if (D[i] > maxD) maxD = D[i];
  if (maxD < 3) return [mask];
  // light smoothing of the distance map to remove pixel noise on ridges
  const S = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!mask[i]) continue; let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const j = Y * w + X; if (mask[j]) { s += D[j]; n++; } } S[i] = s / n; }
  const lab = new Int32Array(w * h); const par = [0], peak = [0]; let n = 0;
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  // seeds: local maxima of S
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i] || S[i] < 1) continue; let isMax = true;
    for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; if (S[Y * w + X] > S[i]) { isMax = false; break; } }
    if (isMax) { n++; par.push(n); peak.push(S[i]); lab[i] = n; }
  }
  if (n < 2) return [mask];
  // merge seeds on the same plateau
  for (let i = 0; i < w * h; i++) { if (!lab[i]) continue; const x = i % w, y = (i / w) | 0; for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const j = Y * w + X; if (lab[j]) { const a = find(lab[i]), b = find(lab[j]); if (a !== b) { par[Math.max(a, b)] = Math.min(a, b); peak[Math.min(a, b)] = Math.max(peak[a], peak[b]); } } } }
  // priority flood (max-heap on S)
  const heap = new Heap(); for (let i = 0; i < w * h; i++) if (lab[i]) heap.push(i, S[i]);
  const saddle = new Map();
  while (heap.size) {
    const i = heap.pop(); const li = find(lab[i]); const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue; const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const j = Y * w + X; if (!mask[j]) continue;
      if (!lab[j]) { lab[j] = li; heap.push(j, S[j]); }
      else { const lj = find(lab[j]); if (lj !== li) { const key = li < lj ? li * 100000 + lj : lj * 100000 + li; const s = Math.min(S[i], S[j]); if (!saddle.has(key) || saddle.get(key) < s) saddle.set(key, s); } }
    }
  }
  // merge basins whose dynamic is below h
  const pairs = [...saddle.entries()].map(([k, s]) => ({ a: Math.floor(k / 100000), b: k % 100000, s })).sort((p, q) => q.s - p.s);
  const pk = (a) => peak[find(a)];
  const hAbs = ppm ? Math.max(1.6, 0.6 * ppm) : 2;
  for (const pr of pairs) {
    const a = find(pr.a), b = find(pr.b); if (a === b) continue;
    const low = Math.min(peak[a], peak[b]); const h = Math.max(hAbs, 0.3 * low);
    if (low - pr.s < h) { const keep = Math.min(a, b), drop = Math.max(a, b); par[drop] = keep; peak[keep] = Math.max(peak[a], peak[b]); }
  }
  void pk;
  const roots = new Map();
  for (let i = 0; i < w * h; i++) if (lab[i]) { const r = find(lab[i]); roots.set(r, (roots.get(r) || 0) + 1); }
  const big = [...roots.entries()].filter(([, a]) => a >= minPart).map(([r]) => r);
  if (big.length < 2) return [mask];
  // small basins join the neighbour they touch most
  const out = big.map(() => new Uint8Array(w * h)); const idx = new Map(big.map((r, k) => [r, k]));
  const orphan = [];
  for (let i = 0; i < w * h; i++) { if (!lab[i]) continue; const r = find(lab[i]); if (idx.has(r)) out[idx.get(r)][i] = 1; else orphan.push(i); }
  for (let pass = 0; pass < 6 && orphan.length; pass++) {
    for (let t = orphan.length - 1; t >= 0; t--) { const i = orphan[t]; const x = i % w, y = (i / w) | 0; let hit = -1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const j = Y * w + X; for (let k = 0; k < out.length; k++) if (out[k][j]) { hit = k; break; } if (hit >= 0) break; }
      if (hit >= 0) { out[hit][i] = 1; orphan.splice(t, 1); } }
  }
  return out;
}
class Heap { // max-heap of (index, key)
  constructor() { this.i = []; this.k = []; this.size = 0; }
  push(i, k) { const a = this.i, b = this.k; let n = this.size++; a[n] = i; b[n] = k; while (n > 0) { const p = (n - 1) >> 1; if (b[p] >= b[n]) break; [a[p], a[n]] = [a[n], a[p]]; [b[p], b[n]] = [b[n], b[p]]; n = p; } }
  pop() { const a = this.i, b = this.k; const top = a[0]; const n = --this.size; if (n > 0) { a[0] = a[n]; b[0] = b[n]; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < n && b[l] > b[m]) m = l; if (r < n && b[r] > b[m]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; [b[m], b[i]] = [b[i], b[m]]; i = m; } } return top; }
}

/* ------------------------------------------------------------------ */
/* measuring                                                           */
/* ------------------------------------------------------------------ */
function measureAll(img, W, H, seg, o) {
  const out = [];
  for (const ob of seg.objs) {
    // table edges and things running off the photo across half of it are background, not pieces
    const edge = ob.x0 <= 1 || ob.y0 <= 1 || ob.x0 + ob.w >= W - 1 || ob.y0 + ob.h >= H - 1;
    if (edge && (ob.w > W * 0.45 || ob.h > H * 0.45)) continue;
    const f = measure(img, W, H, ob, o); if (f) out.push(f);
  }
  return out;
}
function measure(img, W, H, ob, o) {
  const { w, h, m, x0, y0 } = ob; let A = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { A++; sx += x; sy += y; }
  if (!A) return null; const cx = sx / A, cy = sy / A;
  const cont = trace(m, w, h); if (cont.length < 6) return null;
  const hull = convexHull(cont);
  const hullA = polyArea(hull); const rect = minRect(hull);
  let P = 0; for (let i = 0; i < cont.length; i++) { const a = cont[i], b = cont[(i + 1) % cont.length]; P += Math.hypot(a[0] - b[0], a[1] - b[1]); }
  P *= 0.95;
  // colour (true pixels only, holes excluded), and a texture measure
  let r = 0, g = 0, b = 0, n = 0, l2 = 0, l1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!m[y * w + x]) continue; const i = ((y0 + y) * W + x0 + x) * 4; const R = img[i], G = img[i + 1], B = img[i + 2]; r += R; g += G; b += B; n++; const L = 0.299 * R + 0.587 * G + 0.114 * B; l1 += L; l2 += L * L; }
  const lab = rgb2lab(r / n, g / n, b / n); const tex = Math.sqrt(Math.max(0, l2 / n - (l1 / n) ** 2));
  // width profile along the long axis, wide end first
  const ca = Math.cos(rect.ang), sa = Math.sin(rect.ang); const bins = new Float64Array(12);
  let tmin = Infinity, tmax = -Infinity;
  for (const [x, y] of hull) { const t = (x - cx) * ca + (y - cy) * sa; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
  const span = Math.max(1e-6, tmax - tmin);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { const t = ((x - cx) * ca + (y - cy) * sa - tmin) / span; bins[Math.min(11, Math.max(0, Math.floor(t * 12)))]++; }
  let bmax = 0; for (const v of bins) if (v > bmax) bmax = v; let prof = Array.from(bins, (v) => v / (bmax || 1));
  if (prof.slice(0, 6).reduce((a, v) => a + v, 0) < prof.slice(6).reduce((a, v) => a + v, 0)) prof.reverse();
  prof = prof.map((v) => Math.round(v * 1000) / 1000);
  // outline harmonics (rotation invariant) and tooth count
  const fd = harmonics(cont, cx, cy);
  const holes = ob.holes || []; const holeA = holes.reduce((a, x) => a + x.a, 0);
  const edge = x0 <= 1 || y0 <= 1 || x0 + w >= W - 1 || y0 + h >= H - 1;
  const poly = simplify(cont, Math.max(0.8, Math.sqrt(A) / 40)).slice(0, 160);
  return {
    x: x0 + cx, y: y0 + cy, box: [x0, y0, x0 + w, y0 + h], A, L: rect.L, W: rect.W, ang: rect.ang, P,
    sol: Math.min(1, A / (hullA || A)), circ: Math.min(1.2, 4 * Math.PI * A / (P * P)), elong: rect.W / (rect.L || 1),
    holes: holes.length, holeF: holeA / A, hole1: holes.length ? Math.max(...holes.map((x) => x.a)) / A : 0,
    prof, fd: fd.mag, teeth: fd.teeth, teethS: fd.teethS, lab, tex, edge,
    poly: poly.flatMap(([x, y]) => [Math.round((x0 + x) * 10) / 10, Math.round((y0 + y) * 10) / 10]),
  };
}
function trace(m, w, h) {
  // Moore-neighbour boundary tracing of the first object found (the mask holds one piece)
  let s = -1; for (let i = 0; i < w * h; i++) if (m[i]) { s = i; break; } if (s < 0) return [];
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x];
  let x = s % w, y = (s / w) | 0; const sx = x, sy = y; let d = 7; const pts = []; let guard = 0;
  do {
    pts.push([x, y]); let found = false;
    for (let k = 0; k < 8; k++) { const nd = (d + 6 + k) % 8; const nx = x + dirs[nd][0], ny = y + dirs[nd][1]; if (at(nx, ny)) { x = nx; y = ny; d = nd; found = true; break; } }
    if (!found) break;
  } while ((x !== sx || y !== sy) && ++guard < w * h * 4);
  return pts;
}
function convexHull(pts) {
  const p = pts.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  up.pop(); lo.pop(); return lo.concat(up);
}
function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return Math.abs(a) / 2 + p.length * 0.5; }
function minRect(hull) {
  // rotating calipers over hull edges; pixel centres -> add 1 px for full extent
  let best = { area: Infinity, L: 0, W: 0, ang: 0 };
  if (hull.length < 3) return { L: 1, W: 1, ang: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length]; const ang = Math.atan2(b[1] - a[1], b[0] - a[0]); const c = Math.cos(ang), s = Math.sin(ang);
    let mn1 = Infinity, mx1 = -Infinity, mn2 = Infinity, mx2 = -Infinity;
    for (const p of hull) { const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c; if (u < mn1) mn1 = u; if (u > mx1) mx1 = u; if (v < mn2) mn2 = v; if (v > mx2) mx2 = v; }
    const d1 = mx1 - mn1 + 1, d2 = mx2 - mn2 + 1; const ar = d1 * d2;
    if (ar < best.area) best = d1 >= d2 ? { area: ar, L: d1, W: d2, ang } : { area: ar, L: d2, W: d1, ang: ang + Math.PI / 2 };
  }
  return best;
}
function harmonics(cont, cx, cy) {
  // resample the outline by arc length, take the radius signature, DFT magnitudes
  const n = 128; const L = []; let tot = 0; L.push(0);
  for (let i = 1; i <= cont.length; i++) { const a = cont[i - 1], b = cont[i % cont.length]; tot += Math.hypot(a[0] - b[0], a[1] - b[1]); L.push(tot); }
  const r = new Float64Array(n); let j = 0;
  for (let k = 0; k < n; k++) { const t = (k / n) * tot; while (j < cont.length - 1 && L[j + 1] < t) j++; const a = cont[j], b = cont[(j + 1) % cont.length]; const f = (t - L[j]) / ((L[j + 1] - L[j]) || 1); r[k] = Math.hypot(a[0] + (b[0] - a[0]) * f - cx, a[1] + (b[1] - a[1]) * f - cy); }
  let mean = 0; for (const v of r) mean += v; mean /= n; if (!mean) return { mag: new Array(10).fill(0), teeth: 0, teethS: 0 };
  const mag = (m) => { let re = 0, im = 0; for (let k = 0; k < n; k++) { const a = (2 * Math.PI * m * k) / n; re += r[k] * Math.cos(a); im -= r[k] * Math.sin(a); } return Math.hypot(re, im) / (n * mean); };
  const out = []; for (let m = 1; m <= 10; m++) out.push(Math.round(mag(m) * 1000) / 1000);
  let teeth = 0, ts = 0, base = 0, cnt = 0;
  for (let m = 8; m <= 48; m++) { const v = mag(m); base += v; cnt++; if (v > ts) { ts = v; teeth = m; } }
  base /= cnt;
  return { mag: out, teeth: ts > base * 3.5 && ts > 0.012 ? teeth : 0, teethS: Math.round(ts * 1000) / 1000 };
}
function simplify(pts, eps) {
  if (pts.length < 4) return pts;
  // RDP on a closed outline: split at the farthest point from the start
  let far = 0, fd = 0; for (let i = 1; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const rdp = (a) => { if (a.length < 3) return a; const [p, q] = [a[0], a[a.length - 1]]; let md = 0, mi = 0; const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1;
    for (let i = 1; i < a.length - 1; i++) { const d = Math.abs(dy * a[i][0] - dx * a[i][1] + q[0] * p[1] - q[1] * p[0]) / L; if (d > md) { md = d; mi = i; } }
    if (md > eps) return rdp(a.slice(0, mi + 1)).slice(0, -1).concat(rdp(a.slice(mi))); return [p, q]; };
  const a = rdp(pts.slice(0, far + 1)), b = rdp(pts.slice(far).concat([pts[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}
function rgb2lab(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = f(r), G = f(g), B = f(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, y = R * 0.2126 + G * 0.7152 + B * 0.0722, z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const h = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); x = h(x); y = h(y); z = h(z);
  return [Math.round((116 * y - 16) * 10) / 10, Math.round(500 * (x - y) * 10) / 10, Math.round(200 * (y - z) * 10) / 10];
}

/* ------------------------------------------------------------------ */
/* package labels: white paper rectangles (with print on them) that stand out from bags and table */
function findLabels(d, progress) {
  const img = new Uint8ClampedArray(d.rgba); const W = d.W, H = d.H, N = W * H; const o = d.opts || {};
  progress(0.1, 'Looking for labels');
  // paper white: bright and colourless, judged against the brightest part of the photo
  const lum = new Float32Array(N); const samp = [];
  for (let p = 0, i = 0; p < N; p++, i += 4) { const r = img[i], g = img[i + 1], b = img[i + 2]; lum[p] = 0.299 * r + 0.587 * g + 0.114 * b; if ((p & 63) === 0) samp.push(lum[p]); }
  samp.sort((a, b) => a - b); const p97 = samp[Math.floor(samp.length * 0.97)] || 230;
  const tL = Math.max(140, Math.min(215, p97 - 42));
  const m = new Uint8Array(N);
  for (let p = 0, i = 0; p < N; p++, i += 4) { const r = img[i], g = img[i + 1], b = img[i + 2]; const ch = Math.max(r, g, b) - Math.min(r, g, b); if (lum[p] > tL && ch < 34 + (lum[p] - tL) * 0.15) m[p] = 1; }
  let m2 = dilate(m, W, H, 2); m2 = erode(m2, W, H, 2);
  // fill holes (the print: text and barcodes)
  const inv = new Uint8Array(N); for (let p = 0; p < N; p++) inv[p] = m2[p] ? 0 : 1;
  const ci = components(inv, W, H); const touch = new Uint8Array(ci.n + 1), area = new Int32Array(ci.n + 1);
  for (let p = 0; p < N; p++) { const l = ci.lab[p]; if (!l) continue; area[l]++; const x = p % W, y = (p / W) | 0; if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touch[l] = 1; }
  const maxHole = N * 0.004; for (let p = 0; p < N; p++) { const l = ci.lab[p]; if (l && !touch[l] && area[l] < maxHole) m2[p] = 1; }
  progress(0.5, 'Separating labels');
  // a big opening removes thin glare on bags and keeps the solid paper rectangles
  const k = Math.max(4, Math.round(Math.min(W, H) * (o.open || 0.011)));
  let op = erode(m2, W, H, k); op = dilate(op, W, H, k);
  const cc = components(op, W, H); const st = compStats(cc.lab, cc.n, W, H);
  const minA = Math.max(400, N * (o.minFrac || 0.0006)), maxA = N * 0.06; const out = [];
  for (const c of st) {
    if (c.a < minA || c.a > maxA) continue;
    const loc = local(cc.lab, W, c); const cont = trace(loc.own, loc.w, loc.h); if (cont.length < 8) continue;
    const hull = convexHull(cont); const r = minRect(hull); const fill = c.a / (r.L * r.W);
    if (fill < 0.6 || r.W < 12) continue;
    // centre of the rectangle in photo coordinates
    let sx = 0, sy = 0; for (const [x, y] of hull) { sx += x; sy += y; } const ca = Math.cos(r.ang), sa = Math.sin(r.ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity; for (const [x, y] of hull) { const u = x * ca + y * sa, v = -x * sa + y * ca; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const um = (u0 + u1) / 2, vm = (v0 + v1) / 2; let ang = r.ang; while (ang > Math.PI / 2) ang -= Math.PI; while (ang < -Math.PI / 2) ang += Math.PI;
    out.push({ cx: c.x0 + um * ca - vm * sa, cy: c.y0 + um * sa + vm * ca, w: r.L, h: r.W, ang, fill: +fill.toFixed(2), box: [c.x0, c.y0, c.x1 + 1, c.y1 + 1], a: c.a });
  }
  progress(1, 'Done');
  return { out: { labels: out, tL: Math.round(tL), k } };
}

/* ------------------------------------------------------------------ */
/* 3D model silhouettes: what a part looks like from above, lying on each side */
/* ------------------------------------------------------------------ */
function silhouettes(d) {
  const pos = new Float32Array(d.pos); const res = d.res || 6; const out = [];
  for (const ax of [2, 1, 0]) {
    const u = ax === 0 ? 1 : 0, v = ax === 2 ? 1 : 2;
    let mnu = Infinity, mxu = -Infinity, mnv = Infinity, mxv = -Infinity;
    for (let i = 0; i < pos.length; i += 3) { const a = pos[i + u], b = pos[i + v]; if (a < mnu) mnu = a; if (a > mxu) mxu = a; if (b < mnv) mnv = b; if (b > mxv) mxv = b; }
    const pad = 3; const w = Math.ceil((mxu - mnu) * res) + pad * 2, h = Math.ceil((mxv - mnv) * res) + pad * 2;
    if (w * h > 9e6 || w < 3 || h < 3) continue;
    const m = new Uint8Array(w * h);
    for (let t = 0; t < pos.length; t += 9) {
      const P = [0, 1, 2].map((k) => [(pos[t + k * 3 + u] - mnu) * res + pad, (pos[t + k * 3 + v] - mnv) * res + pad]);
      fillTri(m, w, h, P);
    }
    const ob = { x0: 0, y0: 0, w, h, m, holes: [] };
    // holes = background regions enclosed by the silhouette
    const own = m; const lab = new Int32Array(w * h); for (let i = 0; i < w * h; i++) lab[i] = own[i] ? 1 : 0;
    const loc = { w, h, own, filled: null }; ob.holes = fillHoles(loc, lab, w, { x0: 0, y0: 0, id: 1, a: m.reduce((a, b) => a + b, 0) }); ob.m = loc.filled;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const f = measure(rgba, w, h, ob, {}); if (!f) continue;
    delete f.poly; f.lab = null; f.tex = null; f.view = 'xyz'[ax]; f.res = res;
    out.push(f);
  }
  return { out };
}
function fillTri(m, w, h, P) {
  const [a, b, c] = P.slice().sort((p, q) => p[1] - q[1]);
  const y0 = Math.max(0, Math.ceil(a[1] - 0.5)), y1 = Math.min(h - 1, Math.floor(c[1] - 0.5));
  for (let y = y0; y <= y1; y++) {
    const Y = y + 0.5; const xa = interp(a, c, Y); const xb = Y < b[1] ? interp(a, b, Y) : interp(b, c, Y);
    if (xa == null || xb == null) continue; let l = Math.min(xa, xb), r = Math.max(xa, xb);
    const L = Math.max(0, Math.round(l - 0.5)), R = Math.min(w - 1, Math.round(r - 0.5)); for (let x = L; x <= R; x++) m[y * w + x] = 1;
  }
}
function interp(p, q, Y) { if (q[1] === p[1]) return p[0]; const t = (Y - p[1]) / (q[1] - p[1]); if (t < -0.001 || t > 1.001) return null; return p[0] + (q[0] - p[0]) * t; }
