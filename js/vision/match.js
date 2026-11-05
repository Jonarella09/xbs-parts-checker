// Matching pieces to parts: measured sizes and shapes against what each part looks like.
// References come from (1) pieces you confirmed before (learned looks), (2) the 3D model seen from above,
// (3) the size you typed for the part. Unknown pieces are grouped by look so you can name them.
import * as store from '../store.js';
import { parseSTL } from '../stl.js';
import { silhouettes } from './client.js';
import { partById } from '../proj.js';

const KEYS = ['A', 'L', 'W', 'elong', 'sol', 'circ', 'holes', 'holeF', 'hole1', 'prof', 'fd', 'teeth', 'lab', 'tex'];
/** Feature set of a piece in mm (when the scale is known) or pixels. */
export function feat(o, ppm, ppu) {
  // ppm: pixels per mm (known scale). ppu: pixels per "project unit" when there is no mm scale:
  // the unit is the pixel size of the first photo counted without a mat, so photos can still be compared.
  const f = { mm: !!ppm };
  for (const k of KEYS) if (o[k] != null) f[k] = o[k];
  if (o.L && o.W && o.A) f.fill = o.A / (o.L * o.W);
  if (ppm) { f.A = o.A / (ppm * ppm); f.L = o.L / ppm; f.W = o.W / ppm; }
  else if (ppu) { f.rel = true; f.A = o.A / (ppu * ppu); f.L = o.L / ppu; f.W = o.W / ppu; }
  return f;
}
/** In a photo, outlines grow a little: blur (a fixed number of pixels) and soft shadows (more for taller parts).
    Model and size references are grown the same way before comparing: g = b0/ppm + k × height. */
export function grownRefs(refs, ppm, grow) {
  if (!ppm || !grow) return refs;
  return refs.map((r) => {
    if (r.kind === 'ex' || !r.f.L) return r;
    const g = grow.b0 / ppm + grow.k * (r.h || 0); const L = r.f.L + g, W = r.f.W + g; const A = (r.f.A || r.f.L * r.f.W * 0.8) + g * (r.f.L + r.f.W);
    return Object.assign({}, r, { f: Object.assign({}, r.f, { L, W, A, fill: A / (L * W), elong: W / L }) });
  });
}
const l2 = (a, b, n) => { let s = 0; const m = Math.min(n || a.length, a.length, b.length); for (let i = 0; i < m; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s / Math.max(1, m)) * Math.sqrt(m / 6); };
const dE = (a, b) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * 1.2, (a[2] - b[2]) * 1.2);

/** Distance between a piece and a reference: about 1 means "same part, within measuring noise". */
export function dist(o, r, { size = true, sizeW = 1, shapeOnly = false } = {}) {
  let s = 0, ws = 0, big = 0; const add = (d, w) => { s += w * d * d; ws += w; };
  if (size && !shapeOnly && o.mm === r.mm && !!o.rel === !!r.rel && o.L && r.L) {
    const dl = Math.log(o.L / r.L) / 0.075, dw = Math.log(o.W / r.W) / 0.13; add(dl, 2.2 * sizeW); add(dw, 1.4 * sizeW);
    big = Math.max(Math.abs(dl), Math.abs(dw));
    if (o.A && r.A) { const da = Math.log(o.A / r.A) / 0.17; add(da, 1.2 * sizeW); big = Math.max(big, Math.abs(da)); }
  }
  if (o.elong != null && r.elong != null) add((o.elong - r.elong) / 0.09, 1.1);
  if (o.fill != null && r.fill != null) add((o.fill - r.fill) / 0.09, r.prior ? 1.0 : 0.6);
  if (o.sol != null && r.sol != null) add((o.sol - r.sol) / 0.08, 0.8);
  if (o.circ != null && r.circ != null) add((o.circ - r.circ) / 0.13, 0.5);
  if (r.holes != null && o.holes != null && !r.noHoles) { add((Math.min(o.holes, 4) - Math.min(r.holes, 4)) / 1.0, r.prior ? 0.5 : 1); add((o.holeF - r.holeF) / 0.07, r.prior ? 0.3 : 0.6); }
  if (r.prof && o.prof) add(l2(o.prof, r.prof) / 0.32, 0.8);
  if (r.fd && o.fd) add(l2(o.fd, r.fd, 8) / 0.1, 0.7);
  if (r.teeth != null && o.teeth != null && (o.teeth || r.teeth) && !r.prior) add(o.teeth && r.teeth ? (o.teeth - r.teeth) / 2 : 1.5, 0.7);
  if (o.lab && r.lab && !shapeOnly) add(dE(o.lab, r.lab) / 15, 1.3);
  // a clear size difference isn't averaged away by many shape features that agree
  return ws ? Math.max(Math.sqrt(s / ws), 0.72 * big * Math.sqrt(sizeW)) : 9;
}

