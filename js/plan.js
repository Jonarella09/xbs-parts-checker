// Print plates: split the print list into plates, pack them on the bed, name everything, write STL/3MF zips.
import * as store from './store.js';
import { partById, counts, kitById, partLabel } from './proj.js';
import { pad2, slugify, plural, today, jszip, esc } from './util.js';
import { parseSTL, flatPositions } from './stl.js';

export const BEDS = [[180, 180], [220, 220], [250, 210], [256, 256], [300, 300], [350, 350]];
export const GAP = 4, MARGIN = 5;
export const SPLITS = [
  { id: 'fewest', t: 'Fewest plates', d: 'Fill each bed as full as it goes.', slug: 'fewest-plates' },
  { id: 'kit', t: 'By kit', d: 'Each kit gets its own plates, so every print finishes a whole kit.', slug: 'by-kit', needsKit: true },
  { id: 'count', t: 'Same number of pieces', d: 'Every plate gets the same count. Big and small pieces are shared out evenly.', slug: 'same-count' },
  { id: 'part', t: 'One part per plate', d: 'Each plate holds a single kind of piece, so sorting after printing is easy.', slug: 'by-part' },
  { id: 'size', t: 'By piece size', d: 'Small (up to 4 cm), medium (4–9 cm) and large (over 9 cm) on separate plates.', slug: 'by-size' },
  { id: 'balance', t: 'Same total size', d: 'Plates use about the same material, so they take about the same time.', slug: 'same-size' },
];
export const FMTS = [
  { id: 'piece', t: 'One STL per piece', d: 'Every piece is its own file, so you can drag them in and move each one.' },
  { id: 'part', t: 'One STL per part', d: 'One file per kind of piece. Set the number of copies in your slicer.' },
  { id: '3mf', t: 'Arranged plate (.3mf)', d: 'One file per plate with every piece already laid flat and spaced out on your bed. Each piece stays a separate object.' },
];

const info = (p, k) => { const t = partById(p, k); return t && t.model && t.model.flat ? t.model.flat : { fx: 10, fy: 10, fz: 5, vol: 0.1 }; };
const sizeCls = (p, k) => { const L = info(p, k).fx; return L <= 40 ? 'Small' : L <= 90 ? 'Medium' : 'Large'; };
export const codeOf = (p, k) => { const t = partById(p, k); return slugify(t ? t.code || t.name : k); };
export const fileBase = (p, k) => { const t = partById(p, k); return slugify(t && t.model ? t.model.name.replace(/\.stl$/i, '') : codeOf(p, k)); };

export function printSel(p) { const o = {}; for (const k in p.print) { const q = Math.max(0, Math.round(+p.print[k] || 0)); const t = partById(p, k); if (q && t && t.model) o[k] = q; } return o; }
export function planCfg(p) {
  const c = Object.assign({ split: 'fewest', k: 2, bed: 1, w: 220, d: 220, fit: true, from: 'have', merge: {}, fmt: 'piece' }, p.plan || {});
  if (!SPLITS.some((s) => s.id === c.split) || (c.split === 'kit' && !planKit(p))) c.split = 'fewest';
  return c;
}
export const planKit = (p) => (p.printKit && kitById(p, p.printKit)) || p.kits[0] || null;
export function bedOf(c) { if (c.bed >= 0 && BEDS[c.bed]) return BEDS[c.bed]; return [Math.max(60, Math.min(600, +c.w || 220)), Math.max(60, Math.min(600, +c.d || 220))]; }

