// Package labels: read each package's text (Tesseract OCR) and barcode, find the part number and quantity,
// match it to a part, and add packages × pieces-per-package to the inventory.
import * as store from '../store.js';
import { partById, photoById, counts, diff, logEvent, newPart, sortedParts, photoSummary } from '../proj.js';
import { esc, pn, toast, confirmBox, loadScript, clamp, when } from '../util.js';
import { thumbHTML, warmThumbs, pickPart } from './common.js';
import { autoCode } from './part.js';
import { decode } from '../vision/client.js';
import { projPath, go } from '../main.js';

export const TESS = {
  script: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js',
  workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
  corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2',
  langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
};
let tw = null, twP = null;
async function ocrWorker(onLog) {
  if (tw) return tw; if (twP) return twP;
  twP = (async () => {
    await loadScript(TESS.script);
    tw = await window.Tesseract.createWorker('eng', 1, { workerPath: TESS.workerPath, corePath: TESS.corePath, langPath: TESS.langPath, logger: (m) => onLog && onLog(m) });
    return tw;
  })();
  try { return await twP; } finally { twP = null; }
}
let bd = null;
async function barcodeDetector() {
  if (bd) return bd;
  try { if ('BarcodeDetector' in window) { const f = await window.BarcodeDetector.getSupportedFormats(); if (f && f.length) return (bd = new window.BarcodeDetector()); } } catch (e) {}
  try {
    const mod = await import('../../lib/barcode-detector.js');
    mod.setZXingModuleOverrides({ locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL('../../lib/zxing_reader.wasm', import.meta.url).href : prefix + path) });
    bd = new mod.BarcodeDetector(); return bd;
  } catch (e) { console.warn('barcodes unavailable', e); return null; }
}

