// Count: add a photo, find the pieces, check the guesses, add them to the inventory.
import * as store from '../store.js';
import { partById, sortedParts, photoById, photoSummary, tally, counts, diff, logEvent, newPart, isCounted } from '../proj.js';
import { esc, pn, toast, confirmBox, promptBox, pickFiles, uid, clamp, PALETTE, inkOn, fmtN, when, openModal, closeModal } from '../util.js';
import { thumbHTML, warmThumbs, pickPart, codeTag } from './common.js';
import { openPartEditor, autoCode } from './part.js';
import { decode, analyzeCanvas, canvasFromRGBA, toJpeg, thumbOf, call, pixels, stopEngine } from '../vision/client.js';
import { refsFor, ensureSilhouettes, estimateScale, classify, group, similarTo, learn, feat, compact, letters } from '../vision/match.js';
import { openMatDialog } from '../vision/mat.js';
import { go, projPath } from '../main.js';

const MODES = {
  parts: { t: 'Identify parts', icon: '◎', d: 'A mix of different parts. Each piece is matched to a part in this project. Pieces it doesn’t know are grouped so you can name them.' },
  quick: { t: 'Count one kind', icon: '#', d: 'A pile of the same thing: screws, washers, balls. Tap one, and it counts everything like it.' },
  labels: { t: 'Read package labels', icon: 'Aa', d: 'Packages laid out on a table, labels up. It reads every label’s part number and pack size, and counts identical packages together.' },
};
const DEF = { shadow: null, minMM: 1.6, detail: 'normal', split: true };
const S = { mode: 'parts', sel: -1, filter: null, s: 1, tx: 0, ty: 0, fit: 1, tool: null, measureA: null, img: null, imgFor: null, outlines: true, thr: 1.15 };