function packOne(items, UW, UD) {
  let free = [{ x: 0, y: 0, w: UW, h: UD }]; const placed = [], left = [];
  const prune = () => { free = free.filter((a, i) => !free.some((b, j) => j !== i && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (j < i || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h))); };
  for (const it of items) {
    let best = null;
    for (const f of free) for (const r of [false, true]) {
      const w = (r ? it.h : it.w) + GAP, h = (r ? it.w : it.h) + GAP; if (w > f.w + 1e-6 || h > f.h + 1e-6) continue;
      const ss = Math.min(f.w - w, f.h - h), sc = [f.y + h, ss];
      if (!best || sc[0] < best.sc[0] - 1e-6 || (Math.abs(sc[0] - best.sc[0]) < 1e-6 && sc[1] < best.sc[1])) best = { x: f.x, y: f.y, w, h, r, sc };
    }
    if (!best) { left.push(it); continue; }
    placed.push({ k: it.k, t: it.t || '', x: best.x, y: best.y, w: best.w - GAP, h: best.h - GAP, rot: best.r ? !it.rot : it.rot });
    const nf = [];
    for (const f of free) {
      if (best.x >= f.x + f.w || best.x + best.w <= f.x || best.y >= f.y + f.h || best.y + best.h <= f.y) { nf.push(f); continue; }
      if (best.x > f.x) nf.push({ x: f.x, y: f.y, w: best.x - f.x, h: f.h });
      if (best.x + best.w < f.x + f.w) nf.push({ x: best.x + best.w, y: f.y, w: f.x + f.w - best.x - best.w, h: f.h });
      if (best.y > f.y) nf.push({ x: f.x, y: f.y, w: f.w, h: best.y - f.y });
      if (best.y + best.h < f.y + f.h) nf.push({ x: f.x, y: best.y + best.h, w: f.w, h: f.y + f.h - best.y - best.h });
    }
    free = nf; prune();
  }
  return { placed, left };
}
function packBins(p, pcs, W, D, limit) {
  const UW = W - 2 * MARGIN + GAP, UD = limit ? D - 2 * MARGIN + GAP : 100000;
  let items = pcs.map((x) => ({ k: x.k, t: x.t || '', w: info(p, x.k).fx, h: info(p, x.k).fy, rot: false }));
  items.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h || a.k.localeCompare(b.k));
  const bins = [];
  while (items.length) {
    const { placed, left } = packOne(items, UW, UD);
    if (!placed.length) { const it = items.shift(); bins.push({ place: [{ k: it.k, t: it.t || '', x: 0, y: 0, w: it.w, h: it.h, rot: false, over: true }] }); continue; }
    bins.push({ place: placed }); items = left;
  }
  bins.forEach((b) => {
    b.place.sort((a, c) => Math.floor((a.y + a.h / 2) / 14) - Math.floor((c.y + c.h / 2) / 14) || a.x - c.x);
    b.depth = Math.max(...b.place.map((x) => x.y + x.h)) + 2 * MARGIN; b.width = Math.max(...b.place.map((x) => x.x + x.w)) + 2 * MARGIN;
    b.fits = b.depth <= D + 0.01 && b.width <= W + 0.01 && !b.place.some((x) => x.over);
    b.ox = b.fits ? (W - b.width) / 2 : 0; b.oy = b.fits ? (D - b.depth) / 2 : 0;
  });
  return bins;
}

