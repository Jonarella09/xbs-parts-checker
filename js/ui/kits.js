// Kits: lists of parts that build one of something. Status, editor, and a part-by-part counter.
import * as store from '../store.js';
import { counts, kitStatus, shortFor, kitById, kitParts, kitPieces, newKit, sortedParts, partById, setCount, logEvent, diff, KINDS } from '../proj.js';
import { esc, pn, toast, confirmBox, promptBox, clamp } from '../util.js';
import { thumbHTML, codeTag, dimsText, warmThumbs, mchip } from './common.js';
import { viewModel, openPartEditor } from './part.js';
import { go, projPath } from '../main.js';

const ui = { filter: 'kit', want: null };

export async function mount(el, route, ctx) {
  ctx.dropHandler = null;
  const draw = async () => {
    const p = store.project(); await warmThumbs(p); const r = ctx.route();
    const kid = r.sub[0]; const kit = kid ? kitById(p, kid) : null;
    if (kid && !kit) { go(projPath('kits')); return; }
    if (kit && r.sub[1] === 'counter') return counterView(el, p, kit);
    if (kit) return kitView(el, p, kit);
    return listView(el, p);
  };
  async function newKitFlow(p) {
    const name = await promptBox({ title: 'Define a kit', label: 'What does one kit build?', value: p.kits.length ? '' : p.name.replace(/\s*parts?$/i, ''), placeholder: 'e.g. XBS Climber, Robot A, Field set', ok: 'Create kit' });
    if (!name) return; const k = newKit(p, { name });
    store.change((q) => { q.kits.push(k); if (q.kind === 'count') q.kind = 'kits'; logEvent(q, 'kits', `Defined kit ${name}`); });
    go(projPath('kits', k.id));
  }
  function listView(el, p) {
    const c = counts(p);
    el.innerHTML = `<div class="page">
      <div class="hero"><div><h1>Kits</h1><p class="sub">A kit is the list of parts, and how many of each, that build one of something. With a kit defined you can see how many complete kits you have, what’s missing, and fill the print list for any number of kits.</p></div>
        <div class="btnrow"><button type="button" class="btn primary" id="newKit">+ Define a kit</button></div></div>
      ${p.kits.length ? `<div class="kitgrid">${p.kits.map((k) => { const s = kitStatus(p, k, c);
        return `<article class="card kit"><div class="row"><h3 class="grow">${esc(k.name)}</h3><span class="tag">${pn(kitPieces(k), 'piece')} each</span></div>
          ${s.ready ? `<div class="row" style="align-items:baseline"><span class="big">${s.complete}</span><span class="muted">complete ${s.complete === 1 ? 'kit' : 'kits'}</span></div>
          ${s.nextN ? `<div class="small muted">Kit ${s.complete + 1} needs ${pn(s.nextN, 'more piece')}:</div><div class="misslist">${Object.entries(s.next).slice(0, 12).map(([id, q]) => mchip(partById(p, id), q)).join('')}${Object.keys(s.next).length > 12 ? `<span class="small muted">+${Object.keys(s.next).length - 12} more</span>` : ''}</div>` : ''}`
          : '<div class="note">No parts in this kit yet. Open it and set how many of each part one kit needs.</div>'}
          <div class="btnrow"><a class="btn small primary" href="#/${projPath('kits', k.id)}">Open</a>${s.ready ? `<a class="btn small" href="#/${projPath('kits', k.id, 'counter')}">Count part by part</a>` : ''}</div></article>`; }).join('')}</div>`
      : `<div class="empty"><h3>No kits in this project</h3><p>${p.kind === 'count' ? `This project is for ${esc(KINDS.count.label.toLowerCase())}. If these parts build something, define a kit and the kit tools turn on.` : 'Define what one kit needs, and the kit tools turn on: complete kits, what’s missing, and print lists for any number of kits.'}</p><button type="button" class="btn primary" id="newKit2">Define a kit</button></div>`}
    </div>`;
    el.querySelector('#newKit').onclick = () => newKitFlow(p); const n2 = el.querySelector('#newKit2'); if (n2) n2.onclick = () => newKitFlow(p);
  }
  function kitView(el, p, kit) {
    const c = counts(p); const s = kitStatus(p, kit, c);
    const want = ui.want && ui.want > 0 ? ui.want : Math.max(1, s.complete + 1);
    const short = shortFor(p, kit, want, c); const shortIds = Object.keys(short);
    const printIds = shortIds.filter((id) => partById(p, id).model); const buyIds = shortIds.filter((id) => !partById(p, id).model);
    const parts = sortedParts(p).filter((t) => ui.filter === 'all' || (kit.need[t.id] || 0) > 0);
    el.innerHTML = `<div class="page">
      <div class="hero"><div><a class="small" href="#/${projPath('kits')}">← All kits</a><h1 style="margin-top:4px">${esc(kit.name)}</h1><p class="sub">${pn(kitPieces(kit), 'piece')} of ${pn(kitParts(p, kit).length, 'part')} make one kit.</p></div>
        <div class="btnrow"><button type="button" class="btn ghost" id="kRen">Rename</button><button type="button" class="btn ghost danger" id="kDel">Delete kit</button>${s.ready ? `<a class="btn primary" href="#/${projPath('kits', kit.id, 'counter')}">Count part by part</a>` : ''}</div></div>
      <div class="stats"><div class="stat ${s.complete ? 'good' : ''}"><div class="v">${s.complete}</div><div class="l">complete kits now</div></div>
        <div class="stat"><div class="v">${s.ready ? s.nextN : '–'}</div><div class="l">pieces short of kit ${s.complete + 1}</div></div>
        <div class="stat"><div class="v">${kitPieces(kit)}</div><div class="l">pieces per kit</div></div></div>
      ${s.ready ? `<div class="card pad" style="display:grid;gap:12px">
        <div class="row"><b>I want</b><span class="stepper"><button type="button" id="wM" aria-label="One kit fewer">−</button><input type="number" id="wV" min="1" max="500" value="${want}" aria-label="Number of kits"><button type="button" id="wP" aria-label="One kit more">+</button></span><b>${want === 1 ? 'complete kit' : 'complete kits'}</b><span class="spacer"></span><span class="muted">${shortIds.length ? `Missing ${pn(Object.values(short).reduce((a, b) => a + b, 0), 'piece')}` : 'You have everything for that.'}</span></div>
        ${printIds.length ? `<div><div class="small muted" style="margin-bottom:6px">To print (${printIds.reduce((a, id) => a + short[id], 0)})</div><div class="misslist">${printIds.map((id) => mchip(partById(p, id), short[id])).join('')}</div><div class="btnrow" style="margin-top:8px"><button type="button" class="btn small primary" id="toPrint">Put these on the print list</button></div></div>` : ''}
        ${buyIds.length ? `<div><div class="small muted" style="margin-bottom:6px">To get or buy (${buyIds.reduce((a, id) => a + short[id], 0)})</div><div class="misslist">${buyIds.map((id) => mchip(partById(p, id), short[id])).join('')}</div><div class="btnrow" style="margin-top:8px"><button type="button" class="btn small" id="copyBuy">Copy shopping list</button></div></div>` : ''}
      </div>` : ''}
      <div class="section-h"><h2>What one kit needs</h2><div class="seg"><button type="button" data-f="kit" aria-pressed="${ui.filter === 'kit'}">In this kit</button><button type="button" data-f="all" aria-pressed="${ui.filter === 'all'}">All parts</button></div></div>
      ${!p.parts.length ? `<div class="empty"><h3>No parts in the project yet</h3><a class="btn primary" href="#/${projPath('inventory')}">Add parts in Inventory</a></div>` : ''}
      ${p.parts.length && !parts.length ? `<div class="empty"><p>Nothing in this kit yet. Switch to <b>All parts</b> and set how many of each one kit needs.</p></div>` : ''}
      <div class="kitedit">${parts.map((t) => `<div class="prow">${thumbHTML(t)}<div class="info"><div class="nm"><b>${esc(t.name)}</b>${codeTag(t)}</div><div class="sub"><span>Have ${c[t.id] || 0}</span>${dimsText(t) ? `<span>${dimsText(t)}</span>` : ''}</div></div>
        <div class="right"><span class="small muted">per kit</span><span class="stepper"><button type="button" data-kn="${esc(t.id)}" data-d="-1" aria-label="Fewer">−</button><input type="number" min="0" value="${kit.need[t.id] || 0}" data-kin="${esc(t.id)}" aria-label="${esc(t.name)} per kit"><button type="button" data-kn="${esc(t.id)}" data-d="1" aria-label="More">+</button></span></div></div>`).join('')}</div>
    </div>`;
    const setNeed = (id, v) => store.change((q) => { const k = kitById(q, kit.id); v = Math.max(0, Math.round(v)); if (v) k.need[id] = v; else delete k.need[id]; });
    el.querySelectorAll('[data-kn]').forEach((b) => (b.onclick = () => setNeed(b.dataset.kn, (kit.need[b.dataset.kn] || 0) + +b.dataset.d)));
    el.querySelectorAll('[data-kin]').forEach((i) => { i.onchange = () => setNeed(i.dataset.kin, +i.value || 0); i.onfocus = () => i.select(); });
    el.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { ui.filter = b.dataset.f; draw(); }));
    const setW = (v) => { ui.want = clamp(Math.round(v) || 1, 1, 500); draw(); };
    if (el.querySelector('#wM')) { el.querySelector('#wM').onclick = () => setW(want - 1); el.querySelector('#wP').onclick = () => setW(want + 1); el.querySelector('#wV').onchange = (e) => setW(+e.target.value); }
    const tp = el.querySelector('#toPrint'); if (tp) tp.onclick = () => { store.change((q) => { for (const id of printIds) q.print[id] = short[id]; q.printKit = kit.id; }); toast(`Print list set for ${pn(want, 'complete kit')}`, { label: 'Open Print', run: () => go(projPath('print')) }); };
    const cb = el.querySelector('#copyBuy'); if (cb) cb.onclick = async () => { const txt = buyIds.map((id) => { const t = partById(p, id); return `${short[id]} × ${t.name}${t.partNo ? ' (' + t.partNo + ')' : ''}`; }).join('\n'); try { await navigator.clipboard.writeText(txt); toast('Shopping list copied'); } catch (e) { toast('Couldn’t copy. Select the list and copy it by hand.'); } };
    el.querySelector('#kRen').onclick = async () => { const n = await promptBox({ title: 'Rename kit', label: 'Kit name', value: kit.name }); if (n) store.change((q) => { kitById(q, kit.id).name = n; }); };
    el.querySelector('#kDel').onclick = async () => { if (await confirmBox({ title: `Delete the ${esc(kit.name)} kit?`, text: 'Your parts and counts stay. Only the kit’s list of what it needs is removed.', ok: 'Delete kit', danger: true })) { store.change((q) => { q.kits = q.kits.filter((k) => k.id !== kit.id); }); go(projPath('kits')); } };
  }
  function counterView(el, p, kit) {
    const ids = kitParts(p, kit).map((t) => t.id);
    const st = store.project().kitCounter && store.project().kitCounter.kit === kit.id ? store.project().kitCounter : { kit: kit.id, i: 0, kits: 1, found: {} };
    const save = (patch) => store.change((q) => { q.kitCounter = Object.assign({}, st, patch); }, { quiet: true });
    const i = clamp(st.i, 0, ids.length); const done = i >= ids.length; const c = counts(p);
    const head = `<div class="hero"><div><a class="small" href="#/${projPath('kits', kit.id)}">← ${esc(kit.name)}</a><h1 style="margin-top:4px">Count part by part</h1><p class="sub">Go through your pile one part at a time. Type how many you find; it works out what’s missing for the kits you want.</p></div>
      <div class="btnrow"><span class="muted">Kits wanted</span><span class="stepper"><button type="button" id="ckM">−</button><input type="number" id="ckV" min="1" value="${st.kits}"><button type="button" id="ckP">+</button></span><button type="button" class="btn ghost" id="ckReset">Start over</button></div></div>
      <div class="dots" aria-label="Progress">${ids.map((id, j) => `<i class="${j < i ? 'd' : j === i ? 'c' : ''}" title="${esc(partById(p, id).name)}"></i>`).join('')}</div>`;
    if (done) {
      const found = st.found; const missing = {}; for (const id of ids) { const q = Math.max(0, st.kits * (kit.need[id] || 0) - (found[id] || 0)); if (q) missing[id] = q; }
      const mIds = Object.keys(missing); const nPrint = mIds.filter((id) => partById(p, id).model);
      el.innerHTML = `<div class="page">${head}<div class="card pad" style="display:grid;gap:12px">
        <h2>${mIds.length ? `Missing ${pn(Object.values(missing).reduce((a, b) => a + b, 0), 'piece')} for ${pn(st.kits, 'kit')}` : `You have everything for ${pn(st.kits, 'kit')}`}</h2>
        ${mIds.length ? `<div class="misslist">${mIds.map((id) => mchip(partById(p, id), missing[id])).join('')}</div>` : ''}
        <div class="btnrow">${nPrint.length ? '<button type="button" class="btn primary" id="ckPrint">Put the missing pieces on the print list</button>' : ''}<button type="button" class="btn" id="ckInv">Use what I counted as my inventory</button><button type="button" class="btn ghost" id="ckBack">Go back a part</button></div>
        <p class="small muted">“Use as my inventory” sets each part’s count to what you typed here. Parts not in this kit don’t change.</p></div></div>`;
      const pr = el.querySelector('#ckPrint'); if (pr) pr.onclick = () => { store.change((q) => { for (const id of nPrint) q.print[id] = missing[id]; q.printKit = kit.id; }); toast('Print list updated', { label: 'Open Print', run: () => go(projPath('print')) }); };
      el.querySelector('#ckInv').onclick = async () => {
        if (!(await confirmBox({ title: 'Use these counts?', text: `Each of the ${ids.length} parts in this kit gets the count you typed. Everything else stays.`, ok: 'Use as inventory' }))) return;
        store.change((q) => { const before = counts(q); for (const id of ids) setCount(q, id, found[id] || 0); logEvent(q, 'kit', `Counted ${kit.name} parts by hand`, diff(before, counts(q))); }); toast('Inventory updated');
      };
      el.querySelector('#ckBack').onclick = () => { save({ i: ids.length - 1 }); draw(); };
    } else {
      const t = partById(p, ids[i]); const need = kit.need[t.id]; const val = st.found[t.id] != null ? st.found[t.id] : (c[t.id] || 0);
      const goal = need * st.kits;
      el.innerHTML = `<div class="page">${head}
        <div class="counter"><div class="stage">${t.thumb && store.cachedUrl(t.thumb) ? `<img src="${store.cachedUrl(t.thumb)}" alt="${esc(t.name)}">` : thumbHTML(t, 'lg')}
          ${t.model ? '<button type="button" class="btn small" id="ck3d" style="position:absolute;right:10px;top:10px">View 3D</button>' : ''}</div>
          <div class="side card pad"><div class="small muted">Part ${i + 1} of ${ids.length}</div><div class="row"><h2 style="font-size:26px">${esc(t.name)}</h2>${codeTag(t)}</div>
            <div class="small muted">${[dimsText(t), t.partNo && '#' + esc(t.partNo)].filter(Boolean).join(' · ')}${t.notes ? `<br>${esc(t.notes)}` : ''}</div>
            <div class="row" style="align-items:baseline;gap:10px"><span class="needbig">${need}</span><span class="muted">per kit · ${goal} for ${pn(st.kits, 'kit')}</span></div>
            <label class="field"><span>How many did you find?</span><span class="stepper big"><button type="button" id="cM">−</button><input type="number" id="cV" min="0" value="${val}" autofocus><button type="button" id="cP">+</button></span></label>
            <div id="cMsg" class="note"></div>
            <div class="btnrow"><button type="button" class="btn" id="cPrev" ${i ? '' : 'disabled'}>← Back</button><button type="button" class="btn primary" id="cNext">Next part <span class="k">Enter</span></button><button type="button" class="linkbtn small" id="cEdit">Edit part</button></div></div></div></div>`;
      const inp = el.querySelector('#cV'); const msg = () => { const v = Math.max(0, +inp.value || 0); const m = goal - v; el.querySelector('#cMsg').className = 'note ' + (m > 0 ? 'warn' : 'ok'); el.querySelector('#cMsg').textContent = m > 0 ? `${m} short for ${pn(st.kits, 'kit')}.` : m < 0 ? `${-m} extra.` : 'Exactly enough.'; };
      const setV = (v) => { inp.value = Math.max(0, v); msg(); }; msg();
      el.querySelector('#cM').onclick = () => setV((+inp.value || 0) - 1); el.querySelector('#cP').onclick = () => setV((+inp.value || 0) + 1); inp.oninput = msg;
      const next = (d) => { const f = Object.assign({}, st.found, { [t.id]: Math.max(0, Math.round(+inp.value || 0)) }); st.found = f; st.i = i + d; save({ found: f, i: i + d }); draw(); };
      el.querySelector('#cNext').onclick = () => next(1); el.querySelector('#cPrev').onclick = () => next(-1);
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); next(1); } };
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
      if (el.querySelector('#ck3d')) el.querySelector('#ck3d').onclick = () => viewModel(t);
      el.querySelector('#cEdit').onclick = () => openPartEditor(t.id);
    }
    const setK = (v) => { save({ kits: clamp(Math.round(v) || 1, 1, 500) }); st.kits = clamp(Math.round(v) || 1, 1, 500); draw(); };
    el.querySelector('#ckM').onclick = () => setK(st.kits - 1); el.querySelector('#ckP').onclick = () => setK(st.kits + 1); el.querySelector('#ckV').onchange = (e) => setK(+e.target.value);
    el.querySelector('#ckReset').onclick = () => { save({ i: 0, found: {} }); st.i = 0; st.found = {}; draw(); };
  }
  await draw();
  return { update: () => { const a = document.activeElement; if (a && a.matches && a.matches('input')) return; draw(); } };
}
