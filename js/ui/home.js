// Home: all projects in this browser, create a project, open a .star file, install the app.
import * as store from '../store.js';
import { KINDS } from '../proj.js';
import { esc, when, pn, openModal, closeModal, confirmBox, promptBox, choiceBox, toast, APP } from '../util.js';
import { go, openStarPicker, saveStarUI } from '../main.js';

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; const b = document.getElementById('installBtn'); if (b) b.hidden = false; });

export async function mount(el, route, ctx) {
  store.closeProject(); ctx.dropHandler = null;
  const made = [];
  async function render() {
    const [list, builtins] = await Promise.all([store.listProjects(), store.builtinList()]);
    made.forEach((u) => URL.revokeObjectURL(u)); made.length = 0;
    const thumbs = {};
    for (const p of list) thumbs[p.id] = await Promise.all(p.thumbs.map(async (t) => { const u = await store.thumbUrlFor(p.id, t.path); if (u) made.push(u); return u; }));
    const missing = [];
    for (const b of builtins) if (!list.some((p) => p.id === b.id)) missing.push(b);
    const standalone = matchMedia('(display-mode: standalone)').matches;
    el.innerHTML = `<div class="page">
      <div class="hero"><div><h1>Your projects</h1><p class="sub">Each project keeps its own parts, counts, kits and photos. Projects live in this browser; save a <b>.star</b> file to back one up or open it on another computer.</p></div>
        <div class="btnrow"><button type="button" class="btn" id="openStar">Open .star file</button><button type="button" class="btn primary" id="newProj">+ New project</button></div></div>
      <div class="projgrid">
        ${list.map((p) => card(p, thumbs[p.id], builtins)).join('')}
        <button type="button" class="newcard" id="newProj2"><span class="plus">+</span>New project<span class="small muted" style="font-weight:400">Kits or just counting</span></button>
      </div>
      ${missing.length ? `<div class="note">Built-in project${missing.length > 1 ? 's' : ''} you removed: ${missing.map((b) => `<button type="button" class="linkbtn" data-restore="${esc(b.id)}">Add “${esc(b.name)}” back</button>`).join(' · ')}</div>` : ''}
      <div class="card pad" style="display:grid;gap:12px">
        <div class="section-h"><h2>How it works</h2></div>
        <div class="steps3">
          <div class="s"><i>1 · PROJECT</i><b>Make a project</b><span class="small muted">Kits (pieces that build something) or just counting. Add parts by hand, from 3D models, or from a photo.</span></div>
          <div class="s"><i>2 · COUNT</i><b>Count from a photo</b><span class="small muted">Lay pieces on a plain surface or the printable counting mat and take a photo. Fix anything it got wrong; it learns from your fixes.</span></div>
          <div class="s"><i>3 · LABELS</i><b>Read packages</b><span class="small muted">Photograph packages laid out on a table. It reads part numbers, quantities and barcodes.</span></div>
          <div class="s"><i>4 · SAVE</i><b>Keep a .star file</b><span class="small muted">One file with everything in the project. Double-click it to open it here${standalone ? '' : ' once the app is installed'}.</span></div>
        </div>
        <div class="row" id="installRow"><button type="button" class="btn small" id="installBtn" ${installEvt ? '' : 'hidden'}>Install ${esc(APP.name)}</button>
          <span class="small muted">${standalone ? 'Installed: .star files open here when you double-click them.' : 'Installing the app (Chrome or Edge) makes it work offline, and .star files open in it with a star icon.'}</span></div>
      </div>
    </div>`;
    const newP = () => newProjectDialog();
    el.querySelector('#newProj').onclick = newP; el.querySelector('#newProj2').onclick = newP;
    el.querySelector('#openStar').onclick = () => openStarPicker();
    el.querySelectorAll('[data-menu]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); menu(list.find((p) => p.id === b.dataset.menu), builtins); }));
    el.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => { const e = builtins.find((x) => x.id === b.dataset.restore); await store.unforgetBuiltin(e.id); await store.installBuiltin(e); render(); }));
    const ib = el.querySelector('#installBtn'); if (ib) ib.onclick = async () => { if (!installEvt) return; installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; ib.hidden = true; if (r && r.outcome === 'accepted') toast('Installed. .star files now open in The Indexer.'); };
  }
  function card(p, th, builtins) {
    const b = builtins.find((x) => x.id === p.builtin); const upd = b && p.builtinVersion && p.builtinVersion < b.version;
    const cells = []; for (let i = 0; i < 4; i++) cells.push(th[i] ? `<span><img src="${th[i]}" alt=""></span>` : `<span><b class="ph">${esc(p.codes[i] || '')}</b></span>`);
    const kitLine = p.kits.length ? p.kits.map((k) => `${k.complete} complete ${esc(k.name)}`).join(' · ') : '';
    return `<a class="proj" href="#/p/${encodeURIComponent(p.id)}">
      <div class="mosaic" style="--c:${esc(p.color)}">${cells.join('')}</div>
      <div class="body"><div class="row"><h3>${esc(p.name)}</h3>${p.builtin ? '<span class="tag star">Built in</span>' : ''}${upd ? '<span class="tag warn">Update</span>' : ''}</div>
        <div class="meta"><span>${KINDS[p.kind] ? KINDS[p.kind].short : ''}</span><span>${pn(p.parts, 'part')}</span><span>${pn(p.pieces, 'piece')} counted</span>${p.photos ? `<span>${pn(p.photos, 'photo')}</span>` : ''}</div>
        ${kitLine ? `<div class="meta">${kitLine}</div>` : ''}</div>
      <div class="foot"><span class="small muted">Changed ${when(p.updated)}</span><span class="spacer"></span><button type="button" class="btn small ghost" data-menu="${esc(p.id)}" aria-label="More for ${esc(p.name)}">More…</button></div></a>`;
  }
  async function menu(p, builtins) {
    const b = builtins.find((x) => x.id === p.builtin);
    const opts = [
      { value: 'open', icon: '→', label: 'Open', desc: '' },
      { value: 'save', icon: '★', label: 'Save .star file', desc: 'Everything in this project in one file.' },
      { value: 'rename', icon: 'Aa', label: 'Rename', desc: '' },
      { value: 'dup', icon: '⧉', label: 'Duplicate', desc: 'Make a copy to try things on.' },
    ];
    if (b) opts.push({ value: 'reset', icon: '↺', label: 'Reset to the built-in version', desc: `Replaces this browser’s copy with the one that comes with the site (${esc(b.version)}).` });
    opts.push({ value: 'del', icon: '×', label: 'Delete from this browser', desc: 'Save a .star file first if you want to keep it.' });
    const a = await choiceBox({ title: esc(p.name), options: opts }); if (!a) return;
    if (a === 'open') go('p/' + encodeURIComponent(p.id));
    if (a === 'save') saveStarUI(p.id, null);
    if (a === 'rename') { const n = await promptBox({ title: 'Rename project', label: 'Project name', value: p.name }); if (n) { await store.renameProject(p.id, n); render(); } }
    if (a === 'dup') { const n = await promptBox({ title: 'Duplicate project', label: 'Name of the copy', value: p.name + ' (copy)', ok: 'Duplicate' }); if (n) { await store.duplicateProject(p.id, n); render(); toast('Copy made'); } }
    if (a === 'reset') { if (await confirmBox({ title: 'Reset to the built-in version?', text: `Your counts, photos and changes in “${esc(p.name)}” in this browser will be replaced. Save a .star file first if you want to keep them.`, ok: 'Reset', danger: true })) { await store.installBuiltin(b, { replace: true }); render(); toast('Reset to the built-in version'); } }
    if (a === 'del') { if (await confirmBox({ title: `Delete “${esc(p.name)}”?`, text: 'It will be removed from this browser. A .star file you saved stays where it is.', ok: 'Delete', danger: true })) { if (p.builtin) await store.forgetBuiltin(p.builtin); await store.deleteProject(p.id); render(); toast('Project deleted'); } }
  }
  await render();
  return { unmount() { made.forEach((u) => URL.revokeObjectURL(u)); } };
}

export function newProjectDialog() {
  let kind = 'kits';
  const m = openModal({ title: 'New project', body: `
    <label class="field"><span>Name</span><input type="text" id="npName" placeholder="e.g. goBILDA hardware, FTC field elements, Robot kit A" autofocus></label>
    <div class="field"><span>What are you counting?</span><div class="choice" role="radiogroup">
      ${Object.entries(KINDS).map(([k, v]) => `<button type="button" role="radio" data-kind="${k}" aria-checked="${k === kind}"><span class="ic">${k === 'kits' ? '▦' : '#'}</span><b>${v.label}</b><span class="d">${esc(v.desc)}</span></button>`).join('')}
    </div></div>`, foot: `<button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="npGo">Create project</button>` });
  m.el.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { kind = b.dataset.kind; m.el.querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-checked', x === b)); }));
  const go2 = async () => {
    const name = m.el.querySelector('#npName').value.trim(); if (!name) { m.el.querySelector('#npName').focus(); return; }
    const p = await store.createProject({ name, kind }); closeModal(m); go('p/' + encodeURIComponent(p.id));
  };
  m.el.querySelector('#npGo').onclick = go2; m.el.querySelector('#npName').onkeydown = (e) => { if (e.key === 'Enter') go2(); };
}