export function buildPlan(p) {
  const c = planCfg(p); const [W, D] = bedOf(c); const sel = printSel(p); const ids = Object.keys(sel);
  const order = p.parts.map((t) => t.id).filter((id) => sel[id]);
  const pcs = []; for (const k of order) for (let i = 0; i < sel[k]; i++) pcs.push({ k });
  const area = (k) => info(p, k).fx * info(p, k).fy, vol = (k) => info(p, k).vol;
  let groups = []; const kk = Math.max(1, Math.min(50, Math.round(+c.k || 2)));
  if (c.split === 'fewest') groups = [{ label: '', title: '', pcs }];
  else if (c.split === 'kit') {
    const kit = planKit(p); const have = c.from === 'one' ? {} : counts(p); const by = {};
    for (const k of order) { const need = kit.need[k] || 0; const q = sel[k], h = have[k] || 0; for (let i = 0; i < q; i++) { const n = need ? Math.floor((h + i) / need) + 1 : 0; (by[n] = by[n] || []).push({ k }); } }
    Object.keys(by).map(Number).sort((a, b) => a - b).forEach((n) => {
      if (n === 0) { groups.push({ label: 'Extras', title: 'Not in the kit', pcs: by[0], folder: `Extras_${by[0].length}pcs` }); return; }
      let miss = 0; for (const k in kit.need) { if (!partById(p, k)) continue; miss += Math.max(0, n * kit.need[k] - ((have[k] || 0) + (sel[k] || 0))); }
      groups.push({ set: n, miss, pcs: by[n], label: `Kit-${pad2(n)}${miss ? '-partial' : ''}`, title: `Kit ${n}${miss ? ' (partial)' : ''}`,
        note: miss ? `Kit ${n} will still need ${miss} more ${plural(miss, 'piece')}` : `Completes kit ${n}`, folder: `Kit-${pad2(n)}${miss ? '_partial' : ''}_${by[n].length}pcs` });
    });
  } else if (c.split === 'count') { groups = Array.from({ length: kk }, () => ({ label: '', title: '', pcs: [] })); const s = pcs.slice().sort((a, b) => area(b.k) - area(a.k)); let g = 0, dir = 1; for (const x of s) { groups[g].pcs.push(x); if (kk > 1) { g += dir; if (g === kk) { g = kk - 1; dir = -1; } else if (g < 0) { g = 0; dir = 1; } } } }
  else if (c.split === 'part') groups = order.map((k) => ({ label: `${codeOf(p, k)}`, title: `${partLabel(partById(p, k))} · ${partById(p, k).name}`, pcs: pcs.filter((x) => x.k === k), pk: k }));
  else if (c.split === 'size') ['Small', 'Medium', 'Large'].forEach((n) => { const g = pcs.filter((x) => sizeCls(p, x.k) === n); if (g.length) groups.push({ label: n, title: n, pcs: g }); });
  else if (c.split === 'balance') { groups = Array.from({ length: kk }, () => ({ label: '', title: '', pcs: [], load: 0 })); pcs.slice().sort((a, b) => vol(b.k) - vol(a.k)).forEach((x) => { const g = groups.reduce((m, y) => (y.load < m.load ? y : m)); g.pcs.push(x); g.load += vol(x.k); }); }
  groups = groups.filter((g) => g.pcs.length);
  groups.forEach((g, i) => { g.key = g.set ? 'K' + g.set : c.split === 'part' ? g.pk : c.split === 'size' ? g.label : g.label === 'Extras' ? 'X' : 'G' + (i + 1); g.short = g.set ? `Kit-${pad2(g.set)}` : c.split === 'part' ? codeOf(p, g.pk) : g.label || ''; g.members = [g.key]; });
  const baseGroups = groups.slice(), canComb = ['kit', 'part', 'size'].includes(c.split);
  if (canComb) {
    const M = (c.merge || {})[c.split] || []; const jn = (a) => (a.length <= 4 ? a.join('+') : a.slice(0, 3).join('+') + `+${a.length - 3}-more`);
    for (const keys of M) {
      if (!Array.isArray(keys)) continue; const mem = groups.filter((g) => !g.merged && keys.includes(g.key)); if (mem.length < 2) continue;
      const at = groups.indexOf(mem[0]), tag = c.split === 'kit';
      const ng = { merged: true, key: mem.map((g) => g.key).join('+'), members: mem.map((g) => g.key), short: jn(mem.map((g) => g.short)), title: mem.map((g) => (c.split === 'part' ? g.short : g.title)).join(' + '), miss: mem.some((g) => g.miss), note: mem.filter((g) => g.note).map((g) => g.note).join(' · '), pcs: [].concat(...mem.map((g) => g.pcs.map((x) => (tag ? Object.assign({}, x, { t: g.short }) : x)))) };
      ng.label = ng.short; ng.folder = `${ng.short}_${ng.pcs.length}pcs`;
      groups = groups.filter((g) => !mem.includes(g)); groups.splice(at, 0, ng);
    }
  }
  const plates = [];
  for (const g of groups) {
    let bins = packBins(p, g.pcs, W, D, c.fit);
    if (bins.length > 1 && c.fit) {
      const n = bins.length, sub = Array.from({ length: n }, () => ({ pcs: [], a: 0 }));
      g.pcs.slice().sort((x, y) => area(y.k) - area(x.k)).forEach((x) => { const t = sub.reduce((m, y) => (y.a < m.a ? y : m)); t.pcs.push(x); t.a += area(x.k) + 40; });
      const alt = sub.map((x) => packBins(p, x.pcs, W, D, true)); if (alt.every((x) => x.length === 1 && x[0].fits)) bins = alt.map((x) => x[0]);
    }
    bins.forEach((b, i) => plates.push({ g, part: i + 1, parts: bins.length, bin: b }));
  }
  const N = plates.length;
  plates.forEach((pl, i) => {
    pl.no = i + 1; pl.code = 'P' + pad2(pl.no); pl.n = pl.bin.place.length;
    const lab = pl.g.label ? pl.g.label + (pl.parts > 1 ? `-${pl.part}of${pl.parts}` : '') : '';
    pl.name = `Plate-${pad2(pl.no)}-of-${pad2(N)}${lab ? '_' + lab : ''}_${pl.n}pcs`;
    pl.title = `Plate ${pl.no} of ${N}` + (pl.g.title ? ` · ${pl.g.title}` : '') + (pl.parts > 1 && pl.g.title ? ` (${pl.part} of ${pl.parts})` : '');
    pl.vol = pl.bin.place.reduce((a, x) => a + vol(x.k), 0);
    pl.fill = Math.round(100 * pl.bin.place.reduce((a, x) => a + x.w * x.h, 0) / (W * D));
    pl.place = pl.bin.place.map((x, j) => Object.assign({ no: j + 1 }, x, { x: x.x + pl.bin.ox, y: x.y + pl.bin.oy }));
    const cnt = {}, cntT = {}; pl.place.forEach((x) => { cnt[x.k] = (cnt[x.k] || 0) + 1; const kt = (x.t || '') + '|' + x.k; cntT[kt] = (cntT[kt] || 0) + 1; }); pl.cnt = cnt; pl.cntT = cntT;
  });
  return { c, W, D, pcs, plates, groups, baseGroups, canComb, tot: pcs.length, vol: pcs.reduce((a, x) => a + vol(x.k), 0), ids };
}

