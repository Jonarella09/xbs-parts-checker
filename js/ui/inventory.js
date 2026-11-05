// Inventory: every part with its count. Edit counts by hand, add parts, see kit progress.
import * as store from '../store.js';
import { counts, total, sortedParts, catOrder, kitStatus, setCount, logEvent, partById, resetInventory, KINDS, kitById } from '../proj.js';
import { esc, pn, toast, choiceBox, confirmBox, pickFiles, debounce, when } from '../util.js';
import { thumbButton, codeTag, dimsText, warmThumbs, mchip } from './common.js';
import { openPartEditor, addPartsFromModels, viewModel } from './part.js';
import { go, projPath } from '../main.js';

const ui = { q: '', show: 'all', kit: null };

export async function mount(el, route, ctx) {
  ctx.dropHandler = { label: 'Drop .stl files to add them as parts', run: async (files) => { const ids = await addPartsFromModels(files); if (ids.length) toast(`Added ${pn(ids.length, 'part')} from 3D models`); } };
  const draw = async () => {
    const p = store.project(); await warmThumbs(p);
    const c = counts(p); const tot = total(c);
    if (!ui.kit || !kitById(p, ui.kit)) ui.kit = p.kits[0] ? p.kits[0].id : null;
    const kit = ui.kit ? kitById(p, ui.kit) : null; const ks = kit ? kitStatus(p, kit, c) : null;
    const drafts = p.photos.filter((ph) => ph.status === 'draft');
    const parts = sortedParts(p);
    const s = ui.q.toLowerCase();
    const want = kit ? (ks.complete + 1) : 0;
    const vis = parts.filter((t) => (!s || [t.name, t.code, t.partNo, t.cat, t.notes].join(' ').toLowerCase().includes(s))
      && (ui.show === 'all' || (ui.show === 'have' && c[t.id] > 0) || (ui.show === 'none' && !c[t.id]) || (ui.show === 'short' && kit && (kit.need[t.id] || 0) * want > c[t.id])));
    const cats = catOrder(p);
    const credit = p.credit ? `<p class="small muted" style="margin-top:4px">${p.credit.label ? `${esc(p.credit.prefix || 'Model')}: <a href="${esc(p.credit.url)}" target="_blank" rel="noopener">${esc(p.credit.label)}</a>` : ''}${p.credit.by ? ` by <a href="${esc(p.credit.byUrl)}" target="_blank" rel="noopener">${esc(p.credit.by)}</a>` : ''}${p.credit.handle ? ` (${esc(p.credit.handle)})` : ''}${p.credit.site ? ` on ${esc(p.credit.site)}` : ''}</p>` : '';
    el.innerHTML = `<div class="page">
      <div class="hero"><div><div class="row"><h1>${esc(p.name)}</h1><span class="tag">${esc(KINDS[p.kind] ? KINDS[p.kind].short : '')}</span></div>${credit}
        <p class="sub">${p.parts.length ? `${pn(tot, 'piece')} across ${pn(p.parts.length, 'part')}.` : 'No parts yet. Add them by hand, from 3D models, or count a photo.'} ${p.notes ? esc(p.notes) : ''}</p></div>
        <div class="btnrow"><button type="button" class="btn" id="addModels">+ From 3D models</button><button type="button" class="btn primary" id="addPart">+ Add part</button><button type="button" class="btn ghost" id="more">More…</button></div></div>
      ${drafts.length ? `<div class="note info">${pn(drafts.length, 'photo')} still being checked. <a href="#/${projPath('count', drafts[0].id)}">Finish checking</a> to add ${drafts.length === 1 ? 'its' : 'their'} pieces here.</div>` : ''}
      ${p.parts.length ? statsHTML(p, c, tot, kit, ks) : ''}
      ${p.parts.length ? `<div class="toolbar">
        <div class="search"><span class="muted" aria-hidden="true">⌕</span><input type="search" id="q" placeholder="Search parts" value="${esc(ui.q)}" aria-label="Search parts"></div>
        <div class="seg" role="group" aria-label="Show">${[['all', 'All'], ['have', 'Have some'], ['none', 'None yet'], ...(kit ? [['short', `Short for kit ${want}`]] : [])].map(([k, l]) => `<button type="button" data-show="${k}" aria-pressed="${ui.show === k}">${l}</button>`).join('')}</div>
        ${p.kits.length > 1 ? `<select class="sel" id="kitSel" aria-label="Kit">${p.kits.map((k) => `<option value="${esc(k.id)}"${k.id === ui.kit ? ' selected' : ''}>${esc(k.name)}</option>`).join('')}</select>` : ''}
        <span class="spacer"></span><span class="small muted">${vis.length === parts.length ? pn(parts.length, 'part') : `${vis.length} of ${parts.length} parts`}</span></div>` : emptyHTML(p)}
      <div class="invlist">${cats.map((cat) => { const rows = vis.filter((t) => (t.cat || '') === cat); if (!rows.length) return '';
        return `<section class="invgroup">${cats.length > 1 || cat ? `<h3>${esc(cat || 'Other')}</h3>` : ''}<div class="invlist">${rows.map((t) => rowHTML(t, c[t.id] || 0, kit, ks)).join('')}</div></section>`; }).join('')}</div>
    </div>`;
    wire(el, p);
  };
  function statsHTML(p, c, tot, kit, ks) {
    const out = [`<div class="stat"><div class="v">${tot.toLocaleString()}</div><div class="l">pieces counted</div></div>`, `<div class="stat"><div class="v">${p.parts.length}</div><div class="l">kinds of parts</div></div>`];
    if (kit) {
      out.push(`<div class="stat ${ks.complete ? 'good' : ''}"><div class="v">${ks.complete}</div><div class="l">complete ${esc(kit.name)} ${ks.complete === 1 ? 'kit' : 'kits'}</div></div>`);
      out.push(`<div class="stat"><div class="v">${ks.nextN}</div><div class="l">pieces short of kit ${ks.complete + 1}</div></div>`);
    } else if (p.kind === 'kits') out.push(`<div class="stat"><div class="v">–</div><div class="l">No kit defined yet · <a href="#/${projPath('kits')}">define one</a></div></div>`);
    const last = p.log[0]; if (last) out.push(`<div class="stat"><div class="v" style="font-size:17px;line-height:1.3">${esc(when(last.t))}</div><div class="l">last change · <a href="#/${projPath('history')}">history</a></div></div>`);
    let h = `<div class="stats">${out.join('')}</div>`;
    if (kit && ks.nextN) h += `<div class="card pad" style="display:grid;gap:8px"><div class="row"><b>Kit ${ks.complete + 1} still needs</b><span class="spacer"></span><a class="btn small" href="#/${projPath('kits', kit.id)}">Kit details</a></div><div class="misslist">${Object.entries(ks.next).map(([id, q]) => mchip(partById(p, id), q)).join('')}</div></div>`;
    return h;
  }
  function rowHTML(t, have, kit, ks) {
    const need = kit ? kit.need[t.id] || 0 : 0; const n = ks ? ks.complete + 1 : 0;
    const sub = [t.partNo && `#${esc(t.partNo)}`, dimsText(t), t.perPack && `${t.perPack} per pack`, t.model && '3D model'].filter(Boolean);
    let nb = '';
    if (kit && need) { const goal = need * n; const pct = Math.min(100, Math.round(100 * have / goal)); nb = `<div class="needbar" title="${need} per kit"><div class="t"><span>${have} / ${goal}</span><span>${need} per kit</span></div><div class="bar${have < goal ? ' low' : ''}"><i style="width:${pct}%"></i></div></div>`; }
    else if (kit) nb = `<div class="needbar"><div class="t"><span class="muted">not in this kit</span></div></div>`;
    return `<div class="prow" data-row="${esc(t.id)}">
      ${thumbButton(t, `data-view="${esc(t.id)}" aria-label="${t.model ? 'View 3D model of' : 'Edit'} ${esc(t.name)}"`)}
      <div class="info"><div class="nm"><b>${esc(t.name)}</b>${codeTag(t)}</div><div class="sub">${sub.map((x) => `<span>${x}</span>`).join('')}<button type="button" class="linkbtn small" data-edit="${esc(t.id)}">Edit</button></div></div>
      <div class="right">${nb}<span class="stepper"><button type="button" data-step="-1" data-id="${esc(t.id)}" aria-label="One less ${esc(t.name)}">−</button><input type="number" min="0" inputmode="numeric" value="${have}" data-count="${esc(t.id)}" aria-label="How many ${esc(t.name)}"><button type="button" data-step="1" data-id="${esc(t.id)}" aria-label="One more ${esc(t.name)}">+</button></span></div>
    </div>`;
  }
  function emptyHTML(p) {
    return `<div class="empty"><h3>Add your first parts</h3><p>Parts are the kinds of things you count: a screw size, a gear, a field element. Add them however suits you.</p>
      <div class="btnrow" style="justify-content:center"><button type="button" class="btn primary" id="e1">Add a part by hand</button><button type="button" class="btn" id="e2">From 3D models (.stl)</button><a class="btn" href="#/${projPath('count')}">Count a photo</a></div>
      <p class="small">Counting a photo with nothing defined yet groups the pieces by look and size. You name each group and it becomes a part.</p></div>`;
  }
  function bump(id, delta, abs) {
    store.change((q) => {
      const t = partById(q, id); const cur = counts(q)[id] || 0; const v = abs != null ? abs : Math.max(0, cur + delta);
      const d = setCount(q, id, v); if (!d) return;
      const last = q.log[0];
      if (last && last.kind === 'manual' && last.part === id && Date.now() - last.t < 60000) { last.d[id] = (last.d[id] || 0) + d; last.t = Date.now(); last.text = `Changed ${t.name} by hand`; if (!last.d[id]) q.log.shift(); }
      else { logEvent(q, 'manual', `Changed ${t.name} by hand`, { [id]: d }); q.log[0].part = id; }
    }, { quiet: true });
    const inp = el.querySelector(`[data-count="${CSS.escape(id)}"]`); const p = store.project(); const c = counts(p);
    if (inp && document.activeElement !== inp) inp.value = c[id];
    softRefresh();
  }
  const softRefresh = debounce(() => { const y = scrollY; draw().then(() => window.scrollTo(0, y)); ctxRefresh(); }, 600);
  const ctxRefresh = () => ctx.refreshBar();
  function wire(el, p) {
    const q = el.querySelector('#q'); if (q) q.oninput = debounce((e) => { ui.q = e.target.value; draw().then(() => { const i = el.querySelector('#q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 200);
    el.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => { ui.show = b.dataset.show; draw(); }));
    const ks = el.querySelector('#kitSel'); if (ks) ks.onchange = () => { ui.kit = ks.value; draw(); };
    el.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => bump(b.dataset.id, +b.dataset.step)));
    el.querySelectorAll('[data-count]').forEach((i) => { i.onchange = () => bump(i.dataset.count, 0, Math.max(0, Math.round(+i.value || 0))); i.onfocus = () => i.select(); });
    el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openPartEditor(b.dataset.edit)));
    el.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { const t = partById(p, b.dataset.view); if (t.model) viewModel(t); else openPartEditor(t.id); }));
    const add = () => openPartEditor(null);
    el.querySelector('#addPart').onclick = add; if (el.querySelector('#e1')) el.querySelector('#e1').onclick = add;
    const addM = async () => { const files = await pickFiles({ accept: '.stl,model/stl', multiple: true }); if (!files.length) return; toast('Reading 3D models…'); const ids = await addPartsFromModels(files); if (ids.length) toast(`Added ${pn(ids.length, 'part')} from 3D models`); };
    el.querySelector('#addModels').onclick = addM; if (el.querySelector('#e2')) el.querySelector('#e2').onclick = addM;
    el.querySelector('#more').onclick = async () => {
      const a = await choiceBox({ title: 'More', options: [
        { value: 'reset', icon: '0', label: 'Reset all counts to zero', desc: 'For when the pieces were used up. Photos counted so far move to History, where you can still see them.' },
        { value: 'kits', icon: '▦', label: p.kits.length ? 'Kits' : 'Define a kit', desc: 'A kit is the list of parts (and how many of each) that build one of something.' },
        { value: 'history', icon: '↺', label: 'History', desc: 'Earlier photos and every change to the counts.' }] });
      if (a === 'reset') {
        if (!(await confirmBox({ title: 'Reset all counts to zero?', text: `${pn(total(counts(p)), 'piece')} will go back to zero. Counted photos are kept in History and stop counting. You can save a .star file first to keep a copy as it is now.`, ok: 'Reset to zero', danger: true }))) return;
        store.change((q) => resetInventory(q, 'Reset all counts to zero')); toast('All counts are back to zero. Earlier photos are in History.');
      }
      if (a === 'kits') go(projPath('kits')); if (a === 'history') go(projPath('history'));
    };
  }
  await draw();
  return { update: () => { const y = scrollY; const a = document.activeElement; if (a && a.matches && a.matches('[data-count],#q')) return; draw().then(() => window.scrollTo(0, y)); } };
}