/* ---------- reading one package ---------- */
export function parseLabel(text) {
  const t = String(text || '').replace(/[|]/g, 'I'); const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const out = { partNo: '', qty: null, name: '', size: '' };
  const pats = [/\b\d{4}-\d{4}-\d{4}\b/, /\bREV-\d{2}-\d{4}(?:-[A-Z0-9]+)?\b/i, /\bam-\d{3,5}[a-z]?\b/i,
    /(?:SKU|P\/N|PN|PART\s*(?:NO|#|NUMBER)?|ITEM\s*(?:NO|#)?)[\s.:#-]*([A-Z0-9][A-Z0-9.\-]{3,})/i, /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*-)[A-Z0-9]{2,}(?:-[A-Z0-9]+){1,4}\b/];
  for (const re of pats) { const m = t.match(re); if (m) { out.partNo = (m[1] || m[0]).replace(/[.\-]+$/, ''); break; } }
  const qp = [/(?:QTY|QUANTITY|PCS|PIECES|COUNT|CT|PACK\s*OF|PK)\s*[:.#x×]?\s*(\d{1,4})\b/i, /\b(\d{1,4})\s*(?:PCS|PC|PIECES|PACK|PK|CT|COUNT|PER\s*PACK)\b/i, /\b(\d{1,4})\s*-\s*PACK\b/i, /\b[x×]\s?(\d{1,4})\b/i];
  for (const re of qp) { const m = t.match(re); if (m && +m[1] > 0 && +m[1] < 5000) { out.qty = +m[1]; break; } }
  const sz = t.match(/\bM\d(?:\.\d)?\s?[x×]\s?\d+(?:\.\d+)?\s?(?:mm)?\b/i); if (sz) out.size = sz[0].replace(/\s+/g, ' ');
  const words = (s) => (s.match(/[A-Za-z]{2,}/g) || []).length;
  const named = lines.filter((l) => words(l) >= 2 && !/^(qty|sku|part|item)/i.test(l) && l.length <= 60).sort((a, b) => words(b) - words(a) || b.length - a.length);
  out.name = (named[0] || lines[0] || '').replace(/\s{2,}/g, ' ').slice(0, 60);
  return out;
}
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const tokens = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9.]+/g) || []);
export function matchPart(p, pk) {
  if (pk.barcode) { const t = p.parts.find((x) => x.barcode && x.barcode === pk.barcode); if (t) return { id: t.id, by: 'barcode' }; }
  const pn0 = norm(pk.partNo);
  if (pn0) { const t = p.parts.find((x) => norm(x.partNo) === pn0); if (t) return { id: t.id, by: 'part number' }; }
  const txt = norm(pk.text); const t2 = p.parts.find((x) => x.partNo && norm(x.partNo).length >= 5 && txt.includes(norm(x.partNo))); if (t2) return { id: t2.id, by: 'part number' };
  const a = tokens(pk.name + ' ' + (pk.size || '')); let best = null;
  for (const x of p.parts) { const b = tokens(x.name); if (!a.size || !b.size) continue; let i = 0; for (const w of a) if (b.has(w)) i++; const j = i / (a.size + b.size - i); if (j >= 0.45 && (!best || j > best.j)) best = { id: x.id, j }; }
  return best ? { id: best.id, by: 'name', weak: true } : null;
}
function cropPkg(img, pk, scaleTo = 1600) {
  const [x0, y0, x1, y1] = pk.box; const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
  const X = Math.max(0, x0 - pad), Y = Math.max(0, y0 - pad), W = Math.min(img.width, x1 + pad) - X, H = Math.min(img.height, y1 + pad) - Y;
  const s = clamp(scaleTo / Math.max(W, H), 0.5, 3); const c = document.createElement('canvas'); c.width = Math.round(W * s); c.height = Math.round(H * s);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, X, Y, W, H, 0, 0, c.width, c.height); return c;
}
function rotated(c, deg) { const r = document.createElement('canvas'); const q = deg % 180 !== 0; r.width = q ? c.height : c.width; r.height = q ? c.width : c.height; const g = r.getContext('2d'); g.translate(r.width / 2, r.height / 2); g.rotate((deg * Math.PI) / 180); g.drawImage(c, -c.width / 2, -c.height / 2); return r; }
async function readPkg(worker, det, img, pk) {
  const c = cropPkg(img, pk); let best = null;
  for (const deg of [0, 90, 270, 180]) {
    const cc = deg ? rotated(c, deg) : c; const { data } = await worker.recognize(cc);
    const words = (data.words || []).filter((w) => w.confidence > 50 && /[A-Za-z0-9]{2,}/.test(w.text));
    const score = words.reduce((a, w) => a + w.confidence * Math.min(8, w.text.length), 0);
    if (!best || score > best.score) best = { score, text: data.text || '', conf: data.confidence || 0, deg };
    if (deg === 0 && best.conf > 70 && words.length >= 3) break;
  }
  let barcode = '';
  if (det) { try { const r = await det.detect(c); if (r && r.length) barcode = r[0].rawValue; } catch (e) {} }
  const parsed = parseLabel(best ? best.text : '');
  return Object.assign(pk, { text: (best && best.text.trim()) || '', conf: best ? Math.round(best.conf) : 0, barcode }, parsed, { qty: pk.qty || parsed.qty, read: true });
}

/* ---------- the labels view ---------- */
export async function labelsView(el, ph0, { draw }) {
  const p0 = store.project(); await warmThumbs(p0);
  const url = await store.fileUrl(ph0.file); const img = new Image(); img.src = url; await img.decode().catch(() => {});
  const cur = () => photoById(store.project(), ph0.id);
  const render = () => {
    const p = store.project(); const ph = cur(); if (!ph) return; const ro = ph.status !== 'draft';
    const pk = ph.pkgs || []; const pending = pk.filter((k) => !k.read).length;
    const inc = pk.filter((k) => !k.skip && k.part && partById(p, k.part));
    const sum = {}; for (const k of inc) sum[k.part] = (sum[k.part] || 0) + (k.qty || 1) * (k.packs || 1);
    el.innerHTML = `<div class="page">
      <div class="hero"><div><a class="small" href="#/${projPath('count')}">← Count</a><h1 style="margin-top:4px">${esc(ph.name)} · labels</h1><p class="sub">${pk.length ? `${pn(pk.length, 'package')} found.` : 'No packages found.'} Check each one: the part it is, how many pieces it holds, and how many packages like it there are.</p></div>
        <div class="btnrow">${ph.status === 'added' ? '<span class="tag ok">Counted</span>' : ph.status === 'archived' ? '<span class="tag">Archived</span>' : ''}</div></div>
      <div class="card pad" style="display:grid;gap:10px"><div style="position:relative;max-height:46vh;overflow:auto;border-radius:10px;background:#1a1f26"><div style="position:relative;width:100%"><img src="${url}" alt="" style="width:100%;display:block"><svg viewBox="0 0 ${ph.W} ${ph.H}" style="position:absolute;inset:0;width:100%;height:100%">${pk.map((k, i) => { const [x0, y0, x1, y1] = k.box; return `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="${k.skip ? '#9aa3ad' : k.part ? '#4cc581' : '#ffbf2e'}" stroke-width="${Math.max(3, ph.W / 400)}"/><text x="${x0 + 8}" y="${y0 + Math.max(30, ph.W / 60)}" font-size="${Math.max(28, ph.W / 50)}" fill="#fff" stroke="#000" stroke-width="${Math.max(2, ph.W / 900)}" paint-order="stroke" font-weight="700">${i + 1}</text>`; }).join('')}</svg></div></div>
        ${pending ? `<div style="display:grid;gap:6px"><div class="progress"><i id="ocrBar"></i></div><span class="small muted" id="ocrTxt">Reading labels… (the first time downloads the text reader, about 15 MB)</span></div>` : ''}</div>
      <div class="pkgs">${pk.map((k, i) => pkgHTML(p, k, i, ro)).join('')}</div>
      ${pk.length && !pending ? `<div class="card"><div class="applybar"><div class="grow" style="display:grid;gap:4px"><b>${pn(Object.values(sum).reduce((a, b) => a + b, 0), 'piece')} from ${pn(inc.length, 'package')}</b><div class="misslist">${Object.entries(sum).map(([id, q]) => `<span class="mchip">${esc(partById(p, id).name)} <b>+${q}</b></span>`).join('')}</div></div>
        ${ph.status === 'draft' ? `<button type="button" class="btn ghost small danger" id="lDiscard">Discard</button><button type="button" class="btn primary" id="lAdd" ${inc.length ? '' : 'disabled'}>Add to inventory</button>` : ph.status === 'added' ? `<span class="small muted">Added ${when(ph.addedAt)}</span>` : ''}</div></div>` : ''}
      ${!pk.length ? '<div class="empty"><p>No packages stood out from the background. Lay them on a plain surface with some space between them, and try again.</p></div>' : ''}
    </div>`;
    wire(p, ph, ro);
    if (pending) readAll();
  };
  function pkgHTML(p, k, i, ro) {
    const t = k.part && partById(p, k.part);
    return `<article class="pkg${k.skip ? ' skip' : ''}"><div class="pimg"><canvas data-crop="${i}" width="240" height="240"></canvas></div>
      <div style="display:grid;gap:8px;min-width:0"><div class="row"><b>Package ${i + 1}</b>${k.read ? (k.conf ? `<span class="tag">${k.conf}% sure of the text</span>` : '<span class="tag warn">No text read</span>') : '<span class="tag">Reading…</span>'}${k.barcode ? `<span class="tag ok">Barcode ${esc(k.barcode)}</span>` : ''}<span class="spacer"></span>${ro ? '' : `<label class="check small"><input type="checkbox" data-skip="${i}"${k.skip ? '' : ' checked'}> Count it</label>`}</div>
        ${k.text ? `<div class="ptext">${esc(k.text)}</div>` : ''}
        <div class="pf">
          <label class="field"><span>Part number</span><input class="inp" data-f="partNo" data-i="${i}" value="${esc(k.partNo || '')}" ${ro ? 'disabled' : ''}></label>
          <label class="field"><span>Pieces in it</span><input class="inp" type="number" min="1" data-f="qty" data-i="${i}" value="${k.qty || ''}" placeholder="?" ${ro ? 'disabled' : ''}></label>
          <label class="field"><span>Packages like it</span><input class="inp" type="number" min="1" data-f="packs" data-i="${i}" value="${k.packs || 1}" ${ro ? 'disabled' : ''}></label>
        </div>
        <div class="row">${t ? `${thumbHTML(t, 'sm')}<span class="grow"><b>${esc(t.name)}</b><span class="small muted"> · matched by ${esc(k.by || 'hand')}${k.weak ? ' (check it)' : ''}</span></span>` : `<span class="grow small muted">${k.read ? `Not matched yet${k.name ? `: “${esc(k.name)}”` : ''}` : ''}</span>`}
          ${ro ? '' : `<button type="button" class="btn small" data-pick="${i}">${t ? 'Change' : 'Pick part'}</button><button type="button" class="btn small" data-new="${i}">New part</button>`}</div></div></article>`;
  }
  function wire(p, ph, ro) {
    el.querySelectorAll('[data-crop]').forEach((c) => { const k = ph.pkgs[+c.dataset.crop]; const cc = cropPkg(img, k, 240); const g = c.getContext('2d'); const s = Math.min(240 / cc.width, 240 / cc.height); g.clearRect(0, 0, 240, 240); g.drawImage(cc, (240 - cc.width * s) / 2, (240 - cc.height * s) / 2, cc.width * s, cc.height * s); });
    if (ro) return;
    const set = (i, patch) => store.change((q) => { Object.assign(photoById(q, ph.id).pkgs[i], patch); }, { quiet: true });
    el.querySelectorAll('[data-skip]').forEach((b) => (b.onchange = () => { set(+b.dataset.skip, { skip: !b.checked }); render(); }));
    el.querySelectorAll('[data-f]').forEach((inp) => (inp.onchange = () => { const i = +inp.dataset.i, f = inp.dataset.f; const v = f === 'partNo' ? inp.value.trim() : Math.max(1, Math.round(+inp.value || 1)); set(i, { [f]: v }); if (f === 'partNo') { const k = cur().pkgs[i]; const m = matchPart(store.project(), k); if (m) set(i, { part: m.id, by: m.by, weak: !!m.weak }); } render(); }));
    el.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = async () => { const i = +b.dataset.pick; const r = await pickPart(store.project(), { current: ph.pkgs[i].part }); if (!r) return; if (r === '__new') return newFrom(i); set(i, { part: r, by: 'hand', weak: false }); render(); }));
    el.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => newFrom(+b.dataset.new)));
    const add = el.querySelector('#lAdd'); if (add) add.onclick = () => addAll();
    const dis = el.querySelector('#lDiscard'); if (dis) dis.onclick = async () => { if (!(await confirmBox({ title: 'Discard this photo?', text: 'Nothing from it was counted yet.', ok: 'Discard', danger: true }))) return; await store.delFile(ph.file); if (ph.thumb) await store.delFile(ph.thumb); store.change((q) => { q.photos = q.photos.filter((x) => x.id !== ph.id); }); go(projPath('count')); };
  }
  async function newFrom(i) {
    const p = store.project(); const k = cur().pkgs[i];
    const base = k.name || 'Part from a label'; const name = k.size && !base.toLowerCase().replace(/\s/g, '').includes(k.size.toLowerCase().replace(/\s/g, '')) ? `${k.size} ${base}` : base; const t = newPart(p, { name: name.trim().slice(0, 60), code: autoCode(p, name), partNo: k.partNo || '', barcode: k.barcode || '', perPack: k.qty || null });
    const c = cropPkg(img, k, 220); const tb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)); const path = `thumbs/${t.id}.jpg`; await store.putFile(path, tb); t.thumb = path; await store.warmUrls([path]);
    store.change((q) => { q.parts.push(t); Object.assign(photoById(q, ph0.id).pkgs[i], { part: t.id, by: 'new part' }); logEvent(q, 'parts', `Added part ${t.name} from a package label`); }, { quiet: true });
    toast(`Added part ${esc(t.name)}. Open it in Inventory to fix the name.`); render();
  }
  let reading = false;
  async function readAll() {
    if (reading) return; reading = true;
    try {
      const bar = () => el.querySelector('#ocrBar'), txt = () => el.querySelector('#ocrTxt');
      const worker = await ocrWorker((m) => { if (m.status && txt()) txt().textContent = m.status === 'recognizing text' ? 'Reading labels…' : `Getting the text reader ready: ${m.status}`; });
      const det = await barcodeDetector();
      const ph = cur(); const list = ph.pkgs; let n = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].read) { n++; continue; }
        const r = await readPkg(worker, det, img, Object.assign({}, list[i]));
        const m = matchPart(store.project(), r); if (m && !r.part) Object.assign(r, { part: m.id, by: m.by, weak: !!m.weak });
        if (!r.qty && r.part) { const t = partById(store.project(), r.part); if (t && t.perPack) r.qty = t.perPack; }
        store.change((q) => { Object.assign(photoById(q, ph.id).pkgs[i], r); }, { quiet: true });
        n++; if (bar()) bar().style.width = Math.round((100 * n) / list.length) + '%'; if (txt()) txt().textContent = `Read ${n} of ${list.length} packages`;
      }
      mergeSame();
    } catch (e) { console.error(e); toast('Couldn’t read the labels: ' + esc(e.message || e) + '. Check your internet connection the first time.'); }
    reading = false; render();
  }
  function mergeSame() {
    // the same part number on several packages: say so (each package stays its own row)
    store.change((q) => { const ph = photoById(q, ph0.id); const seen = {}; for (const k of ph.pkgs) { const key = norm(k.partNo) || k.barcode; if (!key) continue; seen[key] = (seen[key] || 0) + 1; } ph.dupes = seen; }, { quiet: true });
  }
  function addAll() {
    store.change((q) => {
      const ph = photoById(q, ph0.id); const before = counts(q); let k = 0;
      ph.items = ph.pkgs.filter((x) => !x.skip && x.part && partById(q, x.part)).map((x) => ({ id: 'l' + k++, x: (x.box[0] + x.box[2]) / 2, y: (x.box[1] + x.box[3]) / 2, part: x.part, st: 'ok', n: (x.qty || 1) * (x.packs || 1), src: 'label' }));
      for (const x of ph.pkgs) { if (x.skip || !x.part) continue; const t = partById(q, x.part); if (!t) continue; if (!t.partNo && x.partNo) t.partNo = x.partNo; if (!t.barcode && x.barcode) t.barcode = x.barcode; if (!t.perPack && x.qty) t.perPack = x.qty; }
      ph.status = 'added'; ph.addedAt = Date.now();
      logEvent(q, 'labels', `Counted packages in ${ph.name}: ${pn(photoSummary(ph).pieces, 'piece')}`, diff(before, counts(q)));
    });
    toast('Added to the inventory', { label: 'See inventory', run: () => go(projPath('inventory')) });
    render();
  }
  render();
  void draw; void sortedParts; void decode;
}