export const pieceFile = (p, pl, x) => `${pl.code}-${pad2(x.no)}${x.t ? '_' + x.t : ''}_${codeOf(p, x.k)}_${fileBase(p, x.k)}.stl`;
export const partFile = (p, pl, k, q, t) => `${pl.code}${t ? '_' + t : ''}_${codeOf(p, k)}_${fileBase(p, k)}_x${q}.stl`;
export function zipName(p, plan) { const s = SPLITS.find((x) => x.id === plan.c.split); return `${slugify(p.name)}_${plan.tot}pcs_${plan.plates.length}${plan.plates.length === 1 ? 'plate' : 'plates'}_${s.slug}_${today()}`; }
const folderOf = (plan, pl) => (plan.c.split === 'kit' && pl.g.folder ? pl.g.folder + '/' : '');
export function exampleName(p, plan) {
  const pl = plan.plates[0]; if (!pl) return ''; const x = pl.place[0]; const f = folderOf(plan, pl);
  return plan.c.fmt === '3mf' ? `${f}${pl.name}.3mf` : plan.c.fmt === 'part' ? `${f}${pl.name}/${partFile(p, pl, x.k, pl.cnt[x.k], x.t)}` : `${f}${pl.name}/${pieceFile(p, pl, x)}`;
}
export function planText(p, plan, only) {
  const s = SPLITS.find((x) => x.id === plan.c.split), f = FMTS.find((x) => x.id === plan.c.fmt);
  const L = [`${p.name} · print plan`];
  if (p.credit && p.credit.label) L.push(`${p.credit.prefix || 'Model'}: ${p.credit.label}${p.credit.by ? ' by ' + p.credit.by : ''}${p.credit.handle ? ' (' + p.credit.handle + ')' : ''}${p.credit.url ? ' · ' + p.credit.url : ''}`);
  L.push(`Made ${new Date().toLocaleDateString()} with The Indexer · ${plan.tot} pieces on ${plan.plates.length} ${plural(plan.plates.length, 'plate')} · ${plan.vol.toFixed(1)} cm³ of parts`, `Split: ${s.t} · Bed: ${plan.W} × ${plan.D} mm · Files: ${f.t}`, '',
    'How to read the names:', '  Plate-02-of-05 = the 2nd of 5 plates. P02-07 = piece 7 on plate 2.', '  Pieces are numbered left to right, front to back, as they sit on the plate.', '  The part code matches the one in The Indexer.');
  if (plan.c.split === 'kit') L.push('  Kit-05 = pieces for kit 5. Each kit has its own folder; combined kits share one (Kit-04+Kit-05).');
  L.push('');
  if (plan.c.split === 'kit' && plan.baseGroups) { L.push(plan.c.from === 'one' ? 'Kits are numbered from 1, counting only the pieces in this print.' : 'Kit numbers continue from the pieces you already have.', 'Kits:'); for (const g of plan.baseGroups) L.push(`  ${g.title.padEnd(18)} ${String(g.pcs.length).padStart(3)} ${plural(g.pcs.length, 'piece').padEnd(6)} ${g.note ? '· ' + g.note : ''}`); L.push(''); }
  if (plan.c.fmt === '3mf') L.push('Pieces in the .3mf files are laid on their flattest side. Check the orientation of brackets and clips in your slicer before printing.', '');
  for (const pl of plan.plates) {
    if (only && pl !== only) continue;
    L.push(`${pl.title.toUpperCase()} · ${pl.n} pieces · ${pl.vol.toFixed(1)} cm³ · ${pl.fill}% of the bed${pl.bin.fits ? '' : ' · DOES NOT FIT THIS BED'}`);
    L.push(`  Folder/file: ${folderOf(plan, pl)}${plan.c.fmt === '3mf' ? pl.name + '.3mf' : pl.name + '/'}`);
    for (const x of pl.place) { const t = partById(p, x.k); L.push(`  ${pad2(x.no)}  ${(x.t ? x.t + ' ' : '').padEnd(x.t ? 0 : 0)}${partLabel(t).padEnd(8)} ${t.name.padEnd(26)} ${fileBase(p, x.k)}.stl`); }
    L.push('');
  }
  return L.join('\n');
}