/* ---------- references ---------- */
let silBusy = null;
/** Make sure every part with a 3D model has its top-view silhouettes measured (cached in the project). */
export async function ensureSilhouettes(onProgress) {
  if (silBusy) return silBusy;
  silBusy = (async () => {
    const p = store.project(); const todo = p.parts.filter((t) => t.model && t.model.file && !t.model.sil);
    let i = 0;
    for (const t of todo) {
      onProgress && onProgress(i++ / todo.length, `Reading the shape of ${t.name}`);
      try { const b = await store.fileBlob(t.model.file); if (!b) continue; const stl = parseSTL(await b.arrayBuffer()); const sil = await silhouettes(stl.pos);
        const res = 6; const v = sil.map((f) => ({ mm: true, prior: true, view: f.view, A: f.A / (res * res), L: f.L / res, W: f.W / res, elong: f.elong, sol: f.sol, circ: f.circ, holes: f.holes, holeF: f.holeF, hole1: f.hole1, prof: f.prof, fd: f.fd, teeth: f.teeth }));
        store.change((q) => { const x = partById(q, t.id); if (x && x.model) x.model.sil = v; }, { quiet: true });
      } catch (e) { console.warn('silhouette', t.name, e); }
    }
  })();
  try { await silBusy; } finally { silBusy = null; }
}
export function refsFor(p) {
  const R = [];
  for (const t of p.parts) {
    const ex = p.vision.examples[t.id] || [];
    for (const f of ex) R.push({ part: t.id, f, kind: 'ex' });
    if (t.model && t.model.sil) {
      // only poses a piece can rest in on a table: low enough compared with its flattest side
      const sz = t.model.size || [1, 1, 1]; const hmin = Math.min(...sz);
      for (const f of t.model.sil) {
        const h = sz['xyz'.indexOf(f.view)]; if (h != null && h > 1.55 * hmin + 0.5) continue;
        R.push({ part: t.id, h: h || 0, f: { mm: true, prior: true, view: f.view, A: f.A, L: f.L, W: f.W, elong: f.elong, fill: f.A / (f.L * f.W) }, kind: 'model' });
      }
    }
    else if (t.dims && t.dims.l > 0 && t.dims.w > 0) {
      const views = [[t.dims.l, t.dims.w]]; if (t.dims.h > 0 && Math.abs(t.dims.h - t.dims.w) / t.dims.w > 0.25) views.push([t.dims.l, t.dims.h]);
      for (const [L, W] of views) R.push({ part: t.id, h: t.dims.h > 0 ? Math.min(t.dims.h, W) : W * 0.5, f: { mm: true, prior: true, L, W, elong: W / L }, kind: 'dims' });
    }
  }
  return R;
}
export const hasRefs = (p) => refsFor(p).length > 0;

