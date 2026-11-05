// Reading a table full of packages: find every line of text in the photo, group the lines into labels,
// read them, and pull out part number, name and pieces per package. Labels that look alike are checked
// against each other so one blurry character doesn't create a new part.
import * as pp from './ppocr.js';

const SKU_RE = /(?:SKU|P\/?N|PART\s*(?:NO|#)?|ITEM)\s*[:#.]?\s*([A-Z0-9][A-Z0-9.\-]{3,}[A-Z0-9])/i;
const GB_RE = /([0-9OQDILSBZ]{4})\s*[-–—_.:]?\s*([0-9OQDILSBZ]{4})\s*[-–—_.:]?\s*([0-9OQDILSBZ]{4})/i;
const GB_LOOSE = /([0-9OQDILSBZ]{3,4})\s*[-–—_.:]\s*([0-9OQDILSBZ]{3,4})\s*[-–—_.:]\s*([0-9OQDILSBZ]{3,5})/i;
const DIG = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };
const digits = (s) => s.toUpperCase().replace(/[OQDILSBZ]/g, (c) => DIG[c]);

/** Pull the part number, quantity and name out of a label's lines (top to bottom). */
const asciiText = (t) => String(t || '').replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[‐‑‒–—―−·•]/g, '-').replace(/\u3000/g, ' ');
export function parseLines(lines0) {
  const lines = lines0.map((l) => Object.assign({}, l, { text: asciiText(l.text) }));
  const txt = lines.map((l) => l.text).join('\n');
  const out = { partNo: '', partConf: 0, qty: null, name: '', size: '', skuLine: -1 };
  // goBILDA-style 4-4-4 numbers first, then "SKU: ..." style, then REV / AndyMark
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].text.match(GB_RE) || lines[i].text.match(GB_LOOSE);
    if (m && /\d/.test(m[1]) && /\d{2}/.test(digits(m[0]))) { const v = [m[1], m[2], m[3]].map(digits).join('-'); if (/^\d{3,4}-\d{3,4}-\d{3,5}$/.test(v)) { out.partNo = v; out.loose = !/^\d{4}-\d{4}-\d{4}$/.test(v); out.partConf = lineConf(lines[i], m.index, m[0].length); out.skuLine = i; break; } }
  }
  if (!out.partNo) {
    const m = txt.match(/\b(FTC-?[A-Za-z]+-?\d+(?:\.\d+)?)\b/) || txt.match(SKU_RE) || txt.match(/\bREV-\d{2}-\d{4}(?:-[A-Z0-9]+)?\b/i) || txt.match(/\bam-\d{3,5}[a-z]?\b/i);
    if (m) { out.partNo = (m[1] || m[0]).replace(/[.\-]+$/, '').toUpperCase(); out.partConf = 0.7; out.skuLine = lines.findIndex((l) => l.text.includes((m[1] || m[0]).slice(0, 4))); }
  }
  const q = txt.match(/[-–(·.\s]\s*(\d{1,4})\s*[-\s]?(?:PACK|PAK|PACH|PCK|PMOK|PK|PCS|PC|PIECES|PA)(?![A-Z]{3})/i) || txt.match(/[-(]\s*(\d{1,4})\s*-?\s*P[aeosc][a-z]{1,3}\b/i) || txt.match(/[-–(]\s*(\d{1,4})\s*[-\s]?(?:PACK|PK|PCS|PC|PIECES)\b/i) || txt.match(/\b(?:PACK\s*OF|QTY|QUANTITY)\s*[:.]?\s*(\d{1,4})\b/i) || txt.match(/\b(\d{1,4})\s*(?:PACK|PCS)\b/i) || txt.match(/\((\d{1,3})-\1\)/);
  if (q && +q[1] > 0 && +q[1] < 5000) out.qty = +q[1];
  const sz = txt.match(/\bM\d(?:\.\d)?\s?[x×]\s?\d+(?:\.\d+)?\s?mm\b/i); if (sz) out.size = sz[0].replace(/\s+/g, ' ');
  // name: the description lines right under the part number, without the pack size and legal small print
  const after = lines.slice(out.skuLine + 1).map((l) => l.text.trim()).filter((t) => t.length > 3 && !/registered|trademark|warning|choking|made in|cancer|p65|robotzone|gobilda.*logo/i.test(t));
  let name = after.slice(0, 2).join(' ');
  if (!name) name = lines.filter((_, i) => i !== out.skuLine).map((l) => l.text).sort((a, b) => b.length - a.length)[0] || '';
  name = name.replace(/\s*[-–]\s*\d{1,4}\s*[-\s]?(?:pack|pk|pcs)\b.*$/i, '').replace(/^(?:SKU|Shaft)?\s*[:.]\s*/i, '').replace(/\s{2,}/g, ' ').trim();
  out.name = fixWords(name).slice(0, 90);
  return out;
}
function lineConf(line, start, len) {
  if (!line.chars || !line.chars.length) return line.conf || 0;
  // the lowest character probability inside the matched part number
  let i = 0, pos = 0, mn = 1; for (const c of line.chars) { if (pos >= start && pos < start + len && /[0-9A-Z]/i.test(c.ch)) mn = Math.min(mn, c.p); pos += c.ch.length; i++; }
  return mn;
}

/** Group text lines into labels. regions: white label rectangles from the photo engine. */
function groupLines(lines, regions) {
  const groups = regions.map((r) => ({ r, lines: [] }));
  const inRot = (r, x, y, grow) => { const c = Math.cos(-r.ang), s = Math.sin(-r.ang); const dx = x - r.cx, dy = y - r.cy; const u = dx * c - dy * s, v = dx * s + dy * c; return Math.abs(u) <= (r.w / 2) * grow && Math.abs(v) <= (r.h / 2) * grow; };
  const loose = [];
  for (const l of lines) {
    let best = null; for (const g of groups) if (inRot(g.r, l.cx, l.cy, 1.08)) { const d = Math.hypot(g.r.cx - l.cx, g.r.cy - l.cy); if (!best || d < best.d) best = { g, d }; }
    if (best) best.g.lines.push(l); else loose.push(l);
  }
  // lines outside any white rectangle: cluster neighbours (labels under glare, coloured labels)
  const used = new Set();
  for (let i = 0; i < loose.length; i++) {
    if (used.has(i)) continue; const cl = [loose[i]]; used.add(i);
    for (let k = 0; k < cl.length; k++) for (let j = 0; j < loose.length; j++) { if (used.has(j)) continue; const a = cl[k], b = loose[j]; const lh = Math.max(a.h, b.h);
      if (Math.abs(a.cy - b.cy) < lh * 2.6 && Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + lh * 1.5) { cl.push(b); used.add(j); } }
    if (cl.length >= 1) groups.push({ r: null, lines: cl });
  }
  return groups.filter((g) => g.lines.length);
}
/** A label holding two part numbers (two labels read as one): split it at the part-number lines. */
function splitMulti(group) {
  const L = group.lines.slice().sort((a, b) => a.cy - b.cy); const idx = [];
  L.forEach((l, i) => { if (GB_RE.test(l.text) && /\d{3}/.test(digits(l.text))) idx.push(i); });
  if (idx.length < 2) return [Object.assign(group, { lines: L })];
  const parts = idx.map(() => []);
  L.forEach((l) => { let best = 0, bd = Infinity; idx.forEach((k, j) => { const d = l.cy >= L[k].cy - L[k].h * 3.5 ? Math.abs(l.cy - L[k].cy) + (l.cy < L[k].cy ? L[k].h * 2 : 0) : Infinity; if (d < bd) { bd = d; best = j; } }); parts[best].push(l); });
  return parts.filter((p) => p.length).map((p) => ({ r: null, lines: p }));
}

/** One edit away (same length, one character different)? Returns the index, or -1. */
const oneOff = (a, b) => { if (a.length !== b.length || a === b) return -1; let d = -1; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (d >= 0) return -1; d = i; } return d; };
/** Fix single-character misreads: only where the reader itself was unsure of that character, snap to a
    part number read more often in this photo or one the project already knows. */
export function consensus(pkgs, known = []) {
  const cnt = {}; for (const k of pkgs) if (k.partNo) cnt[k.partNo] = (cnt[k.partNo] || 0) + 1;
  for (const k of pkgs) {
    if (!k.partNo || !k.charP) continue; let best = null;
    for (const cand of new Set([...Object.keys(cnt), ...known])) {
      const i = oneOff(k.partNo, cand); if (i < 0) continue;
      const p = k.charP[i] == null ? 1 : k.charP[i]; if (p > 0.82) continue;
      const w = (cnt[cand] || 0) + (known.includes(cand) ? 3 : 0);
      // a much more common reading, or (when the reader was quite unsure) any other reading
      if ((w >= (cnt[k.partNo] || 0) + 1 || (p < 0.8 && w >= cnt[k.partNo])) && (!best || w > best.w)) best = { cand, w };
    }
    if (best) { k.readAs = k.partNo; k.partNo = best.cand; k.fixed = true; }
  }
  return pkgs;
}

const rectOf = (r, gx = 1, gy = 1) => { const ex = (Math.abs(r.w * Math.cos(r.ang)) + Math.abs(r.h * Math.sin(r.ang))) / 2, ey = (Math.abs(r.w * Math.sin(r.ang)) + Math.abs(r.h * Math.cos(r.ang))) / 2; return [r.cx - ex * gx, r.cy - ey * gy, r.cx + ex * gx, r.cy + ey * gy]; };
const clip = (b, W, H) => { const x0 = Math.max(0, b[0]), y0 = Math.max(0, b[1]), x1 = Math.min(W, b[2]), y1 = Math.min(H, b[3]); return [x0, y0, x1 - x0, y1 - y0]; };
/** Read the part-number line several times with different margins and vote character by character. */
async function rereadSku(canvas, line, first) {
  const reads = []; if (first) reads.push(first);
  for (const [pad, vy] of [[0.04, 1], [0.14, 1], [0.24, 1], [0.12, 1.3]]) {
    const r = await pp.recognize(canvas, Object.assign({}, line, { h: line.h * vy }), { pad }); const m = r.text.match(GB_RE); if (!m) continue;
    const v = [m[1], m[2], m[3]].map(digits).join('-'); if (/^\d{4}-\d{4}-\d{4}$/.test(v)) reads.push({ v, cp: charProbs(r, m) });
  }
  if (!reads.length) return null;
  const v = [], cp = [];
  for (let i = 0; i < 14; i++) { const votes = {}; for (const r of reads) votes[r.v[i]] = (votes[r.v[i]] || 0) + r.cp[i]; const [ch, w] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]; v.push(ch); cp.push(Math.min(1, w / reads.length)); }
  return { v: v.join(''), cp, mn: Math.min(...cp), n: reads.length };
}
function charProbs(r, m) {
  // probability of each of the 12 digits of a 4-4-4 number, in order
  const out = []; let pos = 0; const start = m.index, end = m.index + m[0].length;
  for (const c of r.chars || []) { if (pos >= start && pos < end && /[0-9A-Z]/i.test(c.ch)) out.push(c.p); pos += c.ch.length; }
  // keep 14 slots aligned with the "dddd-dddd-dddd" string (dashes count as sure)
  const slots = []; let k = 0; for (let i = 0; i < 14; i++) { if (i === 4 || i === 9) slots.push(1); else slots.push(out[k++] == null ? 1 : out[k - 1]); }
  return slots;
}

