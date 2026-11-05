// Part editor (drawer) and adding parts from 3D model files.
import * as store from '../store.js';
import { newPart, partById, counts, setCount, logEvent, catOrder } from '../proj.js';
import { parseSTL, analyze, thumbnail, view3D } from '../stl.js';
import { esc, openDrawer, closeDrawer, toast, confirmBox, pickFiles, PALETTE, fmtBytes, busy, mm } from '../util.js';
import { thumbHTML, warmThumbs } from './common.js';

export function prettyName(file) {
  const base = file.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base[0].toUpperCase() + base.slice(1) : 'Part';
}
export function autoCode(p, name) {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let c = words.map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase())).join('').slice(0, 6) || 'P';
  const used = new Set(p.parts.map((t) => (t.code || '').toUpperCase())); let k = c, i = 2;
  while (used.has(k.toUpperCase())) k = c + '-' + i++;
  return k;
}

/** Attach an STL to a part: stores the file, measures it, renders a thumbnail. */
export async function attachModel(partId, file) {
  const buf = await file.arrayBuffer(); const stl = parseSTL(buf); const a = analyze(stl);
  const path = `models/${partId}.stl`; await store.putFile(path, new Blob([buf], { type: 'model/stl' }));
  let thumbPath = null;
  const t0 = partById(store.project(), partId);
  try { const tb = await thumbnail(stl, t0 && t0.color); if (tb) { thumbPath = `thumbs/${partId}.${tb.type === 'image/webp' ? 'webp' : 'png'}`; await store.putFile(thumbPath, tb); } } catch (e) { console.warn('thumbnail failed', e); }
  store.change((p) => {
    const t = partById(p, partId); if (!t) return;
    t.model = { file: path, name: file.name, bytes: buf.byteLength, tri: a.tri, size: a.size, vol: a.vol, flat: a.flat };
    if (!t.dims || !(t.dims.l > 0)) t.dims = a.dims;
    if (thumbPath) t.thumb = thumbPath;
  });
  return a;
}

export async function addPartsFromModels(files, { cat = '' } = {}) {
  const stls = files.filter((f) => /\.stl$/i.test(f.name)); if (!stls.length) { toast('Pick one or more .stl files.'); return []; }
  const ids = [];
  for (const f of stls) {
    const p = store.project(); const name = prettyName(f.name);
    const t = newPart(p, { name, code: autoCode(p, name), cat });
    store.change((q) => { q.parts.push(t); }, { quiet: true });
    try { await attachModel(t.id, f); ids.push(t.id); }
    catch (e) { store.change((q) => { q.parts = q.parts.filter((x) => x.id !== t.id); }, { quiet: true }); toast(`Couldn’t read ${esc(f.name)}: ${esc(e.message)}`); }
  }
  if (ids.length) store.change((p) => logEvent(p, 'parts', `Added ${ids.length} ${ids.length === 1 ? 'part' : 'parts'} from 3D models`));
  return ids;
}

export async function viewModel(t) {
  const b = await store.fileBlob(t.model.file); if (!b) { toast('The 3D model file is missing.'); return; }
  const stl = parseSTL(await b.arrayBuffer());
  view3D({ title: `${t.code ? t.code + ' · ' : ''}${t.name}`, stl, color: t.color, info: t.dims ? `About ${[t.dims.l, t.dims.w, t.dims.h].filter(Boolean).map((v) => Math.round(v * 10) / 10).join(' × ')} mm.` : '' });
}