/* ---------- files ---------- */
const stlCache = new Map();
async function stlBytes(p, k) {
  const t = partById(p, k); const key = p.id + '/' + t.model.file; if (stlCache.has(key)) return stlCache.get(key);
  const b = await store.fileBlob(t.model.file); if (!b) throw new Error(`The 3D model for ${t.name} is missing.`);
  const u = new Uint8Array(await b.arrayBuffer()); stlCache.set(key, u); return u;
}
const meshCache = new Map();
async function flatMesh(p, k) {
  const t = partById(p, k); const key = p.id + '/' + t.model.file; if (meshCache.has(key)) return meshCache.get(key);
  const bytes = await stlBytes(p, k); const stl = parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const pos = flatPositions(stl, t.model.flat || { ax: 'z' }); const map = new Map(); const vs = []; const tri = new Uint32Array(stl.n * 3);
  for (let i = 0; i < stl.n * 3; i++) { const key2 = pos[i * 3].toFixed(4) + ',' + pos[i * 3 + 1].toFixed(4) + ',' + pos[i * 3 + 2].toFixed(4); let id = map.get(key2); if (id === undefined) { id = vs.length; map.set(key2, id); vs.push(key2); } tri[i] = id; }
  const parts = ['<mesh><vertices>']; for (const s of vs) { const a = s.split(','); parts.push(`<vertex x="${+a[0]}" y="${+a[1]}" z="${+a[2]}"/>`); }
  parts.push('</vertices><triangles>'); for (let i = 0; i < stl.n; i++) { const a = tri[i * 3], b = tri[i * 3 + 1], c = tri[i * 3 + 2]; if (a !== b && b !== c && a !== c) parts.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`); }
  parts.push('</triangles></mesh>'); const out = parts.join(''); meshCache.set(key, out); return out;
}
async function make3mf(p, pl) {
  const JSZip = await jszip(); const ks = Object.keys(pl.cnt); const ids = {}; let res = '';
  for (let i = 0; i < ks.length; i++) { const k = ks[i]; ids[k] = i + 1; res += `<object id="${i + 1}" type="model" name="${esc(partLabel(partById(p, k)))} ${esc(partById(p, k).name)}">${await flatMesh(p, k)}</object>`; }
  let build = '';
  for (const x of pl.place) { const tx = (MARGIN + x.x + x.w / 2).toFixed(3), ty = (MARGIN + x.y + x.h / 2).toFixed(3); build += `<item objectid="${ids[x.k]}" transform="${x.rot ? '0 1 0 -1 0 0 0 0 1' : '1 0 0 0 1 0 0 0 1'} ${tx} ${ty} 0"/>`; }
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">${esc(pl.name)}</metadata><metadata name="Application">The Indexer</metadata><resources>${res}</resources><build>${build}</build></model>`;
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  z.file('3D/3dmodel.model', model);
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
async function addPlate(zip, p, plan, pl) {
  const fmt = plan.c.fmt; const f = folderOf(plan, pl);
  if (fmt === '3mf') { zip.file(`${f}${pl.name}.3mf`, await make3mf(p, pl)); return; }
  const dir = zip.folder(f + pl.name);
  if (fmt === 'part') { for (const kt of Object.keys(pl.cntT)) { const [t, k] = kt.split('|'); dir.file(partFile(p, pl, k, pl.cntT[kt], t), await stlBytes(p, k)); } }
  else for (const x of pl.place) dir.file(pieceFile(p, pl, x), await stlBytes(p, x.k));
}
/** Build the zip for all plates (only = 0) or one plate number. */
export async function planZip(p, only) {
  const plan = buildPlan(p); if (!plan.tot) return null; const JSZip = await jszip(); const zip = new JSZip();
  const list = only ? [plan.plates[only - 1]] : plan.plates;
  for (const pl of list) await addPlate(zip, p, plan, pl);
  zip.file(only ? `${list[0].name}_plan.txt` : 'print-plan.txt', planText(p, plan, only ? list[0] : null));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, name: only ? `${slugify(p.name)}_${list[0].name}.zip` : `${zipName(p, plan)}.zip` };
}
export function bedSVG(p, pl, W, D) {
  const over = Math.max(D, pl.bin.depth); let s = `<svg viewBox="-2 -2 ${W + 4} ${over + 4}" class="bedmap" role="img" aria-label="Layout of ${esc(pl.title)}"><rect x="0" y="${over - D}" width="${W}" height="${D}" rx="4" class="bed"/>`;
  if (over > D) s += `<rect x="0" y="0" width="${W}" height="${over - D}" class="bedover"/>`;
  for (const x of pl.place) {
    const X = MARGIN + x.x, Y = over - (MARGIN + x.y + x.h); const t = partById(p, x.k); const col = t.color || '#888';
    s += `<rect x="${X}" y="${Y}" width="${x.w}" height="${x.h}" rx="1.5" fill="${col}" stroke="rgba(0,0,0,.35)" stroke-width=".6"><title>${pad2(x.no)} · ${esc(partLabel(t))} ${esc(t.name)}</title></rect>`;
    if (x.w >= 9 && x.h >= 7) s += `<text x="${X + x.w / 2}" y="${Y + x.h / 2}" fill="${luma(col) > 150 ? '#111' : '#fff'}" font-size="${Math.min(6, x.h * 0.6)}">${x.no}</text>`;
  }
  return s + '</svg>';
}
function luma(h) { const n = parseInt((h || '#888').slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); }