/**
 * Scan a photo of packages. canvas: the full photo. Returns packages:
 * {cx, cy, box:[x0,y0,x1,y1], lines, partNo, partConf, qty, name, size}
 */
export async function scanLabels(canvas, opts = {}) {
  const { onProgress, known = [] } = opts; const say = (f, t) => onProgress && onProgress(f, t);
  const W = canvas.width, H = canvas.height;
  await pp.load((f, t) => say(0.04 + f * 0.12, t));
  // 1. regions to read: every white label rectangle, a bit bigger so cut-off labels are read whole
  const regions = (opts.whiteLabels || []).map((r) => ({ src: 'label', b: rectOf(r, 1.22, 1.3) }));
  // 2. text the label finder missed (glare, coloured labels): a quick look for text over the whole photo
  if (opts.sweep !== false) {
    const T = 1500, O = 300, sc = opts.sweepScale || 1.0; const tiles = [];
    for (let y = 0; y < H; y += T - O) { for (let x = 0; x < W; x += T - O) { tiles.push([x, y, Math.min(T, W - x), Math.min(T, H - y)]); if (x + T >= W) break; } if (y + T >= H) break; }
    const stray = [];
    for (let i = 0; i < tiles.length; i++) {
      say(0.16 + (0.14 * i) / tiles.length, `Looking for text the label finder missed (${i + 1} of ${tiles.length})`);
      const bx = await pp.detect(canvas, tiles[i], { scale: sc, maxSide: 2000, boxThresh: 0.55 });
      for (const q of bx) { if (q.h < 4 || q.w < q.h * 2.5) continue; if (regions.some((r) => q.cx > r.b[0] && q.cx < r.b[2] && q.cy > r.b[1] && q.cy < r.b[3])) continue; stray.push(q); }
    }
    // cluster stray lines into label-sized regions
    const used = new Set();
    for (let i = 0; i < stray.length; i++) {
      if (used.has(i)) continue; const cl = [stray[i]]; used.add(i);
      for (let k = 0; k < cl.length; k++) for (let j = 0; j < stray.length; j++) { if (used.has(j)) continue; const a = cl[k], b = stray[j]; const lh = Math.max(a.h, b.h); if (Math.abs(a.cy - b.cy) < lh * 3 && Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + lh * 2) { cl.push(b); used.add(j); } }
      if (cl.length < 2) continue;
      let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const q of cl) { const r = rectOf(q, 1, 1); b = [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])]; }
      const pw = (b[2] - b[0]) * 0.15, ph = (b[3] - b[1]) * 0.3; regions.push({ src: 'text', b: [b[0] - pw, b[1] - ph, b[2] + pw, b[3] + ph] });
    }
  }
  // 3. read each region closely (enlarged 3x), split regions that hold two labels
  const pkgs = [];
  for (let i = 0; i < regions.length; i++) {
    say(0.3 + (0.66 * i) / regions.length, `Reading label ${i + 1} of ${regions.length}`);
    const rc = clip(regions[i].b, W, H); if (rc[2] < 12 || rc[3] < 8) continue;
    const scale = Math.max(1.5, Math.min(4, 900 / Math.max(rc[2], rc[3]) * 1.6));
    const lines = (await pp.readRegion(canvas, rc, { scale, maxSide: 2200 })).filter((l) => l.conf > 0.4);
    for (const g of splitMulti({ r: null, lines })) {
      const L = g.lines; const info = parseLines(L);
      if (!info.partNo && (regions[i].src === 'text' || L.map((l) => l.text).join('').length < 6)) continue;
      if (info.skuLine >= 0 && /^\d{3,4}-\d{3,4}-\d{3,5}$/.test(info.partNo)) {
        const sl = L[info.skuLine]; const m0 = sl.text.match(GB_RE);
        const first = m0 && !info.loose ? { v: [m0[1], m0[2], m0[3]].map(digits).join('-'), cp: charProbs(sl, m0) } : null;
        const rr = await rereadSku(canvas, sl, first);
        if (rr) { info.partNo = rr.v; info.charP = rr.cp; info.partConf = rr.mn; info.loose = false; }
        info.at = [sl.cx, sl.cy, sl.w, sl.h];
      }
      if (info.loose) continue; // a part number we couldn't read whole
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of L) { const r = rectOf(l, 1.15, 1.6); x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[2]); y1 = Math.max(y1, r[3]); }
      pkgs.push(Object.assign({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, box: [Math.max(0, x0), Math.max(0, y0), Math.min(W, x1), Math.min(H, y1)].map(Math.round), lines: L.map((l) => ({ text: l.text, conf: +l.conf.toFixed(2) })), text: L.map((l) => l.text).join('\n') }, info));
    }
  }
  // 4. the same label read from two overlapping regions: keep one (the one read best)
  const keep = [];
  for (const k of pkgs.sort((a, b) => (b.partConf || 0) - (a.partConf || 0))) {
    const dup = keep.find((q) => (q.at && k.at ? Math.abs(q.at[0] - k.at[0]) < Math.max(q.at[2], k.at[2]) * 0.5 && Math.abs(q.at[1] - k.at[1]) < Math.max(q.at[3], k.at[3]) * 1.2 : overlap(q.box, k.box) > 0.6));
    if (!dup) keep.push(k);
  }
  consensus(keep, known);
  shareInfo(keep);
  seriesQty(keep);
  say(1, `Read ${keep.length} labels`);
  return keep.sort((a, b) => Math.round(a.cy / 140) - Math.round(b.cy / 140) || a.cx - b.cx);
}
function overlap(a, b) { const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); const i = iw * ih; return i / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])); }

