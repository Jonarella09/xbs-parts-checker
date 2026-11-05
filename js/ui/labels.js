// Package labels: read every label in a photo (PP-OCR text reader), group packages with the same part number,
// and add packages × pieces-per-package to the inventory, creating parts for numbers the project doesn't know yet.
import * as store from '../store.js';
import { partById, photoById, counts, diff, logEvent, newPart, photoSummary } from '../proj.js';
import { esc, pn, toast, confirmBox, when, fmtN } from '../util.js';
import { thumbHTML, warmThumbs, pickPart } from './common.js';
import { autoCode } from './part.js';
import { fixWords } from '../ocr/labelscan.js';
import { scanPhoto } from '../ocr/scan.js';
import { projPath, go } from '../main.js';

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const tokens = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9.]+/g) || []);
/** Which project part a label is: barcode, then part number, then a close name. */
export function matchPart(p, pk) {
  if (pk.barcode) { const t = p.parts.find((x) => x.barcode && x.barcode === pk.barcode); if (t) return { id: t.id, by: 'barcode' }; }
  const n0 = norm(pk.partNo);
  if (n0) { const t = p.parts.find((x) => norm(x.partNo) === n0); if (t) return { id: t.id, by: 'part number' }; return null; }
  const a = tokens(pk.name); let best = null;
  for (const x of p.parts) { const b = tokens(x.name); if (!a.size || !b.size) continue; let i = 0; for (const w of a) if (b.has(w)) i++; const j = i / (a.size + b.size - i); if (j >= 0.5 && (!best || j > best.j)) best = { id: x.id, j }; }
  return best ? { id: best.id, by: 'name', weak: true } : null;
}
function cropLabel(img, pk, size = 150) {
  const [x0, y0, x1, y1] = pk.box; const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.06);
  const X = Math.max(0, x0 - pad), Y = Math.max(0, y0 - pad), W = Math.min(img.naturalWidth || img.width, x1 + pad) - X, H = Math.min(img.naturalHeight || img.height, y1 + pad) - Y;
  const s = Math.min(size / W, size / H, 3); const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, X, Y, W, H, 0, 0, c.width, c.height); return c;
}
/** Group labels by part number. Labels without one stay on their own. */
function groupsOf(ph) {
  const map = new Map(); const loose = [];
  (ph.pkgs || []).forEach((k, i) => { if (!k.partNo) { loose.push(i); return; } const key = norm(k.partNo); if (!map.has(key)) map.set(key, { key, partNo: k.partNo, idx: [] }); map.get(key).idx.push(i); });
  const G = ph.lgroups || {};
  const groups = [...map.values()].map((g) => {
    const ks = g.idx.map((i) => ph.pkgs[i]); const meta = G[g.key] || {};
    const q = {}; ks.forEach((k) => { if (k.qty) q[k.qty] = (q[k.qty] || 0) + 1; }); const qBest = Object.entries(q).sort((a, b) => b[1] - a[1])[0];
    const name = meta.name != null ? meta.name : (ks.find((k) => k.name) || {}).name || '';
    const guessed = meta.qty == null && ks.every((k) => !k.qty || k.qtyGuess) && ks.some((k) => k.qtyGuess);
    return Object.assign(g, { ks, name, guessed, qty: meta.qty != null ? meta.qty : qBest ? +qBest[0] : null, packs: meta.packs != null ? meta.packs : ks.length, skip: !!meta.skip, part: meta.part, fixed: ks.filter((k) => k.fixed).length, barcode: (ks.find((k) => k.barcode) || {}).barcode || '' });
  }).sort((a, b) => b.ks.length - a.ks.length || a.partNo.localeCompare(b.partNo));
  return { groups, loose };
}