export async function mount(el, route, ctx) {
  const pid = () => store.project().id;
  ctx.dropHandler = { label: 'Drop a photo to count it', run: (files) => { const f = files.find((x) => /^image\//.test(x.type)); if (f) startPhoto(f); else toast('That isn’t a photo.'); } };
  const settings = () => Object.assign({}, DEF, store.project().vision.settings || {});
  const keyH = (e) => onKey(e); document.addEventListener('keydown', keyH);
  let progress = null;

  async function draw() {
    const r = ctx.route(); const p = store.project(); await warmThumbs(p);
    const ph = r.sub[0] ? photoById(p, r.sub[0]) : null;
    if (r.sub[0] && !ph) { go(projPath('count')); return; }
    if (!ph) return startView(p);
    if (ph.mode === 'labels') { const L = await import('./labels.js'); return L.labelsView(el, ph); }
    return workspace(p, ph);
  }

  /* ================= start ================= */
  function startView(p) {
    const st = settings(); const drafts = p.photos.filter((x) => x.status === 'draft').sort((a, b) => b.at - a.at);
    const noParts = !p.parts.length;
    if (noParts && S.mode === 'parts') S.mode = 'parts';
    el.innerHTML = `<div class="page">
      <div class="hero"><div><h1>Count from a photo</h1><p class="sub">Lay the pieces on a plain surface, take a photo from above, and check what it finds. Every fix you make teaches it what your parts look like.</p></div>
        <div class="btnrow"><button type="button" class="btn" id="mat">Print a counting mat</button></div></div>
      ${drafts.length ? `<div class="card pad" style="display:grid;gap:8px"><b>Still being checked</b>${drafts.map((d) => `<div class="row"><a href="#/${projPath('count', d.id)}">${esc(d.name)}</a><span class="small muted">${esc(MODES[d.mode] ? MODES[d.mode].t : '')} · ${when(d.at)} · ${pn(photoSummary(d).pieces, 'piece')}</span></div>`).join('')}</div>` : ''}
      <div class="modes" role="radiogroup" aria-label="What’s in the photo">${Object.entries(MODES).map(([k, m]) => `<button type="button" class="mode" role="radio" data-mode="${k}" aria-checked="${S.mode === k}" style="${S.mode === k ? 'border-color:var(--accent);background:var(--accent-soft)' : ''}"><span class="mi">${m.icon}</span><b>${m.t}</b><span>${m.d}</span></button>`).join('')}</div>
      ${S.mode === 'parts' && noParts ? '<div class="note info">This project has no parts yet, so every piece will be grouped by look and size. Name each group and it becomes a part (and it learns what that part looks like).</div>' : ''}
      <div class="card pad" style="display:grid;gap:14px;justify-items:center;text-align:center;border-style:dashed">
        <b style="font-size:17px">Add a photo</b><span class="muted small">Drop it here, choose a file, or take one with your phone or tablet.</span>
        <div class="btnrow" style="justify-content:center"><button type="button" class="btn primary" id="choose">Choose a photo</button><button type="button" class="btn" id="take">Take a photo</button></div>
        <div id="prog" hidden style="width:min(420px,100%);display:grid;gap:6px"><div class="row" style="flex-wrap:nowrap;gap:10px"><div class="progress" style="flex:1"><i id="progBar"></i></div><button type="button" class="btn small" id="progStop">Stop</button></div><span class="small muted" id="progTxt"></span></div>
      </div>
      <details class="card pad"><summary><b>Detection settings</b> <span class="small muted">· for tricky photos</span></summary>
        <div style="display:grid;gap:14px;margin-top:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
          <label class="slider"><span class="flabel">Shadows ${st.shadow == null ? '<span class="tiny muted">(automatic)</span>' : '<button type="button" class="linkbtn tiny" id="sAuto">back to automatic</button>'}</span><input type="range" id="sShadow" min="0.4" max="0.9" step="0.02" value="${st.shadow == null ? 0.6 : st.shadow}"><span class="t"><span>Ignore more shadow</span><span>Keep dark pieces</span></span></label>
          <label class="slider"><span class="flabel">Smallest piece: <b id="sMinV">${st.minMM}</b> mm</span><input type="range" id="sMin" min="0.8" max="12" step="0.2" value="${st.minMM}"><span class="t"><span>Tiny parts</span><span>Ignore crumbs</span></span></label>
          <label class="field"><span>Detail</span><select id="sDetail"><option value="normal"${st.detail === 'normal' ? ' selected' : ''}>Normal (faster)</option><option value="high"${st.detail === 'high' ? ' selected' : ''}>High (small parts, big photos)</option></select></label>
          <label class="check"><input type="checkbox" id="sSplit"${st.split ? ' checked' : ''}> <span>Split pieces that touch</span></label>
        </div></details>
      <div class="steps3">
        <div class="s"><i>BACKGROUND</i><b>Plain and different</b><span class="small muted">A surface in one colour that the pieces don’t share. Metal on white is hard; on blue or green paper it’s easy.</span></div>
        <div class="s"><i>SPACING</i><b>Not touching</b><span class="small muted">Spread pieces out. Touching ones are split or estimated, but separate is always more accurate.</span></div>
        <div class="s"><i>SIZE</i><b>Use the counting mat</b><span class="small muted">With the mat in the photo it knows real sizes in mm, so it can tell similar parts apart.</span></div>
        <div class="s"><i>LIGHT</i><b>Even, from above</b><span class="small muted">Daylight or a ceiling light. Avoid a single lamp to one side; it makes long shadows.</span></div></div>
    </div>`;
    el.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { S.mode = b.dataset.mode; startView(p); }));
    el.querySelector('#mat').onclick = () => openMatDialog();
    el.querySelector('#choose').onclick = async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) startPhoto(f); };
    el.querySelector('#take').onclick = async () => { const [f] = await pickFiles({ accept: 'image/*', capture: 'environment' }); if (f) startPhoto(f); };
    const saveSet = (k, v) => store.change((q) => { q.vision.settings[k] = v; }, { quiet: true });
    el.querySelector('#sShadow').onchange = (e) => saveSet('shadow', +e.target.value);
    const sa = el.querySelector('#sAuto'); if (sa) sa.onclick = (e) => { e.preventDefault(); saveSet('shadow', null); startView(store.project()); };
    el.querySelector('#sMin').oninput = (e) => { el.querySelector('#sMinV').textContent = e.target.value; }; el.querySelector('#sMin').onchange = (e) => saveSet('minMM', +e.target.value);
    el.querySelector('#sDetail').onchange = (e) => saveSet('detail', e.target.value);
    el.querySelector('#sSplit').onchange = (e) => saveSet('split', e.target.checked);
    el.querySelector('#progStop').onclick = (e) => { S.stop = true; e.target.disabled = true; e.target.textContent = 'Stopping…'; stopEngine(); };
    progress = (f, t) => { const box = el.querySelector('#prog'); if (!box) return; if (f === 0 && !t) { box.hidden = true; const b = el.querySelector('#progStop'); b.disabled = false; b.textContent = 'Stop'; return; } box.hidden = false; el.querySelector('#progBar').style.width = Math.round(f * 100) + '%'; el.querySelector('#progTxt').textContent = t || ''; };
  }

  /* ================= processing a new photo ================= */
  async function startPhoto(file) {
    const p = store.project(); const st = settings(); const mode = S.mode;
    const pr = (f, t) => progress && progress(f, t);
    S.stop = false; const check = () => { if (S.stop) throw Object.assign(new Error('Stopped'), { stopped: true }); };
    try {
      pr(0.02, 'Opening the photo');
      if (mode === 'labels') {
        // labels are read at full detail later (on the labels page); just keep the photo sharp
        const { canvas: lc } = await decode(file, 16e6, 6000); check();
        const id = uid('ph_'); const f2 = `photos/${id}.jpg`, th = `photos/${id}_t.jpg`;
        await store.putFile(f2, await toJpeg(lc, 0.92)); await store.putFile(th, await thumbOf(lc));
        store.change((q) => { q.photos.push({ id, name: `Photo ${p.photos.length + 1}`, file: f2, thumb: th, W: lc.width, H: lc.height, mode, status: 'draft', at: Date.now(), items: [], pkgs: null }); });
        go(projPath('count', id)); return;
      }
      const maxPx = st.detail === 'high' ? 12e6 : 7e6;
      let { canvas } = await decode(file, maxPx, st.detail === 'high' ? 5200 : 4200);
      if (mode !== 'labels' && p.parts.some((t) => t.model && !t.model.sil)) await ensureSilhouettes((f, t) => pr(0.03 + f * 0.1, t)); check();
      const opts = mode === 'labels' ? { mode: 'labels', split: false, shadow: st.shadow, minMM: 25, minArea: Math.round(canvas.width * canvas.height * 0.0015) } : { mode, shadow: st.shadow, minMM: st.minMM, split: st.split };
      check();
      const res = await analyzeCanvas(canvas, opts, (f, t) => pr(0.15 + f * 0.7, t)); check();
      if (res.rgba) canvas = canvasFromRGBA(res.rgba, res.W, res.H);
      const id = uid('ph_'); const file2 = `photos/${id}.jpg`, thumb = `photos/${id}_t.jpg`;
      pr(0.9, 'Saving the photo');
      await store.putFile(file2, await toJpeg(canvas)); await store.putFile(thumb, await thumbOf(canvas));
      const ph = { id, name: `Photo ${p.photos.length + 1}`, file: file2, thumb, W: canvas.width, H: canvas.height, ppm: res.ppm || null, scaleSrc: res.scaleSrc || null, mat: res.mat || null, mode, status: 'draft', at: Date.now(), items: [], groups: [], bg: res.bg };
      if (mode === 'labels') {
        ph.pkgs = res.objs.map((o, k) => ({ id: 'k' + k, box: o.box, x: o.x, y: o.y, poly: thin(o.poly), skip: false }));
        store.change((q) => { q.photos.push(ph); });
        go(projPath('count', id)); return;
      }
      ph.items = res.objs.map((o, k) => ({ id: 'i' + k, x: +o.x.toFixed(1), y: +o.y.toFixed(1), poly: thin(o.poly), box: o.box, f: compact(o), edge: o.edge || undefined }));
      // a photo of labelled packages? offer to read the labels instead
      try { const px = pixels(canvas); const fl = await call('findLabels', { rgba: px.data.buffer, W: px.width, H: px.height, opts: {} }, [px.data.buffer]); if (fl.labels.length >= 4) ph.labelHint = fl.labels.length; } catch (e) {}
      check();
      if (mode === 'parts') matchPhoto(p, ph); else ph.items.forEach((it) => { it.st = 'unknown'; it.part = null; });
      store.change((q) => { q.photos.push(ph); });
      go(projPath('count', id));
    } catch (e) { if (e && e.stopped) toast('Stopped. Nothing was saved from that photo.'); else { console.error(e); toast('Couldn’t read that photo: ' + esc(e.message || e)); } pr(0, ''); }
  }
  const thin = (poly) => { if (!poly) return null; const n = poly.length / 2; if (n <= 48) return poly; const out = []; for (let k = 0; k < 48; k++) { const i = Math.floor((k * n) / 48); out.push(poly[i * 2], poly[i * 2 + 1]); } return out; };

  /** Match all not-yet-confirmed items of a photo against the project's parts. */
  function matchPhoto(p, ph) {
    const refs = refsFor(p);
    const idx = ph.items.map((it, i) => i).filter((i) => ph.items[i].f);
    const objs = idx.map((i) => Object.assign({}, ph.items[i].f, { edge: ph.items[i].edge }));
    if (!ph.ppm || ph.scaleSrc === 'parts') { const est = estimateScale(objs, refs); if (est) { ph.ppm = +est.ppm.toFixed(4); ph.grow = est.grow; ph.scaleSrc = 'parts'; ph.scaleSupport = est.support; } }
    else if (!ph.grow) { const est = estimateScale(objs, refs, ph.ppm); ph.grow = est ? est.grow : null; }
    if (!ph.ppm && ph.ppu == null) {
      // no mm scale: use project units. The first such photo defines them; later ones are lined up with the pieces learned in them.
      const rel = refs.filter((r) => r.f.rel);
      if (!rel.length) ph.ppu = 1; else { const e = estimateScale(objs, rel, null, { rel: true }); ph.ppu = e ? +e.ppm.toFixed(4) : null; }
    }
    const res = classify(objs, refs, ph.ppm, { grow: ph.grow, ppu: ph.ppm ? null : ph.ppu });
    idx.forEach((i, k) => { const it = ph.items[i]; if (it.lock) return; const r = res[k]; it.part = r.part; it.st = r.st; it.conf = +((r.conf || 0).toFixed(2)); it.alts = r.alts; it.why = r.why; it.n = r.n || 1; delete it.grp; });
    // pieces that match nothing are grouped by look, so a whole group can be named at once
    const tmp = idx.map((i) => ({ part: ph.items[i].part, st: ph.items[i].st }));
    ph.groups = group(objs, tmp, ph.ppm);
    tmp.forEach((t, k) => { const it = ph.items[idx[k]]; if (t.grp && !it.part) it.grp = t.grp; });
  }

  /* ================= workspace ================= */
  function workspace(p, ph) {
    const ro = ph.status === 'archived';
    el.innerHTML = `<div class="page wide" style="padding-top:12px"><div class="ws">
      <div class="viewer" id="vw" aria-label="Photo. Drag to move, scroll or pinch to zoom, click a piece to check it.">
        <div class="stagewrap" id="stg"><img class="photo" id="pimg" alt=""><svg class="ov" id="ov"></svg></div>
        <div class="vtools"><button type="button" class="btn small" id="tFit">Fit</button>${ro ? '' : `<button type="button" class="btn small" id="tAdd" aria-pressed="${S.tool === 'add'}">+ Missed piece</button><button type="button" class="btn small" id="tMeasure" aria-pressed="${S.tool === 'measure'}">Set scale</button>`}<button type="button" class="btn small" id="tOut" aria-pressed="${S.outlines}">Outlines</button></div>
        <div class="vhint" id="vhint"></div>
      </div>
      <div class="side" id="side"></div></div></div>`;
    S.sel = -1; S.filter = null;
    setupViewer(ph); renderSide();
  }
  function cur() { const p = store.project(); return photoById(p, ctx.route().sub[0]); }
  const colorOf = (p, ph, it) => { if (it.st === 'gone') return '#9aa3ad'; if (it.part) { const t = partById(p, it.part); return t ? t.color : '#999'; } const gi = (ph.groups || []).findIndex((g) => g.id === it.grp); return gi >= 0 ? PALETTE[(gi + 3) % PALETTE.length] : '#e5e7eb'; };

  /* ---- viewer: pan, zoom, select ---- */
  async function setupViewer(ph) {
    const vw = el.querySelector('#vw'), stg = el.querySelector('#stg'), img = el.querySelector('#pimg');
    const url = await store.fileUrl(ph.file); img.src = url; await img.decode().catch(() => {});
    S.img = img; S.imgFor = ph.id;
    const fit = () => { const r = vw.getBoundingClientRect(); S.fit = Math.min(r.width / ph.W, r.height / ph.H); S.s = S.fit; S.tx = (r.width - ph.W * S.s) / 2; S.ty = (r.height - ph.H * S.s) / 2; apply(); };
    const apply = () => { stg.style.transform = `translate(${S.tx}px,${S.ty}px) scale(${S.s})`; drawOverlay(); };
    S.apply = apply; S.fitFn = fit;
    img.style.width = ph.W + 'px'; img.style.height = ph.H + 'px';
    const ov = el.querySelector('#ov'); ov.setAttribute('width', ph.W); ov.setAttribute('height', ph.H); ov.setAttribute('viewBox', `0 0 ${ph.W} ${ph.H}`);
    fit(); new ResizeObserver(() => { if (Math.abs(S.s - S.fit) < 1e-6) fit(); }).observe(vw);
    const zoomAt = (cx, cy, f) => { const r = vw.getBoundingClientRect(); const x = cx - r.left, y = cy - r.top; const ns = clamp(S.s * f, S.fit * 0.5, 8); S.tx = x - ((x - S.tx) * ns) / S.s; S.ty = y - ((y - S.ty) * ns) / S.s; S.s = ns; apply(); };
    vw.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    const pts = new Map(); let moved = 0, pinch = 0, down = null;
    vw.addEventListener('pointerdown', (e) => { if (e.target.closest('.vtools')) return; vw.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; down = [e.clientX, e.clientY]; });
    vw.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return; const [x0, y0] = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinch); pinch = d; moved += 10; return; }
      moved += Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0); if (moved > 4) { S.tx += e.clientX - x0; S.ty += e.clientY - y0; apply(); }
    });
    const up = (e) => { const was = pts.has(e.pointerId); pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; if (was && moved <= 4 && down && pts.size === 0) clickAt(e.clientX, e.clientY); };
    vw.addEventListener('pointerup', up); vw.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); });
    el.querySelector('#tFit').onclick = fit;
    const tOut = el.querySelector('#tOut'); tOut.onclick = () => { S.outlines = !S.outlines; tOut.setAttribute('aria-pressed', S.outlines); drawOverlay(); };
    const tAdd = el.querySelector('#tAdd'); if (tAdd) tAdd.onclick = () => { S.tool = S.tool === 'add' ? null : 'add'; S.measureA = null; syncTools(); };
    const tMe = el.querySelector('#tMeasure'); if (tMe) tMe.onclick = () => { S.tool = S.tool === 'measure' ? null : 'measure'; S.measureA = null; syncTools(); };
    syncTools();
  }
  function syncTools() {
    const ta = el.querySelector('#tAdd'), tm = el.querySelector('#tMeasure'), h = el.querySelector('#vhint'), vw = el.querySelector('#vw'); if (!h) return;
    if (ta) ta.setAttribute('aria-pressed', S.tool === 'add'); if (tm) tm.setAttribute('aria-pressed', S.tool === 'measure');
    vw.classList.toggle('adding', !!S.tool);
    const ph = cur();
    h.textContent = S.tool === 'add' ? 'Click a piece it missed to add it.' : S.tool === 'measure' ? (S.measureA ? 'Now click the other end.' : 'Click both ends of something you know the length of.') : ph && ph.mode === 'quick' && !(ph.quick && ph.quick.ex && ph.quick.ex.length) ? 'Tap one piece of the kind you want to count.' : 'Drag to move · scroll or pinch to zoom · click a piece';
  }
  function toImg(cx, cy) { const r = el.querySelector('#vw').getBoundingClientRect(); return [(cx - r.left - S.tx) / S.s, (cy - r.top - S.ty) / S.s]; }
  function hitTest(ph, x, y) {
    let best = -1, bd = Infinity;
    ph.items.forEach((it, i) => {
      if (it.poly && inPoly(it.poly, x, y)) { const d = Math.hypot(it.x - x, it.y - y) * 0.2; if (d < bd) { bd = d; best = i; } return; }
      const r = itemR(ph, it); const d = Math.hypot(it.x - x, it.y - y); if (d < r * 1.2 + 6 / S.s && d < bd) { bd = d; best = i; }
    });
    return best;
  }
  const itemR = (ph, it) => { if (it.poly) { let m = 0; for (let k = 0; k < it.poly.length; k += 2) m = Math.max(m, Math.hypot(it.poly[k] - it.x, it.poly[k + 1] - it.y)); return m; } const t = it.part && partById(store.project(), it.part); const mmR = t && t.dims && t.dims.l ? Math.max(4, t.dims.w || t.dims.l) / 2 : 6; return mmR * (ph.ppm || 4); };
  function inPoly(poly, x, y) { let c = false; for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) { const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }

  async function clickAt(cx, cy) {
    const ph = cur(); if (!ph) return; const [x, y] = toImg(cx, cy); if (x < 0 || y < 0 || x > ph.W || y > ph.H) return;
    if (S.tool === 'measure') {
      if (!S.measureA) { S.measureA = [x, y]; syncTools(); drawOverlay(); return; }
      const d = Math.hypot(x - S.measureA[0], y - S.measureA[1]); const a = S.measureA; S.measureA = null; S.tool = null; syncTools();
      const v = await promptBox({ title: 'How long is that?', label: 'Real length in millimetres', value: '', placeholder: 'e.g. 50', ok: 'Set scale' });
      const mmv = parseFloat(String(v || '').replace(',', '.')); if (!(mmv > 0)) { drawOverlay(); return; }
      edit((q, P) => { P.ppm = +(d / mmv).toFixed(4); P.scaleSrc = 'manual'; P.grow = null; matchPhoto(q, P); }, null);
      toast(`Scale set: ${fmtN(d / mmv)} pixels per mm`); void a; return;
    }
    if (S.tool === 'add') {
      if (ph.status === 'archived') return; S.tool = null; syncTools();
      const pidr = await pickPart(store.project(), { title: 'What is this piece?', hint: 'Pick the part, or make a new one.' }); if (!pidr) return;
      let part = pidr; if (pidr === '__new') { part = await newPartFlow(ph, null); if (!part) return; }
      edit((q, P) => { P.items.push({ id: 'h' + uid(), x: +x.toFixed(1), y: +y.toFixed(1), part, st: 'ok', n: 1, src: 'hand', lock: true }); }, 'Added a missed piece');
      S.sel = cur().items.length - 1; renderSide(); return;
    }
    if (ph.mode === 'quick') { quickTap(ph, hitTest(ph, x, y)); return; }
    const i = hitTest(ph, x, y); S.sel = i; renderSide(); drawOverlay();
  }

  /* ---- overlay ---- */
  function drawOverlay() {
    const ph = cur(); const ov = el.querySelector('#ov'); if (!ph || !ov) return; const p = store.project();
    const sw = 1 / S.s; const fs = Math.max(10, 13 / S.s); let h = '';
    const showLbl = S.s > S.fit * 1.3 || ph.items.length < 120;
    ph.items.forEach((it, i) => {
      const hid = S.filter && !matchesFilter(it); const col = colorOf(p, ph, it); const sel = i === S.sel;
      const dash = it.st === 'check' || it.st === 'unknown' ? `stroke-dasharray="${6 * sw} ${4 * sw}"` : '';
      const qOut = ph.mode === 'quick' && it.st === 'gone';
      const op = hid ? 0.15 : qOut ? 0.3 : it.st === 'gone' ? 0.45 : 1;
      if (S.outlines && it.poly) h += `<polygon class="o${sel ? ' sel' : ''}" points="${it.poly.join(' ')}" stroke="${sel ? '#fff' : col}" ${dash} opacity="${op}" fill="${sel ? 'rgba(255,255,255,.18)' : 'none'}"/>`;
      else { const r = Math.max(5 * sw, Math.min(itemR(ph, it) * 0.35, 14 * sw)); h += `<circle class="dot" cx="${it.x}" cy="${it.y}" r="${sel ? r * 1.5 : r}" fill="${col}" opacity="${op}" ${it.st === 'check' || it.st === 'unknown' ? `stroke="${it.st === 'check' ? '#ff9d2e' : '#fff'}" stroke-width="3"` : ''}/>`; }
      if (it.st === 'gone' && !hid && !qOut) { const r = 6 * sw; h += `<path d="M${it.x - r} ${it.y - r}L${it.x + r} ${it.y + r}M${it.x + r} ${it.y - r}L${it.x - r} ${it.y + r}" stroke="#fff" stroke-width="${2 * sw}"/>`; }
      if (showLbl && !hid && it.st !== 'gone') { const t = it.part && partById(p, it.part); const g = !t && (ph.groups || []).find((x) => x.id === it.grp); const lab = (t ? t.code || t.name.slice(0, 6) : g ? g.name.replace('Group ', '') : '?') + ((it.n || 1) > 1 ? '×' + it.n : '') + (it.st === 'check' ? '?' : '');
        h += `<text class="lbl" x="${it.x}" y="${it.y - Math.min(itemR(ph, it), 40 / S.s) - 3 * sw}" text-anchor="middle" font-size="${fs}" style="stroke-width:${3 * sw}px">${esc(lab)}</text>`; }
    });
    if (ph.quick && ph.quick.ex) for (const i of ph.quick.ex) { const it = ph.items[i]; if (it) h += `<circle cx="${it.x}" cy="${it.y}" r="${Math.max(10 * sw, itemR(ph, it) * 1.15)}" fill="none" stroke="#ffbf2e" stroke-width="${4 * sw}"/>`; }
    if (S.measureA) h += `<circle cx="${S.measureA[0]}" cy="${S.measureA[1]}" r="${6 * sw}" fill="#ffbf2e"/>`;
    ov.innerHTML = h;
  }
  const matchesFilter = (it) => { const f = S.filter; if (!f) return true; if (f === 'check') return it.st === 'check' || it.st === 'unknown'; if (f.startsWith('g:')) return !it.part && it.grp === f.slice(2) && it.st !== 'gone'; if (f === 'gone') return it.st === 'gone'; return it.part === f && it.st !== 'gone'; };

  /* ---- editing helpers ---- */
  function edit(fn, logText) {
    const ph0 = cur(); if (!ph0) return; const id = ph0.id;
    store.change((q) => {
      const P = photoById(q, id); const before = isCounted(P) ? counts(q) : null; fn(q, P);
      if (before && logText) { const d = diff(before, counts(q)); if (Object.keys(d).length) { const last = q.log[0]; if (last && last.photo === id && last.kind === 'photo-edit' && Date.now() - last.t < 90000) { for (const k in d) last.d[k] = (last.d[k] || 0) + d[k]; last.t = Date.now(); } else { logEvent(q, 'photo-edit', `Corrected ${P.name}`, d); q.log[0].photo = id; } } }
    }, { quiet: true });
    renderSide(); drawOverlay(); ctx.refreshBar();
  }
  async function newPartFlow(ph, it, groupId) {
    const p = store.project(); const ff = it && it.f ? feat(it.f, ph.ppm, ph.ppu) : null;
    const g = groupId && (ph.groups || []).find((x) => x.id === groupId);
    const nm = await promptBox({ title: 'New part', label: 'What is it called?', value: '', placeholder: g ? `e.g. M3 × 10 screw (${g.n} pieces in ${g.name})` : 'e.g. M3 × 10 screw', ok: 'Create part' });
    if (!nm) return null;
    const t = newPart(p, { name: nm, code: autoCode(p, nm), dims: ff && ff.mm ? { l: +ff.L.toFixed(1), w: +ff.W.toFixed(1), h: null } : {} });
    // thumbnail from the photo
    let thumbPath = null; if (it && S.img) { const c = cropCanvas(ph, it, 200, false); if (c) { thumbPath = `thumbs/${t.id}.jpg`; await store.putFile(thumbPath, await toJpeg(c, 0.85)); t.thumb = thumbPath; } }
    store.change((q) => { q.parts.push(t); logEvent(q, 'parts', `Added part ${nm} from a photo`); }, { quiet: true });
    await store.warmUrls([thumbPath]);
    return t.id;
  }

  /* ---- side panel ---- */
  function renderSide() {
    const side = el.querySelector('#side'); const ph = cur(); if (!side || !ph) return; const p = store.project();
    if (ph.mode === 'quick') return quickSide(side, p, ph);
    const s = photoSummary(ph); const ro = ph.status === 'archived';
    const byPart = new Map(); const byGrp = new Map(); let gone = 0, chk = 0;
    for (const it of ph.items) { if (it.st === 'gone') { gone++; continue; } if (it.st === 'check' || it.st === 'unknown') chk++; if (it.part) { const a = byPart.get(it.part) || { n: 0, c: 0 }; a.n += it.n || 1; if (it.st === 'check') a.c++; byPart.set(it.part, a); } else { const a = byGrp.get(it.grp || '_') || 0; byGrp.set(it.grp || '_', a + 1); } }
    const parts = sortedParts(p).filter((t) => byPart.has(t.id));
    const scale = ph.scaleSrc === 'mat' ? `<span class="scalepill ok" title="From the counting mat">Exact sizes · mat</span>` : ph.scaleSrc === 'manual' ? '<span class="scalepill ok">Scale set by hand</span>' : ph.scaleSrc === 'parts' ? `<span class="scalepill" title="Worked out from ${ph.scaleSupport || 'several'} pieces that matched parts of known size">Sizes estimated</span>` : ph.ppm ? '<span class="scalepill">Sizes known</span>' : '<span class="scalepill warn">No scale</span>';
    const selIt = S.sel >= 0 ? ph.items[S.sel] : null;
    side.innerHTML = `${ph.labelHint && ph.status === 'draft' ? `<div class="note info" style="display:grid;gap:6px">This looks like ${ph.labelHint} labelled packages. Reading the labels counts them far better than looking at the pieces.<button type="button" class="btn small primary" id="toLabels" style="justify-self:start">Read the labels instead</button></div>` : ''}
      <div class="card"><div class="panel-h"><div class="grow" style="display:grid;gap:3px"><div class="row"><b>${esc(ph.name)}</b>${ph.status === 'added' ? '<span class="tag ok">Counted</span>' : ph.status === 'archived' ? '<span class="tag">Archived</span>' : '<span class="tag warn">Checking</span>'}</div><div class="row small muted">${scale}<span>${pn(s.objects, 'thing')} found</span></div></div>
        <button type="button" class="btn small ghost" id="phMore">More…</button></div></div>
      <div class="card grow-card"><div class="panel-h"><h3 class="grow">${pn(s.pieces, 'piece')}${s.unknown ? ` + ${s.unknown} unknown` : ''}</h3>${chk ? `<button type="button" class="btn small${S.filter === 'check' ? ' primary' : ''}" id="fChk">${chk} to check</button>` : ''}</div>
        <div class="scroll grplist" id="gl">
          ${parts.map((t) => { const a = byPart.get(t.id); return `<button type="button" class="grp" data-f="${esc(t.id)}" aria-pressed="${S.filter === t.id}"><span class="sw" style="background:${esc(t.color)}"></span>${thumbHTML(t)}<span class="nm"><b>${esc(t.name)}</b><span>${esc(t.code || '')}${a.c ? ` · ${a.c} to check` : ''}</span></span><span class="cnt">${a.n}</span></button>`; }).join('')}
          ${[...byGrp.entries()].map(([gid, n]) => { const g = (ph.groups || []).find((x) => x.id === gid); const gi = (ph.groups || []).findIndex((x) => x.id === gid); return `<div class="grp" style="grid-template-columns:auto minmax(0,1fr) auto auto"><span class="sw" style="background:${gi >= 0 ? PALETTE[(gi + 3) % PALETTE.length] : '#ddd'}"></span><button type="button" class="linkbtn" style="text-align:left;color:inherit;text-decoration:none" data-f="g:${esc(gid)}"><b>${g ? esc(g.name) : 'Unknown'}</b><br><span class="small muted">Not counted until you name it</span></button><span class="cnt">${n}</span>${ro ? '' : `<button type="button" class="btn small" data-name="${esc(gid)}">Name it</button>`}</div>`; }).join('')}
          ${gone ? `<button type="button" class="grp" data-f="gone" aria-pressed="${S.filter === 'gone'}"><span class="sw" style="background:#9aa3ad"></span><span class="thumb"><span class="ini">×</span></span><span class="nm"><b>Not pieces</b><span>Ignored</span></span><span class="cnt">${gone}</span></button>` : ''}
          ${!ph.items.length ? '<div class="note">Nothing was found. Try a plainer background, more light, or change “Smallest piece” in the detection settings. You can also add pieces by hand with “+ Missed piece”.</div>' : ''}
        </div></div>
      <div class="card" id="insp">${selIt ? inspHTML(p, ph, selIt) : `<div class="insp"><span class="small muted">${ro ? 'This photo is archived: what was found is kept, but it doesn’t count.' : 'Click a piece on the photo to check it. Use ← → to go through the ones to check, Enter to accept, Delete if it’s not a piece.'}</span></div>`}</div>
      <div class="card"><div class="applybar">${applyHTML(p, ph, s)}</div></div>`;
    wireSide(side, p, ph, selIt);
    if (selIt) drawCrop(side, ph, selIt);
  }
  function inspHTML(p, ph, it) {
    const t = it.part && partById(p, it.part); const ro = ph.status === 'archived';
    const ff = it.f ? feat(it.f, ph.ppm, ph.ppu) : null;
    const size = ff && ff.L ? (ff.mm ? `${fmtN(+ff.L.toFixed(1))} × ${fmtN(+ff.W.toFixed(1))} mm` : `${Math.round(ff.L)} × ${Math.round(ff.W)} px`) : '';
    const alts = (it.alts || []).filter((a) => partById(p, a.part)).slice(0, 4);
    return `<div class="insp">
      <div class="row"><b class="grow">${t ? esc(t.name) : it.grp ? esc(((ph.groups || []).find((g) => g.id === it.grp) || {}).name || 'Unknown') : 'Unknown piece'}</b>${t ? codeTag(t) : ''}${it.st === 'ok' ? '<span class="tag ok">Checked</span>' : it.st === 'check' ? '<span class="tag warn">Check</span>' : it.st === 'gone' ? '<span class="tag">Not a piece</span>' : it.st === 'auto' ? `<span class="tag">Sure ${Math.round((it.conf || 0) * 100)}%</span>` : ''}</div>
      <div class="crops"><div class="crop"><canvas id="cropC" width="240" height="240"></canvas><span class="cap">${esc(size || 'On the photo')}</span></div><div class="crop">${t ? thumbHTML(t, 'lg').replace('class="thumb lg"', 'class="thumb lg" style="width:100%;height:100%;background:none"') : '<span class="muted small">No part yet</span>'}<span class="cap">${t ? 'The part' : ''}</span></div></div>
      ${it.why && it.st !== 'ok' ? `<div class="small muted">${esc(it.why)}</div>` : ''}
      ${!ro ? `${alts.length ? `<div class="alts">${alts.map((a, k) => { const at = partById(p, a.part); return `<button type="button" class="alt${a.part === it.part ? ' best' : ''}" data-alt="${esc(a.part)}">${thumbHTML(at, 'sm')}<span style="display:grid;min-width:0"><b class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(at.name)}</b><span class="conf">${Math.max(0, Math.round(100 * (1 - a.d / 2.6)))}% match</span></span><span class="k mono">${k + 1}</span></button>`; }).join('')}</div>` : ''}
      <div class="btnrow">${it.part && it.st !== 'ok' && it.st !== 'gone' ? '<button type="button" class="btn small primary" id="iOk">✓ Right <span class="k">Enter</span></button>' : ''}<button type="button" class="btn small" id="iPick">${it.part ? 'Different part…' : 'Which part?'}</button><button type="button" class="btn small" id="iNew">New part from this</button>
        ${it.st === 'gone' ? '<button type="button" class="btn small" id="iBack">It is a piece</button>' : '<button type="button" class="btn small ghost danger" id="iGone">Not a piece <span class="k">Del</span></button>'}</div>
      ${it.part && it.st !== 'gone' ? `<div class="row small"><span class="muted">Pieces here</span><span class="stepper"><button type="button" id="nM">−</button><input type="number" id="nV" min="1" value="${it.n || 1}"><button type="button" id="nP">+</button></span><span class="muted">for pieces touching each other</span></div>` : ''}
      <div class="btnrow"><button type="button" class="btn small ghost" id="iPrev">← Previous</button><button type="button" class="btn small ghost" id="iNext">Next to check →</button></div>` : ''}
    </div>`;
  }
  function applyHTML(p, ph, s) {
    if (ph.status === 'archived') return `<span class="grow small muted">Archived ${when(ph.archivedAt)}. Its ${pn(s.pieces, 'piece')} don’t count.</span><button type="button" class="btn small" id="aRestore">Count it again</button>`;
    if (ph.status === 'added') return `<span class="grow small"><b>${pn(s.pieces, 'piece')}</b> from this photo are in the inventory. Changes here update it.</span><a class="btn small" href="#/${projPath('inventory')}">Inventory</a>`;
    return `<div class="grow" style="display:grid;gap:2px"><b>${pn(s.pieces, 'piece')} ready</b><span class="tiny muted">${s.unknown ? `${s.unknown} unknown won’t count until named. ` : ''}${s.check ? `${s.check} still marked to check.` : 'All checked.'}</span></div><button type="button" class="btn ghost small danger" id="aDiscard">Discard</button><button type="button" class="btn primary" id="aAdd" ${s.pieces ? '' : 'disabled'}>Add to inventory</button>`;
  }
  function wireSide(side, p, ph, it) {
    const $s = (id) => side.querySelector('#' + id);
    side.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { S.filter = S.filter === b.dataset.f ? null : b.dataset.f; S.sel = -1; renderSide(); drawOverlay(); }));
    if ($s('fChk')) $s('fChk').onclick = () => { S.filter = S.filter === 'check' ? null : 'check'; S.sel = -1; next(1); };
    side.querySelectorAll('[data-name]').forEach((b) => (b.onclick = () => nameGroup(ph, b.dataset.name)));
    $s('phMore').onclick = () => photoMenu(ph);
    if ($s('toLabels')) $s('toLabels').onclick = () => { store.change((q) => { const P = photoById(q, ph.id); P.mode = 'labels'; P.items = []; P.pkgs = null; P.groups = []; delete P.labelHint; }); draw(); };
    if (it) {
      const set = (fn, log) => edit((q, P) => { const x = P.items[S.sel]; fn(x, q, P); }, log);
      if ($s('iOk')) $s('iOk').onclick = () => accept();
      if ($s('iGone')) $s('iGone').onclick = () => { set((x) => { x.st = 'gone'; x.lock = true; }, 'Marked not a piece'); next(1, true); };
      if ($s('iBack')) $s('iBack').onclick = () => set((x) => { x.st = x.part ? 'ok' : 'unknown'; }, 'Restored a piece');
      side.querySelectorAll('[data-alt]').forEach((b) => (b.onclick = () => assign(b.dataset.alt)));
      if ($s('iPick')) $s('iPick').onclick = async () => { const r = await pickPart(store.project(), { current: it.part }); if (!r) return; if (r === '__new') { const id = await newPartFlow(ph, it); if (id) assign(id); } else assign(r); };
      if ($s('iNew')) $s('iNew').onclick = async () => { const id = await newPartFlow(ph, it); if (id) assign(id); };
      const setN = (v) => set((x) => { x.n = Math.max(1, Math.round(v) || 1); x.lock = true; if (x.st !== 'gone') x.st = 'ok'; }, 'Changed a piece count');
      if ($s('nM')) { $s('nM').onclick = () => setN((it.n || 1) - 1); $s('nP').onclick = () => setN((it.n || 1) + 1); $s('nV').onchange = (e) => setN(+e.target.value); }
      if ($s('iPrev')) $s('iPrev').onclick = () => next(-1); if ($s('iNext')) $s('iNext').onclick = () => next(1);
    }
    if ($s('aAdd')) $s('aAdd').onclick = () => addToInventory(ph);
    if ($s('aDiscard')) $s('aDiscard').onclick = () => discard(ph);
    if ($s('aRestore')) $s('aRestore').onclick = () => edit((q, P) => { P.status = 'added'; P.addedAt = Date.now(); delete P.archivedAt; }, `Counted ${ph.name} again`);
  }
  function assign(partId) {
    edit((q, P) => { const x = P.items[S.sel]; x.part = partId; x.st = 'ok'; x.lock = true; delete x.grp; if (x.f) learn(q, partId, feat(x.f, P.ppm, P.ppu)); }, 'Corrected a piece');
    rematchSoon(); next(1, true);
  }
  function accept() { const ph = cur(); const it = ph.items[S.sel]; if (!it || !it.part) return; edit((q, P) => { const x = P.items[S.sel]; x.st = 'ok'; x.lock = true; if (x.f) learn(q, x.part, feat(x.f, P.ppm, P.ppu)); }, 'Checked a piece'); next(1, true); }
  let rmT = null;
  function rematchSoon() { clearTimeout(rmT); rmT = setTimeout(() => { const ph = cur(); if (!ph || ph.status === 'archived' || ph.mode !== 'parts') return; edit((q, P) => matchPhoto(q, P), null); }, 900); }
  function next(dir, skipCur) {
    const ph = cur(); const n = ph.items.length; if (!n) return; let i = S.sel;
    const need = (it) => it.st === 'check' || it.st === 'unknown';
    for (let k = 0; k < n; k++) { i = (i + dir + n) % n; if (S.sel < 0 && dir > 0 && k === 0) i = 0; if (need(ph.items[i]) && (!S.filter || matchesFilter(ph.items[i]))) { S.sel = i; renderSide(); drawOverlay(); focusOn(ph.items[i]); return; } }
    if (skipCur) { S.sel = -1; renderSide(); drawOverlay(); toast('Nothing left to check on this photo.'); }
  }
  function focusOn(it) { const vw = el.querySelector('#vw'); if (!vw) return; const r = vw.getBoundingClientRect(); const sx = it.x * S.s + S.tx, sy = it.y * S.s + S.ty; if (sx < 40 || sy < 40 || sx > r.width - 40 || sy > r.height - 40 || S.s < S.fit * 1.5) { S.s = Math.max(S.s, Math.min(8, S.fit * 3)); S.tx = r.width / 2 - it.x * S.s; S.ty = r.height / 2 - it.y * S.s; S.apply(); } }
  function onKey(e) {
    const ph = cur(); if (!ph || document.querySelector('.modal-bg') || /INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || '')) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); next(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); next(-1); }
    else if (S.sel >= 0 && ph.status !== 'archived') {
      const it = ph.items[S.sel];
      if (e.key === 'Enter') { e.preventDefault(); accept(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); edit((q, P) => { P.items[S.sel].st = 'gone'; P.items[S.sel].lock = true; }, 'Marked not a piece'); next(1, true); }
      else if (/^[1-4]$/.test(e.key) && it.alts && it.alts[+e.key - 1]) { e.preventDefault(); assign(it.alts[+e.key - 1].part); }
    }
  }
  function cropCanvas(ph, it, size = 240, outline = true) {
    if (!S.img || S.imgFor !== ph.id) return null; const r = Math.max(itemR(ph, it) * 1.45, 18);
    const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
    g.fillStyle = '#1a1f26'; g.fillRect(0, 0, size, size); const sc = size / (2 * r);
    g.drawImage(S.img, it.x - r, it.y - r, 2 * r, 2 * r, 0, 0, size, size);
    if (outline && it.poly) { g.beginPath(); for (let k = 0; k < it.poly.length; k += 2) { const X = (it.poly[k] - it.x + r) * sc, Y = (it.poly[k + 1] - it.y + r) * sc; k ? g.lineTo(X, Y) : g.moveTo(X, Y); } g.closePath(); g.strokeStyle = '#ffbf2e'; g.lineWidth = 2; g.stroke(); }
    return c;
  }
  function drawCrop(side, ph, it) { const cv = side.querySelector('#cropC'); const c = cropCanvas(ph, it); if (cv && c) cv.getContext('2d').drawImage(c, 0, 0); }

  async function nameGroup(ph, gid) {
    const p = store.project(); const g = (ph.groups || []).find((x) => x.id === gid); const its = ph.items.filter((x) => !x.part && x.grp === gid && x.st !== 'gone');
    const r = await pickPart(p, { title: `What are the ${its.length} pieces in ${g ? g.name : 'this group'}?`, hint: 'Pick the part they all are, or make a new one. You can still fix single pieces after.' });
    if (!r) return; let partId = r;
    if (r === '__new') { const i = ph.items.indexOf(its[0]); partId = await newPartFlow(ph, its[0], gid); if (!partId) return; void i; }
    edit((q, P) => { for (const x of P.items) if (!x.part && x.grp === gid && x.st !== 'gone') { x.part = partId; x.st = 'ok'; x.lock = true; delete x.grp; if (x.f) learn(q, partId, feat(x.f, P.ppm, P.ppu)); } P.groups = (P.groups || []).filter((y) => y.id !== gid); }, `Named ${g ? g.name : 'a group'}`);
    rematchSoon(); toast(`${pn(its.length, 'piece')} named`);
  }
  async function addToInventory(ph) {
    const s = photoSummary(ph);
    if (s.unknown && !(await confirmBox({ title: `${s.unknown} pieces are still unknown`, text: 'They won’t be counted. You can name them later from History.', ok: `Add ${pn(s.pieces, 'piece')} anyway` }))) return;
    store.change((q) => {
      const P = photoById(q, ph.id); const before = counts(q); P.status = 'added'; P.addedAt = Date.now();
      for (const x of P.items) if (x.part && x.st === 'auto' && x.conf > 0.8 && x.f) learn(q, x.part, feat(x.f, P.ppm, P.ppu));
      logEvent(q, 'photo', `Counted ${P.name}: ${pn(photoSummary(P).pieces, 'piece')}`, diff(before, counts(q)));
    });
    toast(`Added ${pn(s.pieces, 'piece')} to the inventory`, { label: 'See inventory', run: () => go(projPath('inventory')) });
  }
  async function discard(ph) {
    if (!(await confirmBox({ title: `Discard ${esc(ph.name)}?`, text: 'The photo and what was found on it are removed. Nothing was counted from it yet.', ok: 'Discard', danger: true }))) return;
    await store.delFile(ph.file); if (ph.thumb) await store.delFile(ph.thumb);
    store.change((q) => { q.photos = q.photos.filter((x) => x.id !== ph.id); }); go(projPath('count'));
  }
  async function photoMenu(ph) {
    const { choiceBox } = await import('../util.js');
    const opts = [{ value: 'rename', icon: 'Aa', label: 'Rename photo' }];
    if (ph.status !== 'archived' && ph.mode === 'parts') opts.push({ value: 'rematch', icon: '↻', label: 'Match again', desc: 'Re-check the pieces you haven’t confirmed against the parts as they are now.' });
    if (ph.status !== 'archived') opts.push({ value: 'redetect', icon: '◎', label: 'Find pieces again', desc: 'Run detection again with the current settings. Your corrections on this photo are lost.' });
    if (ph.mode === 'parts' && ph.status !== 'archived') opts.push({ value: 'okAll', icon: '✓', label: 'Accept all sure guesses', desc: 'Mark every piece it is sure about as checked.' });
    if (ph.status === 'added') opts.push({ value: 'archive', icon: '⌂', label: 'Stop counting this photo', desc: 'Keep it in History without counting its pieces.' });
    if (ph.status === 'draft') opts.push({ value: 'tolabels', icon: 'Aa', label: 'Read the labels on this photo instead', desc: 'For photos of packages: count them by their labels.' });
    opts.push({ value: 'history', icon: '↺', label: 'All photos (History)' });
    const a = await choiceBox({ title: esc(ph.name), options: opts }); if (!a) return;
    if (a === 'rename') { const n = await promptBox({ title: 'Rename photo', label: 'Name', value: ph.name }); if (n) edit((q, P) => { P.name = n; }, null); }
    if (a === 'rematch') { edit((q, P) => matchPhoto(q, P), 'Matched again'); toast('Matched again'); }
    if (a === 'okAll') edit((q, P) => { for (const x of P.items) if (x.st === 'auto') x.st = 'ok'; }, null);
    if (a === 'archive') edit((q, P) => { P.status = 'archived'; P.archivedAt = Date.now(); P.archivedWhy = 'Stopped counting'; }, `Stopped counting ${ph.name}`);
    if (a === 'history') go(projPath('history'));
    if (a === 'redetect') redetect(ph);
    if (a === 'tolabels') { store.change((q) => { const P = photoById(q, ph.id); P.mode = 'labels'; P.items = []; P.pkgs = null; P.groups = []; }); draw(); }
  }
  async function redetect(ph) {
    if (!(await confirmBox({ title: 'Find pieces again?', text: 'Detection runs again on this photo with the current settings. Corrections you made on it are lost.', ok: 'Find again' }))) return;
    const st = settings(); toast('Finding pieces…');
    const blob = await store.fileBlob(ph.file); const { canvas } = await decode(blob, 50e6, 20000);
    const res = await analyzeCanvas(canvas, { mode: ph.mode, mat: false, ppm: ph.scaleSrc === 'mat' || ph.scaleSrc === 'manual' ? ph.ppm : null, scaleSrc: ph.scaleSrc, shadow: st.shadow, minMM: st.minMM, split: st.split });
    edit((q, P) => { P.items = res.objs.map((o, k) => ({ id: 'i' + k, x: +o.x.toFixed(1), y: +o.y.toFixed(1), poly: thin(o.poly), box: o.box, f: compact(o), edge: o.edge || undefined })); P.groups = []; if (P.mode === 'parts') matchPhoto(q, P); else { P.items.forEach((x) => { x.st = 'unknown'; x.part = null; }); P.quick = null; } }, 'Found pieces again');
    S.sel = -1; toast(`Found ${pn(cur().items.length, 'thing')}`);
  }

  /* ================= quick count ================= */
  function quickTap(ph, i) {
    if (i < 0 || ph.status === 'archived') return;
    edit((q, P) => {
      P.quick = P.quick || { ex: [], thr: S.thr, part: null }; const ex = P.quick.ex; const k = ex.indexOf(i);
      if (!ex.length || (k < 0 && P.quick.addEx)) { ex.push(i); P.quick.addEx = false; }
      else if (k >= 0 && ex.length > 1) ex.splice(k, 1);
      else if (k < 0) { const it = P.items[i]; const included = !!it.part && it.st !== 'gone'; it.manual = included ? 'out' : 'in'; }
      runQuick(P);
    }, null);
  }
  function runQuick(P) {
    const q = P.quick; if (!q || !q.ex.length) { P.items.forEach((x) => { x.part = null; x.st = 'unknown'; x.n = 1; }); return; }
    const objs = P.items.map((x) => x.f); const hits = similarTo(objs, P.ppm, q.ex, q.thr); const by = new Map(hits.map((h) => [h.i, h]));
    P.items.forEach((x, i) => {
      const h = by.get(i); let inn = !!h; if (x.manual === 'in') inn = true; if (x.manual === 'out') inn = false;
      x.part = inn ? q.part || '__q' : null; x.st = inn ? (h && h.est ? 'check' : 'auto') : 'gone'; x.n = inn && h && h.est ? h.n : 1; x.why = h && h.est ? `Looks like ${h.n} touching` : '';
    });
  }
  function quickSide(side, p, ph) {
    const q = ph.quick || { ex: [], thr: S.thr }; const t = q.part && partById(p, q.part); const ro = ph.status === 'archived';
    const inn = ph.items.filter((x) => x.part && x.st !== 'gone'); const total = inn.reduce((a, x) => a + (x.n || 1), 0); const est = inn.filter((x) => (x.n || 1) > 1);
    side.innerHTML = `<div class="card"><div class="panel-h"><b class="grow">${esc(ph.name)}</b>${ph.status === 'added' ? '<span class="tag ok">Counted</span>' : ph.status === 'archived' ? '<span class="tag">Archived</span>' : '<span class="tag warn">Counting</span>'}<button type="button" class="btn small ghost" id="phMore">More…</button></div>
      <div class="pad" style="display:grid;gap:14px">
        ${q.ex.length ? `<div class="row" style="align-items:baseline;gap:10px"><span style="font:800 54px/1 var(--f-display);font-stretch:80%">${total}</span><span class="muted">${t ? esc(t.name) : 'pieces like the one you tapped'}</span></div>
          ${est.length ? `<div class="small muted">Includes ${est.reduce((a, x) => a + x.n, 0)} in ${pn(est.length, 'clump')} counted by size. Check those (dashed).</div>` : ''}
          ${ro ? '' : `<label class="slider"><span class="flabel">How alike</span><input type="range" id="qThr" min="0.5" max="2.4" step="0.05" value="${q.thr}"><span class="t"><span>Only identical</span><span>Loosely alike</span></span></label>
          <div class="small muted">Tap a piece to add it or leave it out. <button type="button" class="linkbtn" id="qMore">Add another example</button>${q.ex.length > 1 ? ` · ${q.ex.length} examples` : ''}</div>
          <div class="field"><span>These are</span><div class="row">${t ? `${thumbHTML(t, 'sm')}<b class="grow">${esc(t.name)}</b>` : '<span class="grow muted small">Not linked to a part yet</span>'}<button type="button" class="btn small" id="qPart">${t ? 'Change' : 'Pick part'}</button><button type="button" class="btn small" id="qNew">New part</button></div></div>`}`
        : `<div class="empty" style="padding:18px"><b>Tap one piece</b><span class="small">Tap a single, clear example of what you want to count. Everything like it gets counted.</span></div>`}
      </div></div>
      <div class="card"><div class="applybar">${ph.status === 'draft' ? `<span class="grow small muted">${q.ex.length ? (t ? `Adds ${total} to ${esc(t.name)}` : 'Pick or make the part to add these to the inventory.') : ''}</span><button type="button" class="btn ghost small danger" id="aDiscard">Discard</button><button type="button" class="btn primary" id="qAdd" ${q.ex.length && t ? '' : 'disabled'}>Add ${total || ''} to inventory</button>` : applyHTML(p, ph, photoSummary(ph))}</div></div>`;
    const $s = (id) => side.querySelector('#' + id);
    $s('phMore').onclick = () => photoMenu(ph);
    if ($s('qThr')) $s('qThr').oninput = (e) => { S.thr = +e.target.value; edit((qq, P) => { P.quick.thr = S.thr; runQuick(P); }, null); };
    if ($s('qMore')) $s('qMore').onclick = () => { edit((qq, P) => { P.quick.addEx = true; }, null); toast('Tap another example on the photo'); };
    const setPart = (id) => edit((qq, P) => { P.quick.part = id; for (const x of P.items) if (x.part) x.part = id; }, null);
    if ($s('qPart')) $s('qPart').onclick = async () => { const r = await pickPart(store.project(), { current: q.part }); if (!r) return; if (r === '__new') { const id = await newPartFlow(ph, ph.items[q.ex[0]]); if (id) setPart(id); } else setPart(r); };
    if ($s('qNew')) $s('qNew').onclick = async () => { const id = await newPartFlow(ph, ph.items[q.ex[0]]); if (id) setPart(id); };
    if ($s('qAdd')) $s('qAdd').onclick = () => { store.change((qq) => { const P = photoById(qq, ph.id); const before = counts(qq); P.status = 'added'; P.addedAt = Date.now(); for (const i of P.quick.ex) { const x = P.items[i]; if (x && x.f) learn(qq, P.quick.part, feat(x.f, P.ppm, P.ppu)); } logEvent(qq, 'photo', `Counted ${P.name}: ${pn(total, 'piece')}`, diff(before, counts(qq))); }); toast(`Added ${total} to the inventory`, { label: 'See inventory', run: () => go(projPath('inventory')) }); };
    if ($s('aDiscard')) $s('aDiscard').onclick = () => discard(ph);
    if ($s('aRestore')) $s('aRestore').onclick = () => edit((qq, P) => { P.status = 'added'; P.addedAt = Date.now(); delete P.archivedAt; }, `Counted ${ph.name} again`);
    syncTools();
  }

  await draw();
  return {
    update: () => { const r = ctx.route(); if (r.sub[0] && el.querySelector('#side')) { renderSide(); drawOverlay(); } else if (!r.sub[0]) { const a = document.activeElement; if (a && a.matches && a.matches('input')) return; draw(); } },
    unmount: () => { document.removeEventListener('keydown', keyH); ctx.dropHandler = null; },
  };
}
void letters; void inkOn; void openModal; void closeModal; void tally; void openPartEditor;