/** Labels with the same part number say the same thing: share the quantity (most common) and the clearest name. */
function shareInfo(pkgs) {
  const by = {}; for (const k of pkgs) if (k.partNo) (by[k.partNo] = by[k.partNo] || []).push(k);
  for (const list of Object.values(by)) {
    const q = {}; for (const k of list) if (k.qty) q[k.qty] = (q[k.qty] || 0) + 1;
    // "25 Pack" read as "2 Pack": a reading that starts the same but is longer wins its votes
    for (const a of Object.keys(q)) for (const b of Object.keys(q)) if (b.length > a.length && b.startsWith(a) && q[a]) { q[b] += q[a]; q[a] = 0; }
    const qty = Object.entries(q).sort((a, b) => b[1] - a[1])[0];
    const nameScore = (k) => { const t = k.name || ''; const words = (t.match(/[A-Za-z]{3,}/g) || []).length; const conf = k.lines.reduce((a, l) => a + l.conf, 0) / Math.max(1, k.lines.length); return words * conf - (t.match(/[^\x20-\x7E]/g) || []).length * 2; };
    const best = list.slice().sort((a, b) => nameScore(b) - nameScore(a))[0];
    for (const k of list) { if (qty && +qty[1] > 0) { if (k.qty !== +qty[0]) k.qtyShared = true; k.qty = +qty[0]; } if (best.name) k.name = best.name; }
  }
}