/* ---------- scale ---------- */
/** Estimate px per mm from pieces whose shape matches a part with known size. */
export function estimateScale(objs, refs, fixedPpm, { rel = false } = {}) {
  const mmRefs = refs.filter((r) => (rel ? r.f.rel : r.f.mm) && r.f.L > 0); if (!mmRefs.length || objs.length < 2) return null;
  const F = (o, s) => (rel ? feat(o, null, s) : feat(o, s));
  const lo = Math.log(rel ? 0.1 : 0.3), hi = Math.log(rel ? 10 : 80), B = 300; const hist = new Float64Array(B); const cands = [];
  for (const o of objs) {
    if (o.edge) continue; const f = feat(o, null);
    let best = null;
    for (const r of mmRefs) {
      const d = dist(f, r.f, { shapeOnly: true }); if (d > 1.1) continue;
      const s = o.L / r.f.L; const s2 = o.W / r.f.W; if (Math.abs(Math.log(s2 / s)) > 0.3) continue;
      if (!best || d < best.d) best = { d, s };
    }
    if (best) { const w = 1 / (0.25 + best.d); cands.push({ s: best.s, w }); const k = Math.floor(((Math.log(best.s) - lo) / (hi - lo)) * B); if (k >= 0 && k < B) hist[k] += w; }
  }
  if (cands.length < 3) return null;
  // candidate scales: the strongest peaks of the vote histogram
  const sm = new Float64Array(B); for (let k = 1; k < B - 1; k++) sm[k] = hist[k - 1] + hist[k] + hist[k + 1];
  const peaks = []; for (let k = 1; k < B - 1; k++) if (sm[k] > 0 && sm[k] >= sm[k - 1] && sm[k] >= sm[k + 1]) peaks.push(k);
  peaks.sort((a, b) => sm[b] - sm[a]);
  // score each candidate with sizes included: how many pieces match some part well at that scale
  const sample = objs.filter((o) => !o.edge).slice(0, 400);
  const score = (s, g) => { const R = rel ? mmRefs : grownRefs(mmRefs, s, g); let t = 0, n = 0; for (const o of sample) { const f = F(o, s); let best = 9; for (const r of R) { const d = dist(f, r.f); if (d < best) best = d; } t += Math.exp(-(best * best) / 2); if (best < 1.2) n++; } return { t, n }; };
  const fitGrow = (s) => { let b = null; for (const b0 of rel ? [0] : [0, 1, 2, 3, 4, 5.5]) for (const k of rel ? [0] : [0, 0.08, 0.16, 0.25, 0.35, 0.5]) { const g = { b0, k }; const sc = score(s, g); if (!b || sc.t > b.t) b = { g, t: sc.t, n: sc.n }; } return b; };
  let best = null; const G0 = { b0: 2, k: 0.15 };
  if (fixedPpm) { const g = fitGrow(fixedPpm); best = { s: fixedPpm, g: g.g, t: g.t, n: g.n }; }
  else {
    for (const k of peaks.slice(0, 6)) { const s0 = Math.exp(lo + ((k + 0.5) / B) * (hi - lo)); for (let j = -12; j <= 6; j++) { const s = s0 * Math.exp(j * 0.012); const sc = score(s, G0); if (!best || sc.t > best.t) best = { s, g: G0, t: sc.t, n: sc.n }; } }
    if (best) for (let it = 0; it < 2; it++) {
      const g = fitGrow(best.s); best = Object.assign(best, { g: g.g, t: g.t, n: g.n });
      const step = it ? 0.003 : 0.008; for (let j = -8; j <= 8; j++) { if (!j) continue; const s = best.s * Math.exp(j * step); const sc = score(s, best.g); if (sc.t > best.t) best = Object.assign(best, { s, t: sc.t, n: sc.n }); }
    }
  }
  if (!best || best.n < Math.max(3, sample.length * 0.1)) return null;
  return { ppm: best.s, grow: rel ? null : best.g, support: best.n };
}

