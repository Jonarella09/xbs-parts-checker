// Print: the print list (parts with 3D models), fill it for N kits, plan plates and download files.
import * as store from '../store.js';
import { counts, kitStatus, shortFor, kitById, partById, sortedParts, printable } from '../proj.js';
import { esc, pn, toast, openModal, closeModal, busy, saveBlob, clamp, plural } from '../util.js';
import { thumbButton, codeTag, dimsText, warmThumbs } from './common.js';
import { viewModel } from './part.js';
import { SPLITS, FMTS, BEDS, buildPlan, planCfg, planKit, printSel, planZip, bedSVG, zipName, exampleName } from '../plan.js';
import { projPath } from '../main.js';

const ui = { show: 'all', n: null };

export async function mount(el, route, ctx) {
  ctx.dropHandler = null; let modal = null;
  const draw = async () => {
    const p = store.project(); await warmThumbs(p);
    const pr = printable(p); const c = counts(p); const sel = printSel(p); const tot = Object.values(sel).reduce((a, b) => a + b, 0);
    if (!pr.length) {
      el.innerHTML = `<div class="page"><div class="hero"><div><h1>Print</h1><p class="sub">Turn the parts you’re missing into print plates, ready for your slicer.</p></div></div>
        <div class="empty"><h3>No 3D models in this project</h3><p>Printing works for parts that have an .stl model. Open a part and add its model, or add parts from 3D models in Inventory.</p><a class="btn primary" href="#/${projPath('inventory')}">Go to Inventory</a></div></div>`;
      return;
    }
    const kit = planKit(p); const ks = kit ? kitStatus(p, kit, c) : null;
    if (!ui.n) ui.n = ks ? ks.complete + 1 : 1;
    const parts = sortedParts(p).filter((t) => t.model && (ui.show === 'all' || sel[t.id]));
    const vol = Object.keys(sel).reduce((a, id) => a + (partById(p, id).model.flat ? partById(p, id).model.flat.vol : 0) * sel[id], 0);
    el.innerHTML = `<div class="page">
      <div class="hero"><div><h1>Print</h1><p class="sub">Put what you want to print on the list, then split it into plates for your printer. Every plate and piece gets a clear, numbered file name.</p></div>
        <div class="btnrow"><button type="button" class="btn" id="clr" ${tot ? '' : 'disabled'}>Clear list</button><button type="button" class="btn primary" id="plan" ${tot ? '' : 'disabled'}>Plan plates & download${tot ? ` (${tot})` : ''}</button></div></div>
      ${kit ? `<div class="card pad" style="display:grid;gap:10px">
        <div class="row"><b>Fill the list for</b><span class="stepper"><button type="button" id="nM" aria-label="Fewer kits">−</button><input type="number" id="nV" min="1" max="500" value="${ui.n}" aria-label="Kits"><button type="button" id="nP" aria-label="More kits">+</button></span>
          <b>complete</b>${p.kits.length > 1 ? `<select class="sel" id="kSel">${p.kits.map((k) => `<option value="${esc(k.id)}"${k.id === kit.id ? ' selected' : ''}>${esc(k.name)}</option>`).join('')}</select>` : `<b>${esc(kit.name)}</b>`}<b>${ui.n === 1 ? 'kit' : 'kits'}</b>
          <button type="button" class="btn small primary" id="fill">Fill list</button><button type="button" class="btn small" id="addOne">+ One whole kit</button></div>
        <div class="small muted">You have ${pn(ks.complete, 'complete kit')}. “Fill list” adds only what’s missing for ${pn(ui.n, 'kit')}, counting what you already have. “One whole kit” adds every printable piece of one kit, whatever you have.${Object.keys(shortFor(p, kit, ui.n, c)).some((id) => !partById(p, id).model) ? ' Parts without a 3D model aren’t printed; see them in Kits.' : ''}</div></div>`
      : `<div class="note">Define a kit to fill the list for a number of kits in one go. <a href="#/${projPath('kits')}">Kits</a></div>`}
      <div class="section-h"><h2>Print list</h2><span class="muted">${tot ? `${pn(tot, 'piece')} · ${vol.toFixed(1)} cm³` : 'Empty'}</span><span class="spacer"></span>
        <div class="seg"><button type="button" data-show="all" aria-pressed="${ui.show === 'all'}">All printable (${pr.length})</button><button type="button" data-show="list" aria-pressed="${ui.show === 'list'}">In my list (${Object.keys(sel).length})</button></div></div>
      <div class="invlist">${parts.map((t) => `<div class="prow">${thumbButton(t, `data-v="${esc(t.id)}" aria-label="View 3D model of ${esc(t.name)}"`)}
        <div class="info"><div class="nm"><b>${esc(t.name)}</b>${codeTag(t)}</div><div class="sub"><span>Have ${c[t.id] || 0}</span>${kit && kit.need[t.id] ? `<span>${kit.need[t.id]} per kit</span>` : ''}<span>${dimsText(t)}</span>${t.model.flat ? `<span>${t.model.flat.vol} cm³</span>` : ''}</div></div>
        <div class="right"><span class="stepper"><button type="button" data-q="${esc(t.id)}" data-d="-1" aria-label="One fewer">−</button><input type="number" min="0" value="${sel[t.id] || 0}" data-qi="${esc(t.id)}" aria-label="How many ${esc(t.name)} to print"><button type="button" data-q="${esc(t.id)}" data-d="1" aria-label="One more">+</button></span></div></div>`).join('') || '<div class="empty"><p>Nothing on the list yet.</p></div>'}</div>
    </div>`;
    const setQ = (id, v) => store.change((q) => { v = Math.max(0, Math.round(v)); if (v) q.print[id] = v; else delete q.print[id]; });
    el.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => setQ(b.dataset.q, (sel[b.dataset.q] || 0) + +b.dataset.d)));
    el.querySelectorAll('[data-qi]').forEach((i) => { i.onchange = () => setQ(i.dataset.qi, +i.value || 0); i.onfocus = () => i.select(); });
    el.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => viewModel(partById(p, b.dataset.v))));
    el.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => { ui.show = b.dataset.show; draw(); }));
    el.querySelector('#clr').onclick = () => { const old = Object.assign({}, p.print); store.change((q) => { q.print = {}; }); toast('Print list cleared', { label: 'Undo', run: () => store.change((q) => { q.print = old; }) }); };
    el.querySelector('#plan').onclick = () => openPlan();
    if (kit) {
      const setN = (v) => { ui.n = clamp(Math.round(v) || 1, 1, 500); draw(); };
      el.querySelector('#nM').onclick = () => setN(ui.n - 1); el.querySelector('#nP').onclick = () => setN(ui.n + 1); el.querySelector('#nV').onchange = (e) => setN(+e.target.value);
      const ksel = el.querySelector('#kSel'); if (ksel) ksel.onchange = () => { store.change((q) => { q.printKit = ksel.value; }); };
      el.querySelector('#fill').onclick = () => { const s = shortFor(p, kit, ui.n, c); store.change((q) => { q.print = {}; for (const id in s) if (partById(q, id).model) q.print[id] = s[id]; q.printKit = kit.id; }); const n = Object.keys(s).filter((id) => partById(p, id).model).reduce((a, id) => a + s[id], 0); toast(n ? `Print list filled: ${pn(n, 'piece')} for ${pn(ui.n, 'complete kit')}` : `You already have enough for ${pn(ui.n, 'kit')}`); };
      el.querySelector('#addOne').onclick = () => { store.change((q) => { for (const id in kit.need) if (partById(q, id) && partById(q, id).model) q.print[id] = (q.print[id] || 0) + kit.need[id]; q.printKit = kit.id; }); toast('Added one whole kit to the list'); };
    }
  };

  function setPlan(patch) { store.change((q) => { q.plan = Object.assign(planCfg(q), patch); }, { quiet: true }); renderPlan(); }
  function openPlan() {
    modal = openModal({ title: 'Plan your plates', cls: 'full', body: '<div id="planBody" style="display:grid;gap:14px"></div>', foot: '<div id="planFoot" class="row grow"></div>', onClose: () => { modal = null; draw(); } });
    renderPlan();
  }
  function renderPlan() {
    if (!modal) return; const body = modal.el.querySelector('#planBody'); const foot = modal.el.querySelector('#planFoot'); const sc = body.parentElement.scrollTop;
    const p = store.project(); const plan = buildPlan(p); const c = plan.c; const needK = c.split === 'count' || c.split === 'balance'; const kit = planKit(p);
    if (!plan.tot) { body.innerHTML = '<div class="empty">Your print list is empty.</div>'; foot.innerHTML = ''; return; }
    const bedOpts = BEDS.map((b, i) => `<option value="${i}"${c.bed === i ? ' selected' : ''}>${b[0]} × ${b[1]} mm</option>`).join('') + `<option value="-1"${c.bed < 0 ? ' selected' : ''}>Custom size…</option>`;
    body.innerHTML = `
      <div class="flabel">How to split ${pn(plan.tot, 'piece')} (${plan.vol.toFixed(1)} cm³)</div>
      <div class="splits" role="radiogroup">${SPLITS.filter((s) => !s.needsKit || kit).map((s) => `<button type="button" role="radio" class="split" data-split="${s.id}" aria-checked="${c.split === s.id}"><b>${s.t}</b><span>${s.d}</span></button>`).join('')}</div>
      ${c.split === 'kit' ? `<div class="row small"><span class="muted">Number the kits</span><div class="seg"><button type="button" data-from="have" aria-pressed="${c.from !== 'one'}">After the ${esc(kit.name)} kits I have</button><button type="button" data-from="one" aria-pressed="${c.from === 'one'}">From 1</button></div></div>` : ''}
      <div class="planrow">
        ${needK ? `<label class="field"><span>Plates</span><span class="stepper"><button type="button" id="kM">−</button><input type="number" id="kV" min="1" max="50" value="${c.k}"><button type="button" id="kP">+</button></span></label>` : ''}
        <label class="field"><span>Print bed</span><select id="bedSel" class="sel">${bedOpts}</select></label>
        ${c.bed < 0 ? `<label class="field"><span>Width × depth (mm)</span><span class="row"><input class="inp" type="number" id="bedW" min="60" max="600" value="${plan.W}" style="width:90px"> × <input class="inp" type="number" id="bedD" min="60" max="600" value="${plan.D}" style="width:90px"></span></label>` : ''}
        <label class="check"><input type="checkbox" id="fitChk"${c.fit ? ' checked' : ''}> <span>Split any plate that doesn’t fit my bed</span></label></div>
      ${plan.canComb && plan.baseGroups.length > 1 ? combHTML(p, plan) : ''}
      <div class="flabel">Files</div>
      <div class="splits" role="radiogroup">${FMTS.map((f) => `<button type="button" role="radio" class="split" data-fmt="${f.id}" aria-checked="${c.fmt === f.id}"><b>${f.t}</b><span>${f.d}</span></button>`).join('')}</div>
      <div class="flabel">${pn(plan.plates.length, 'plate')}</div>
      <div class="plates">${plan.plates.map((pl) => `<article class="plate${pl.bin.fits ? '' : ' bad'}"><div class="phead"><b>${esc(pl.title)}</b><span class="mono small">${pl.code}</span></div>
        ${bedSVG(p, pl, plan.W, plan.D)}<div class="small muted">${pn(pl.n, 'piece')} · ${pl.vol.toFixed(1)} cm³ · ${pl.fill}% of the bed${pl.bin.fits ? '' : ' · <b style="color:var(--bad)">doesn’t fit</b>'}</div>
        <div class="pparts">${Object.keys(pl.cnt).map((k) => `<span class="code" style="border-color:${esc(partById(p, k).color)}">${esc(partById(p, k).code || partById(p, k).name)} ×${pl.cnt[k]}</span>`).join('')}</div>
        <div class="row"><span class="mono tiny muted grow" style="word-break:break-all">${esc(pl.name)}</span><button type="button" class="btn small" data-dlp="${pl.no}">Download</button></div></article>`).join('')}</div>`;
    body.parentElement.scrollTop = sc;
    foot.innerHTML = `<div class="grow" style="display:grid;gap:2px;min-width:0"><span class="tiny muted">File names look like</span><code class="tiny" style="word-break:break-all">${esc(zipName(p, plan))}.zip</code><code class="tiny" style="word-break:break-all">${esc(exampleName(p, plan))}</code></div><button type="button" class="btn primary" id="dlAll">Download all ${pn(plan.plates.length, 'plate')} (.zip)</button>`;
    body.querySelectorAll('[data-split]').forEach((b) => (b.onclick = () => setPlan({ split: b.dataset.split })));
    body.querySelectorAll('[data-fmt]').forEach((b) => (b.onclick = () => setPlan({ fmt: b.dataset.fmt })));
    body.querySelectorAll('[data-from]').forEach((b) => (b.onclick = () => setPlan({ from: b.dataset.from })));
    if (needK) { const setK = (n) => setPlan({ k: clamp(n, 1, 50) }); body.querySelector('#kM').onclick = () => setK(c.k - 1); body.querySelector('#kP').onclick = () => setK(c.k + 1); body.querySelector('#kV').onchange = (e) => setK(Math.round(+e.target.value || c.k)); }
    body.querySelector('#bedSel').onchange = (e) => { const i = +e.target.value; setPlan(i < 0 ? { bed: -1, w: plan.W, d: plan.D } : { bed: i }); };
    if (c.bed < 0) { body.querySelector('#bedW').onchange = (e) => setPlan({ w: +e.target.value }); body.querySelector('#bedD').onchange = (e) => setPlan({ d: +e.target.value }); }
    body.querySelector('#fitChk').onchange = (e) => setPlan({ fit: e.target.checked });
    wireComb(body, p, plan);
    const dl = async (only, btn) => busy(btn, async () => { try { const r = await planZip(store.project(), only); if (r) { saveBlob(r.name, r.blob); toast(`Downloaded ${esc(r.name)}`); } } catch (e) { console.error(e); toast('Couldn’t make the files: ' + esc(e.message)); } });
    body.querySelectorAll('[data-dlp]').forEach((b) => (b.onclick = () => dl(+b.dataset.dlp, b)));
    foot.querySelector('#dlAll').onclick = (e) => dl(0, e.currentTarget);
  }
  function combHTML(p, plan) {
    const merged = plan.groups.filter((g) => g.merged);
    return `<div class="card pad" style="display:grid;gap:8px;background:var(--sunk)"><div class="row"><b>Combine plates</b><span class="small muted">Few pieces in a group? Tick two or more and print them together.</span></div>
      <div class="combo">${plan.baseGroups.filter((g) => !merged.some((m) => m.members.includes(g.key))).map((g) => `<label><input type="checkbox" data-cb="${esc(g.key)}"> ${esc(g.short || g.title)} <span class="muted">(${g.pcs.length})</span></label>`).join('')}</div>
      <div class="btnrow"><button type="button" class="btn small" id="cbGo" disabled>Combine selected</button>${merged.map((m) => `<span class="tag">${esc(m.short)} <button type="button" class="linkbtn tiny" data-unm="${esc(m.key)}">split apart</button></span>`).join('')}</div></div>`;
  }
  function wireComb(body, p, plan) {
    const boxes = body.querySelectorAll('[data-cb]'); const go2 = body.querySelector('#cbGo'); if (!go2) return;
    boxes.forEach((b) => (b.onchange = () => { go2.disabled = [...boxes].filter((x) => x.checked).length < 2; }));
    go2.onclick = () => { const keys = [...boxes].filter((x) => x.checked).map((x) => x.dataset.cb); const c = planCfg(p); const m = Object.assign({}, c.merge || {}); m[c.split] = [...(m[c.split] || []), keys]; setPlan({ merge: m }); };
    body.querySelectorAll('[data-unm]').forEach((b) => (b.onclick = () => { const c = planCfg(p); const m = Object.assign({}, c.merge || {}); const ks = b.dataset.unm.split('+'); m[c.split] = (m[c.split] || []).filter((a) => !(a.length === ks.length && a.every((k) => ks.includes(k)))); setPlan({ merge: m }); }));
  }
  await draw();
  return { update: () => { if (modal) { renderPlan(); return; } const a = document.activeElement; if (a && a.matches && a.matches('input')) return; const y = scrollY; draw().then(() => scrollTo(0, y)); } };
}
void plural; void kitById; void closeModal;