/* ---- tidy up names read from small print: fix words to the nearest common hardware word ---- */
const VOCAB = ('Series Zinc Plated Steel Stainless Aluminum Socket Head Screw Button Flat Countersunk Nylon Insert Locknut Lock Nut Hex Length Washer Shim Spacer Standoff ' +
  'Bearing Flanged Plate Pitch Chain Sprocket Bore Tooth Teeth Servo Shaft Hub Clamping Bracket Channel Pattern Mount Gear Pinion Spur Bevel Set Programmer Dual Mode Thickness ' +
  'Premium Thread Threaded Locking Drop Center Plastic Links Black Pack Starter Kit Bundle Motor Encoder Wheel Mecanum Omni Belt Pulley Collar Coupler Rod Tube Grid Beam ' +
  'Drive Motion Ball Shoulder Bushing Sleeve Thrust Battery Cable Extension Connector Switch Spring Bolt Rivet Clip Pin Key Male Female Round Square Long Short Large Small ' +
  'Robotics REX Hyper Torque Speed Goal Field Element').split(' ');
const VLOW = VOCAB.map((w) => w.toLowerCase());
function ed(a, b) { const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 9; const d = Array.from({ length: m + 1 }, (_, i) => [i]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
export function fixWords(t) {
  return asciiText(t).replace(/[^\x20-\x7E]/g, '').replace(/^[^A-Za-z0-9(]+/, '').replace(/\s*-\s*\d{0,4}\s*P[a-z]{0,4}\.?$/i, '')
    .replace(/\bQTY\b.*$/i, '').replace(/[A-Za-z]{5,}/g, (w) => { const lw = w.toLowerCase(); if (VLOW.includes(lw)) return w; let best = null; for (let i = 0; i < VLOW.length; i++) { const e = ed(lw, VLOW[i]); const lim = VLOW[i].length >= 7 || (VLOW[i].length >= 5 && lw.length >= 5 && (lw[0] === VLOW[i][0] || lw[lw.length - 1] === VLOW[i][VLOW[i].length - 1])) ? 2 : 1; if (e <= lim && (!best || e < best.e)) best = { e, w: VOCAB[i] }; } return best ? best.w : w; })
    .replace(/\s{2,}/g, ' ').trim();
}

/** No quantity read on any label of a part? Use the one its series uses (e.g. other 2800-… packs say 25), marked as a guess. */
function seriesQty(pkgs) {
  const by = {}; for (const k of pkgs) if (k.qty && /^\d{4}-/.test(k.partNo || '')) { const s = k.partNo.slice(0, 4); (by[s] = by[s] || {})[k.qty] = (by[s][k.qty] || 0) + 1; }
  for (const k of pkgs) {
    if (k.qty || !/^\d{4}-/.test(k.partNo || '')) continue; const q = by[k.partNo.slice(0, 4)]; if (!q) continue;
    const e = Object.entries(q).sort((a, b) => b[1] - a[1]); if (e[0][1] >= 2 && (!e[1] || e[0][1] >= 3 * e[1][1])) { k.qty = +e[0][0]; k.qtyGuess = true; }
  }
}