/* ---------- classification ---------- */
/** Best guesses for every piece. Returns items: {part, d, conf, alts, st, n}. */
export function classify(objs, refs, ppm, opts = {}) {
  const T_ASSIGN = opts.tAssign || 1.75, T_SURE = opts.tSure || 0.9;
  refs = grownRefs(refs, ppm, opts.grow); const ppu = opts.ppu || null;
  const out = [];
  for (const o of objs) {
    const f = feat(o, ppm, ppu); const per = new Map();
    for (const r of refs) {
      const useSize = (!!ppm && r.f.mm) || (!ppm && !!ppu && !!r.f.rel) || (!r.f.mm && !r.f.rel && !r.f.L);
      let d = dist(f, r.f, { size: useSize });
      if (r.kind === 'dims') d = Math.max(d, 0.6) * 1.1; else if (r.kind === 'model') d *= 1.08;
      if (!useSize && r.f.L) d = d * 1.25 + 0.3;
      const cur = per.get(r.part); if (cur == null || d < cur.d) per.set(r.part, { d, kind: r.kind });
    }
    const ranked = [...per.entries()].map(([part, x]) => ({ part, d: x.d, kind: x.kind })).sort((a, b) => a.d - b.d);
    const best = ranked[0]; const second = ranked[1];
    const item = { f, alts: ranked.slice(0, 5).map((x) => ({ part: x.part, d: +x.d.toFixed(3) })) };
    // learned looks are precise: something clearly different from all of them stays unknown (and gets grouped)
    const tA = best && best.kind === 'ex' ? Math.min(T_ASSIGN, 1.3) : T_ASSIGN;
    if (best && best.d <= tA) {
      const margin = second ? second.d / Math.max(0.05, best.d) : 3;
      item.part = best.part; item.d = best.d;
      item.conf = Math.max(0.05, Math.min(0.99, (1 - best.d / (T_ASSIGN * 1.15)) * Math.min(1, (margin - 1) / 0.6 + 0.35)));
      item.st = best.d <= T_SURE && margin >= 1.25 && !o.edge ? 'auto' : 'check';
      if (o.edge) item.why = 'Cut off by the edge of the photo';
      else if (item.st === 'check') item.why = margin < 1.25 ? 'Close to another part' : 'Doesn’t match well';
    } else { item.part = null; item.st = 'unknown'; item.conf = 0; item.why = refs.length ? 'Doesn’t match any part' : 'No parts to compare with'; }
    out.push(item);
  }
  if (ppm) clusters(objs, out, refs);
  return out;
}
/** Pieces that look like two or more of a part touching: estimate how many. */
function clusters(objs, items, refs) {
  const typ = new Map();
  items.forEach((it) => { if (it.part && it.st === 'auto') { const a = typ.get(it.part) || []; a.push(it.f.A); typ.set(it.part, a); } });
  for (const r of refs) if (!typ.has(r.part) && r.f.A) typ.set(r.part, [r.f.A]);
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  items.forEach((it, i) => {
    if (it.st === 'auto' || !it.f.A) return;
    let best = null;
    for (const [part, as] of typ) {
      const A1 = med(as); const ratio = it.f.A / A1; const n = Math.round(ratio);
      if (n < 2 || n > 30 || Math.abs(ratio - n) > 0.28 * Math.sqrt(n)) continue;
      const exs = refs.filter((r) => r.part === part && r.f.lab); const col = exs.length && it.f.lab ? Math.min(...exs.map((r) => dE(it.f.lab, r.f.lab))) : 10;
      if (col > 22) continue;
      const score = Math.abs(ratio - n) / n + col / 60 + (it.f.sol > 0.9 ? 0.15 : 0);
      if (!best || score < best.score) best = { part, n, score };
    }
    if (best && (!it.part || it.d > 1.1)) { it.part = best.part; it.n = best.n; it.st = 'check'; it.why = `Looks like ${best.n} pieces touching`; it.cluster = true; }
    void objs[i];
  });
}