export async function labelsView(el, ph0) {
  const p0 = store.project(); await warmThumbs(p0);
  const url = await store.fileUrl(ph0.file); const img = new Image(); img.src = url; await img.decode().catch(() => {});
  const cur = () => photoById(store.project(), ph0.id);
  let scanning = false, prog = { f: 0, t: '' };
  const setG = (key, patch) => store.change((q) => { const P = photoById(q, ph0.id); P.lgroups = P.lgroups || {}; P.lgroups[key] = Object.assign({}, P.lgroups[key] || {}, patch); }, { quiet: true });

  function partFor(p, g) {
    if (g.part === 'new') return null; if (g.part && partById(p, g.part)) return partById(p, g.part);
    const m = matchPart(p, { partNo: g.partNo, barcode: g.barcode, name: g.name }); return m ? partById(p, m.id) : null;
  }
  const render = () => {
    const p = store.project(); const ph = cur(); if (!ph) return; const ro = ph.status !== 'draft';
    const { groups, loose } = ph.pkgs ? groupsOf(ph) : { groups: [], loose: [] };
    const inc = groups.filter((g) => !g.skip);
    const pieces = inc.reduce((a, g) => a + g.packs * (g.qty || 1), 0);
    const colorOf = (key) => { const i = groups.findIndex((g) => g.key === key); return i < 0 ? '#ffbf2e' : ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#84cc16', '#06b6d4', '#f97316'][i % 10]; };
    el.innerHTML = `<div class="page">
      <div class="hero"><div><a class="small" href="#/${projPath('count')}">← Count</a><h1 style="margin-top:4px">${esc(ph.name)} · labels</h1>
        <p class="sub">${ph.pkgs ? `${pn(ph.pkgs.length, 'label')} read: ${pn(groups.length, 'different part')}${loose.length ? `, ${loose.length} without a readable part number` : ''}. Packages with the same part number are counted together.` : 'Reading every label in the photo. This takes a minute or two for a big table.'}</p></div>
        <div class="btnrow">${ph.status === 'added' ? '<span class="tag ok">Counted</span>' : ph.status === 'archived' ? '<span class="tag">Archived</span>' : ''}${ph.pkgs && !ro ? '<button type="button" class="btn ghost small" id="rescan">Read again</button>' : ''}</div></div>
      ${!ph.pkgs ? `<div class="card pad" style="display:grid;gap:8px"><div class="progress"><i id="ocrBar" style="width:${Math.round(prog.f * 100)}%"></i></div><span class="small muted" id="ocrTxt">${esc(prog.t || 'Starting…')}</span><span class="tiny muted">The first time, the text reader downloads (about 30 MB). After that it works offline.</span></div>` : ''}
      <div class="card pad" style="display:grid;gap:10px"><div style="position:relative;max-height:52vh;overflow:auto;border-radius:10px;background:#1a1f26"><div style="position:relative;width:100%"><img src="${url}" alt="" style="width:100%;display:block">
        <svg viewBox="0 0 ${ph.W} ${ph.H}" style="position:absolute;inset:0;width:100%;height:100%">${(ph.pkgs || []).map((k, i) => { const [x0, y0, x1, y1] = k.box; const col = k.partNo ? colorOf(norm(k.partNo)) : '#ff4d4d'; const sw = Math.max(3, ph.W / 500);
          return `<rect data-k="${i}" style="cursor:pointer;pointer-events:all" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="transparent" stroke="${col}" stroke-width="${sw}" ${k.partNo ? '' : `stroke-dasharray="${sw * 3} ${sw * 2}"`}/><text x="${x0 + sw * 2}" y="${y0 + Math.max(24, ph.W / 70)}" font-size="${Math.max(22, ph.W / 75)}" fill="#fff" stroke="#000" stroke-width="${sw * 0.8}" paint-order="stroke" font-weight="700">${i + 1}</text>`; }).join('')}</svg></div></div></div>
      ${ph.pkgs ? `<div class="card"><div class="applybar"><div class="grow" style="display:grid;gap:2px"><b>${pn(pieces, 'piece')} in ${pn(inc.reduce((a, g) => a + g.packs, 0), 'package')}</b><span class="tiny muted">${inc.filter((g) => !partFor(p, g)).length ? `${pn(inc.filter((g) => !partFor(p, g)).length, 'new part')} will be added to the project. ` : ''}${inc.some((g) => !g.qty) ? 'Some packages have no pieces-per-package yet; they count as 1 each.' : ''}</span></div>
        ${ph.status === 'draft' ? `<button type="button" class="btn ghost small danger" id="lDiscard">Discard</button><button type="button" class="btn primary" id="lAdd" ${inc.length ? '' : 'disabled'}>Add to inventory</button>` : ph.status === 'added' ? `<span class="small muted">Added ${when(ph.addedAt)}</span>` : ''}</div></div>` : ''}
      <div class="pkgs">${groups.map((g) => groupHTML(p, g, ro, colorOf(g.key))).join('')}</div>
      ${loose.length ? `<div class="section-h"><h2>Labels without a readable part number</h2><span class="muted">Type the number if you can read it, or leave them out.</span></div><div class="pkgs">${loose.map((i) => looseHTML(ph.pkgs[i], i, ro)).join('')}</div>` : ''}
      ${ph.pkgs && !ph.pkgs.length ? '<div class="empty"><p>No labels were found. Lay the packages flat, label up, with light on them and no strong glare, and try again.</p></div>' : ''}
    </div>`;
    wire(p, ph, ro, groups);
    if (!ph.pkgs && !scanning) scan();
  };
  function groupHTML(p, g, ro, col) {
    const t = partFor(p, g);
    return `<article class="pkg${g.skip ? ' skip' : ''}" id="g-${esc(g.key)}" style="grid-template-columns:1fr;border-left:5px solid ${col}">
      <div class="row"><b style="font-size:16px" class="mono">${esc(g.partNo)}</b><span class="tag">${pn(g.ks.length, 'label')}</span>${g.fixed ? `<span class="tag warn" title="Read slightly differently on ${g.fixed} label(s), matched to the others">${g.fixed} corrected</span>` : ''}<span class="spacer"></span>${ro ? '' : `<label class="check small"><input type="checkbox" data-skip="${esc(g.key)}"${g.skip ? '' : ' checked'}> Count these</label>`}</div>
      <div class="row" style="gap:6px;overflow-x:auto">${g.idx.slice(0, 8).map((i) => `<canvas data-crop="${i}" width="10" height="10" style="border-radius:6px;background:var(--sunk);flex:none" title="Label ${i + 1}"></canvas>`).join('')}${g.idx.length > 8 ? `<span class="small muted">+${g.idx.length - 8}</span>` : ''}</div>
      <div class="pf" style="grid-template-columns:2fr 1fr 1fr 1fr">
        <label class="field"><span>Name</span><input class="inp" data-g="${esc(g.key)}" data-f="name" value="${esc(g.name)}" ${ro ? 'disabled' : ''}></label>
        <label class="field"><span>Part number</span><input class="inp mono" data-g="${esc(g.key)}" data-f="partNo" value="${esc(g.partNo)}" ${ro ? 'disabled' : ''}></label>
        <label class="field"><span>Pieces per package${g.guessed ? ' <span class="tag warn" title="Not readable on these labels; other packages of this series say this">guess</span>' : ''}</span><input class="inp" type="number" min="1" data-g="${esc(g.key)}" data-f="qty" value="${g.qty || ''}" placeholder="?" ${ro ? 'disabled' : ''}></label>
        <label class="field"><span>Packages</span><input class="inp" type="number" min="0" data-g="${esc(g.key)}" data-f="packs" value="${g.packs}" ${ro ? 'disabled' : ''} title="Labels read: ${g.ks.length}. Add packages hidden under others."></label>
      </div>
      <div class="row">${t ? `${thumbHTML(t, 'sm')}<span class="grow small"><b>${esc(t.name)}</b> <span class="muted">already in this project</span></span>` : `<span class="grow small muted">New part: it will be added to the project as “${esc(g.name || g.partNo)}”.</span>`}
        <b class="num">= ${fmtN(g.packs * (g.qty || 1))} pieces</b>${ro ? '' : `<button type="button" class="btn small" data-pick="${esc(g.key)}">${t ? 'Different part' : 'Use an existing part'}</button>`}</div></article>`;
  }
  function looseHTML(k, i, ro) {
    return `<article class="pkg skip" id="l-${i}" style="grid-template-columns:150px 1fr"><div class="pimg"><canvas data-crop="${i}" width="10" height="10"></canvas></div>
      <div style="display:grid;gap:6px;min-width:0"><b>Label ${i + 1}</b>${k.text ? `<div class="ptext">${esc(k.text)}</div>` : ''}
      ${ro ? '' : `<label class="field"><span>Part number</span><input class="inp mono" data-loose="${i}" placeholder="Type it to count this package"></label>`}</div></article>`;
  }
  function wire(p, ph, ro, groups) {
    el.querySelectorAll('[data-crop]').forEach((c) => { const k = ph.pkgs[+c.dataset.crop]; if (!k) return; const cc = cropLabel(img, k, c.closest('.pimg') ? 150 : 120); c.width = cc.width; c.height = cc.height; c.getContext('2d').drawImage(cc, 0, 0); });
    el.querySelectorAll('[data-k]').forEach((r) => (r.onclick = () => { const k = ph.pkgs[+r.dataset.k]; const t = el.querySelector(k.partNo ? `#g-${CSS.escape(norm(k.partNo))}` : `#l-${r.dataset.k}`); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.animate([{ boxShadow: '0 0 0 4px var(--star)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1400 }); } }));
    if (ro) return;
    const rs = el.querySelector('#rescan'); if (rs) rs.onclick = async () => { if (!(await confirmBox({ title: 'Read the labels again?', text: 'Your changes to names, numbers and quantities on this photo are lost.', ok: 'Read again' }))) return; store.change((q) => { const P = photoById(q, ph0.id); P.pkgs = null; P.lgroups = {}; }, { quiet: true }); render(); };
    el.querySelectorAll('[data-skip]').forEach((b) => (b.onchange = () => { setG(b.dataset.skip, { skip: !b.checked }); render(); }));
    el.querySelectorAll('[data-g]').forEach((inp) => (inp.onchange = () => {
      const key = inp.dataset.g, f = inp.dataset.f;
      if (f === 'partNo') { const v = inp.value.trim(); store.change((q) => { const P = photoById(q, ph0.id); for (const k of P.pkgs) if (norm(k.partNo) === key) k.partNo = v; if (P.lgroups && P.lgroups[key]) { P.lgroups[norm(v)] = Object.assign({}, P.lgroups[key], P.lgroups[norm(v)] || {}); } }, { quiet: true }); }
      else if (f === 'name') setG(key, { name: inp.value.trim() });
      else setG(key, { [f]: Math.max(f === 'packs' ? 0 : 1, Math.round(+inp.value || 0)) || null });
      render();
    }));
    el.querySelectorAll('[data-loose]').forEach((inp) => (inp.onchange = () => { const v = inp.value.trim(); if (!v) return; store.change((q) => { photoById(q, ph0.id).pkgs[+inp.dataset.loose].partNo = v; }, { quiet: true }); render(); }));
    el.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = async () => { const key = b.dataset.pick; const r = await pickPart(store.project(), { title: 'Which part are these packages?', allowNew: true }); if (!r) return; setG(key, { part: r === '__new' ? 'new' : r }); render(); }));
    const add = el.querySelector('#lAdd'); if (add) add.onclick = () => addAll(groups);
    const dis = el.querySelector('#lDiscard'); if (dis) dis.onclick = async () => { if (!(await confirmBox({ title: 'Discard this photo?', text: 'Nothing from it was counted yet.', ok: 'Discard', danger: true }))) return; await store.delFile(ph.file); if (ph.thumb) await store.delFile(ph.thumb); store.change((q) => { q.photos = q.photos.filter((x) => x.id !== ph.id); }); go(projPath('count')); };
  }
  async function scan() {
    scanning = true;
    try {
      const known = store.project().parts.map((t) => t.partNo).filter(Boolean);
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
      const pk = await scanPhoto(c, { known, onProgress: (f, t) => { prog = { f, t }; const b = el.querySelector('#ocrBar'), x = el.querySelector('#ocrTxt'); if (b) b.style.width = Math.round(f * 100) + '%'; if (x) x.textContent = t; } });
      const keep = pk.map((k) => ({ box: k.box, partNo: k.partNo || '', name: fixWords(k.name || ''), qty: k.qty || null, qtyGuess: !!k.qtyGuess, text: k.text, conf: +(k.partConf || 0).toFixed(2), fixed: !!k.fixed, readAs: k.readAs || undefined }));
      store.change((q) => { const P = photoById(q, ph0.id); P.pkgs = keep; P.lgroups = {}; P.scannedAt = Date.now(); }, { quiet: true });
    } catch (e) { console.error(e); toast('Couldn’t read the labels: ' + esc(e.message || e) + (navigator.onLine ? '' : ' (the text reader needs the internet the first time)')); prog = { f: 0, t: 'Stopped: ' + (e.message || e) }; }
    scanning = false; render();
  }
  async function addAll(groups) {
    const p = store.project(); const inc = groups.filter((g) => !g.skip);
    const made = [];
    for (const g of inc) {
      let t = partFor(p, g);
      if (!t) {
        const nm = (g.name || g.partNo).slice(0, 80); t = newPart(store.project(), { name: nm, code: autoCode(store.project(), g.partNo.replace(/^\d{4}-/, '').replace(/-/g, '') || nm), partNo: g.partNo, perPack: g.qty || null, barcode: g.barcode || '' });
        const best = g.ks.slice().sort((a, b) => (b.conf || 0) - (a.conf || 0))[0]; const c = cropLabel(img, best, 220);
        const tb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)); const path = `thumbs/${t.id}.jpg`; await store.putFile(path, tb); t.thumb = path;
        store.change((q) => { q.parts.push(t); }, { quiet: true }); made.push(t);
      }
      g.partId = t.id;
    }
    store.change((q) => {
      const P = photoById(q, ph0.id); const before = counts(q);
      P.items = inc.map((g, k) => ({ id: 'l' + k, x: g.ks[0].box[0], y: g.ks[0].box[1], part: g.partId, st: 'ok', n: g.packs * (g.qty || 1), src: 'label' }));
      for (const g of inc) { const t = partById(q, g.partId); if (!t) continue; if (!t.partNo) t.partNo = g.partNo; if (!t.perPack && g.qty) t.perPack = g.qty; if (!t.barcode && g.barcode) t.barcode = g.barcode; }
      P.status = 'added'; P.addedAt = Date.now();
      if (made.length) logEvent(q, 'parts', `Added ${pn(made.length, 'part')} from package labels`);
      logEvent(q, 'labels', `Counted packages in ${P.name}: ${pn(photoSummary(P).pieces, 'piece')}`, diff(before, counts(q)));
    });
    await warmThumbs(store.project());
    toast(`Added ${pn(inc.reduce((a, g) => a + g.packs * (g.qty || 1), 0), 'piece')} to the inventory`, { label: 'See inventory', run: () => go(projPath('inventory')) });
    render();
  }
  render();
}