/** Open the part editor. partId null creates a new part. */
export async function openPartEditor(partId, { preset = {}, onSaved } = {}) {
  const p = store.project(); await warmThumbs(p);
  const isNew = !partId; const t = isNew ? newPart(p, preset) : JSON.parse(JSON.stringify(partById(p, partId)));
  if (!t) return;
  const c = counts(p); const have = isNew ? 0 : c[t.id] || 0;
  const cats = catOrder(p).filter(Boolean);
  const ex = (p.vision.examples[t.id] || []).length;
  const d = openDrawer(`<header><div class="row grow" style="gap:12px">${thumbHTML(t)}<div class="grow"><h2 style="font-size:19px">${isNew ? 'New part' : esc(t.name)}</h2><div class="small muted">${isNew ? 'Fill in what you know. You can change it any time.' : esc([t.code, t.cat].filter(Boolean).join(' · '))}</div></div></div><button type="button" class="btn ghost small" data-close>Close</button></header>
    <div class="dbody">
      <div class="fields2">
        <label class="field" style="grid-column:1/-1"><span>Name</span><input id="fName" value="${esc(t.name)}" placeholder="e.g. M4 × 8 mm screw" autofocus></label>
        <label class="field"><span>Short code</span><input id="fCode" value="${esc(t.code)}" placeholder="e.g. M4-8" maxlength="12"><span class="hint">Shown on photos and plate files.</span></label>
        <label class="field"><span>Group</span><input id="fCat" value="${esc(t.cat)}" list="catList" placeholder="e.g. Screws"><datalist id="catList">${cats.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
      </div>
      <div class="field"><span>Color on photos and lists</span><div class="colorrow">${PALETTE.map((col) => `<button type="button" data-col="${col}" aria-pressed="${col === t.color}" style="background:${col}" aria-label="Color ${col}"></button>`).join('')}</div></div>
      <div class="field"><span>Size (mm)</span><div class="fields3">
        <label class="field"><span class="tiny">Length</span><input type="number" step="0.1" min="0" id="dL" value="${t.dims.l || ''}"></label>
        <label class="field"><span class="tiny">Width</span><input type="number" step="0.1" min="0" id="dW" value="${t.dims.w || ''}"></label>
        <label class="field"><span class="tiny">Height</span><input type="number" step="0.1" min="0" id="dH" value="${t.dims.h || ''}"></label></div>
        <span class="hint">Longest side first. Sizes help photo counting tell similar parts apart (like M3 × 8 and M3 × 10). A 3D model fills these in.</span></div>
      <div class="fields2">
        <label class="field"><span>Part number / SKU</span><input id="fNo" value="${esc(t.partNo)}" placeholder="e.g. 2802-0004-0008"><span class="hint">Matched when reading package labels.</span></label>
        <label class="field"><span>Pieces per package</span><input type="number" min="1" id="fPack" value="${t.perPack || ''}" placeholder="e.g. 25"></label>
        <label class="field"><span>Barcode</span><input id="fBar" value="${esc(t.barcode)}" placeholder="Scanned from a package"></label>
        <label class="field"><span>Weight of one piece (g)</span><input type="number" step="0.01" min="0" id="fWt" value="${t.weight || ''}" placeholder="For counting by weight later"></label>
      </div>
      <div class="field"><span>3D model</span>
        <div class="dropfile${t.model ? ' has' : ''}" id="mBox">${t.model ? `<div class="grow"><b>${esc(t.model.name)}</b><div class="small muted">${fmtBytes(t.model.bytes || 0)} · ${t.model.tri.toLocaleString()} triangles · ${t.model.vol} cm³ · ${t.model.size.map((v) => Math.round(v * 10) / 10).join(' × ')} mm</div></div>
          <button type="button" class="btn small" id="mView">View 3D</button><button type="button" class="btn small" id="mRep">Replace</button><button type="button" class="btn small ghost danger" id="mDel">Remove</button>`
          : `<div class="grow small muted">No model. Add an .stl to get a picture, exact sizes and print files.</div><button type="button" class="btn small" id="mAdd">Add .stl</button>`}</div></div>
      ${p.kits.length ? `<div class="field"><span>How many one kit needs</span><div style="display:grid;gap:6px">${p.kits.map((k) => `<label class="row"><span class="grow">${esc(k.name)}</span><input type="number" min="0" class="inp" style="width:90px" data-kit="${esc(k.id)}" value="${k.need[t.id] || 0}"></label>`).join('')}</div></div>` : ''}
      ${isNew ? `<label class="field"><span>How many you have now</span><input type="number" min="0" id="fHave" value="0"></label>` : `<div class="note">You have <b>${have}</b>. Change the count in Inventory.${ex ? ` Photo counting learned ${ex} ${ex === 1 ? 'look' : 'looks'} of this part. <button type="button" class="linkbtn" id="forget">Forget them</button>` : ''}</div>`}
      <label class="field"><span>Notes</span><textarea id="fNotes" placeholder="Where it’s stored, what it’s for, tips to tell it apart…">${esc(t.notes)}</textarea></label>
    </div>
    <footer>${isNew ? '' : '<button type="button" class="btn ghost danger" id="pDel">Delete part</button>'}<span class="spacer"></span><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="pSave">${isNew ? 'Add part' : 'Save'}</button></footer>`);
  const v = (id) => d.querySelector('#' + id);
  d.querySelectorAll('[data-col]').forEach((b) => (b.onclick = () => { t.color = b.dataset.col; d.querySelectorAll('[data-col]').forEach((x) => x.setAttribute('aria-pressed', x === b)); }));
  const collect = () => {
    t.name = v('fName').value.trim() || t.name; t.code = v('fCode').value.trim(); t.cat = v('fCat').value.trim();
    if (isNew && !t.code) t.code = autoCode(store.project(), t.name);
    t.dims = { l: +v('dL').value || null, w: +v('dW').value || null, h: +v('dH').value || null };
    t.partNo = v('fNo').value.trim(); t.perPack = +v('fPack').value || null; t.barcode = v('fBar').value.trim(); t.weight = +v('fWt').value || null; t.notes = v('fNotes').value;
  };
  const saveIt = () => {
    collect(); const needs = {}; d.querySelectorAll('[data-kit]').forEach((i) => (needs[i.dataset.kit] = Math.max(0, Math.round(+i.value || 0))));
    const hv = isNew ? Math.max(0, Math.round(+v('fHave').value || 0)) : null;
    store.change((q) => {
      let x = partById(q, t.id);
      if (!x) { x = t; q.parts.push(x); logEvent(q, 'parts', `Added part ${t.name}`); } else Object.assign(x, t);
      for (const k of q.kits) { if (needs[k.id] != null) { if (needs[k.id]) k.need[t.id] = needs[k.id]; else delete k.need[t.id]; } }
      if (hv) { setCount(q, t.id, hv); logEvent(q, 'manual', `Counted ${t.name} by hand`, { [t.id]: hv }); }
    });
    return t.id;
  };
  v('pSave').onclick = () => { const id = saveIt(); closeDrawer(); toast(isNew ? `Added ${esc(t.name)}` : 'Saved'); onSaved && onSaved(id); };
  const modelPick = async () => {
    const [f] = await pickFiles({ accept: '.stl,model/stl' }); if (!f) return;
    const id = saveIt(); await busy(v('mBox').querySelector('button'), () => attachModel(id, f).catch((e) => toast('Couldn’t read that file: ' + esc(e.message))));
    closeDrawer(); openPartEditor(id, { onSaved });
  };
  if (v('mAdd')) v('mAdd').onclick = modelPick;
  if (v('mRep')) v('mRep').onclick = modelPick;
  if (v('mView')) v('mView').onclick = () => viewModel(partById(store.project(), t.id));
  if (v('mDel')) v('mDel').onclick = async () => {
    if (!(await confirmBox({ title: 'Remove the 3D model?', text: 'The part stays. It won’t have a picture from the model or print files anymore.', ok: 'Remove', danger: true }))) return;
    const old = t.model.file, oldT = t.thumb; await store.delFile(old); if (oldT && oldT.startsWith('thumbs/')) await store.delFile(oldT);
    store.change((q) => { const x = partById(q, t.id); x.model = null; if (x.thumb === oldT) x.thumb = null; delete q.print[t.id]; });
    closeDrawer(); openPartEditor(t.id, { onSaved });
  };
  if (v('forget')) v('forget').onclick = () => { store.change((q) => { delete q.vision.examples[t.id]; }); toast('Forgot the learned looks'); v('forget').parentElement.textContent = 'Learned looks cleared.'; };
  if (v('pDel')) v('pDel').onclick = async () => {
    if (!(await confirmBox({ title: `Delete ${esc(t.name)}?`, text: 'It’s removed from kits and the print list. Pieces on photos that were this part become unknown.', ok: 'Delete part', danger: true }))) return;
    const files = [t.model && t.model.file, t.thumb].filter(Boolean); for (const f of files) await store.delFile(f);
    store.change((q) => {
      q.parts = q.parts.filter((x) => x.id !== t.id); delete q.adjust[t.id]; delete q.print[t.id]; delete q.vision.examples[t.id];
      for (const k of q.kits) delete k.need[t.id];
      for (const ph of q.photos) for (const it of ph.items || []) if (it.part === t.id) { it.part = null; it.st = 'check'; }
      logEvent(q, 'parts', `Deleted part ${t.name}`);
    });
    closeDrawer(); toast('Part deleted');
  };
  void mm;
}