/* ---------- grouping unknown pieces ---------- */
export function group(objs, items, ppm, { thr = 0.9 } = {}) {
  const idx = items.map((it, i) => i).filter((i) => !items[i].part && items[i].st !== 'gone');
  const F = idx.map((i) => feat(objs[i], ppm)); const n = idx.length; const par = idx.map((_, i) => i);
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { if (dist(F[a], F[b]) < thr) { const x = find(a), y = find(b); if (x !== y) par[Math.max(x, y)] = Math.min(x, y); } }
  const groups = new Map(); for (let a = 0; a < n; a++) { const r = find(a); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(a); }
  // split groups that chained across clearly different lengths
  const final = [];
  for (const g of groups.values()) {
    if (g.length < 4) { final.push(g); continue; }
    const s = g.slice().sort((a, b) => F[a].L - F[b].L); let cut = -1, gap = 0;
    for (let k = 1; k < s.length; k++) { const r = Math.log(F[s[k]].L / F[s[k - 1]].L); if (r > gap) { gap = r; cut = k; } }
    if (gap > 0.12 && cut >= 2 && s.length - cut >= 2) { final.push(s.slice(0, cut)); final.push(s.slice(cut)); } else final.push(g);
  }
  final.sort((a, b) => b.length - a.length);
  const names = []; final.forEach((g, k) => { const id = 'g' + (k + 1); names.push({ id, n: g.length, name: 'Group ' + letters(k) }); for (const a of g) items[idx[a]].grp = id; });
  return names;
}
export const letters = (k) => { let s = ''; k++; while (k > 0) { k--; s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26); } return s; };

/* ---------- quick count: everything like this one ---------- */
export function similarTo(objs, ppm, exIdx, thr) {
  const ex = exIdx.map((i) => feat(objs[i], ppm)); const res = [];
  const Aex = ex.reduce((a, f) => a + f.A, 0) / ex.length;
  objs.forEach((o, i) => {
    const f = feat(o, ppm); const d = Math.min(...ex.map((e) => dist(f, e, { sizeW: 1.3 })));
    if (d <= thr) { res.push({ i, n: 1, d }); return; }
    const ratio = f.A / Aex; const n = Math.round(ratio);
    if (n >= 2 && n <= 40 && Math.abs(ratio - n) <= 0.3 * Math.sqrt(n)) {
      const col = f.lab && ex[0].lab ? dE(f.lab, ex[0].lab) : 0; const sh = dist(f, ex[0], { shapeOnly: true });
      if (col < 14 && (sh < 3.5 || f.sol < 0.85)) res.push({ i, n, d, est: true });
    }
  });
  return res;
}

/* ---------- learning ---------- */
const COMPACT = ['mm', 'rel', 'A', 'L', 'W', 'elong', 'fill', 'sol', 'circ', 'holes', 'holeF', 'hole1', 'prof', 'fd', 'teeth', 'lab', 'tex'];
export function compact(f) { const o = {}; for (const k of COMPACT) if (f[k] != null) o[k] = Array.isArray(f[k]) ? f[k].map((v) => Math.round(v * 1000) / 1000) : typeof f[k] === 'number' ? Math.round(f[k] * 1000) / 1000 : f[k]; return o; }
/** Remember what a confirmed piece looks like. Keeps up to 40 varied examples per part. */
export function learn(p, partId, f) {
  if (!partId || !f) return false;
  // sizes are kept in mm (mat or known scale) or in project units (photos without a scale); else shape and colour only
  const g = f.mm || f.rel ? f : Object.assign({}, f, { A: null, L: null, W: null });
  const ex = p.vision.examples[partId] || (p.vision.examples[partId] = []);
  if (ex.some((e) => e.mm === g.mm && !!e.rel === !!g.rel && dist(g, e) < 0.22)) return false;
  ex.push(compact(g)); if (ex.length > 40) ex.splice(0, ex.length - 40);
  return true;
}
