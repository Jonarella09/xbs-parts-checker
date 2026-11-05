// History: every photo (being checked, counted, archived) and every change to the counts.
import * as store from '../store.js';
import { photoSummary, partById, logEvent, counts, diff, isCounted } from '../proj.js';
import { esc, pn, when, fullDate, toast, confirmBox } from '../util.js';
import { warmThumbs, mchip } from './common.js';
import { projPath } from '../main.js';

const ui = { logN: 60 };
const MODE = { parts: 'Identify parts', quick: 'Count one kind', labels: 'Package labels' };

export async function mount(el, route, ctx) {
  ctx.dropHandler = null;
  const draw = async () => {
    const p = store.project(); await warmThumbs(p);
    await store.warmUrls(p.photos.map((ph) => ph.thumb || ph.file));
    const groups = [['draft', 'Being checked', 'Not counted yet. Finish checking to add the pieces.'], ['added', 'Counted', 'These photos make up the counts in Inventory.'], ['archived', 'Archived', 'Kept for reference. Their pieces don’t count anymore.']];
    el.innerHTML = `<div class="page">
      <div class="hero"><div><h1>History</h1><p class="sub">Every photo you’ve counted and every change to the counts. Archived photos keep the pieces that were found on them, so you can always look back.</p></div></div>
      ${p.photos.length ? groups.map(([st, title, sub]) => { const list = p.photos.filter((ph) => ph.status === st).sort((a, b) => (b.at || 0) - (a.at || 0)); if (!list.length) return '';
        return `<div class="section-h"><h2>${title}</h2><span class="muted">${sub}</span></div><div class="hist">${list.map((ph) => photoCard(p, ph)).join('')}</div>`; }).join('')
      : `<div class="empty"><h3>No photos yet</h3><p>Photos you count show up here.</p><a class="btn primary" href="#/${projPath('count')}">Count a photo</a></div>`}
      <div class="section-h"><h2>Changes</h2><span class="muted">${pn(p.log.length, 'entry', 'entries')}</span></div>
      ${p.log.length ? `<div class="card pad"><div class="log">${p.log.slice(0, ui.logN).map((e) => `<div class="le"><time datetime="${new Date(e.t).toISOString()}" title="${esc(fullDate(e.t))}">${esc(when(e.t))}</time><div style="display:grid;gap:6px"><span>${esc(e.text)}</span>${e.d ? `<div class="misslist">${Object.entries(e.d).filter(([id]) => partById(p, id)).slice(0, 16).map(([id, v]) => mchip(partById(p, id), Math.abs(v), v > 0 ? '+' : '−')).join('')}${Object.keys(e.d).length > 16 ? `<span class="small muted">+${Object.keys(e.d).length - 16} more</span>` : ''}</div>` : ''}</div></div>`).join('')}</div>
        ${p.log.length > ui.logN ? '<div class="btnrow" style="margin-top:10px"><button type="button" class="btn small" id="more">Show more</button></div>' : ''}</div>` : '<div class="note">No changes yet.</div>'}
    </div>`;
    el.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act(b.dataset.act, b.dataset.id)));
    const m = el.querySelector('#more'); if (m) m.onclick = () => { ui.logN += 100; draw(); };
  };
  function photoCard(p, ph) {
    const s = photoSummary(ph); const u = store.cachedUrl(ph.thumb || ph.file);
    const status = ph.status === 'added' ? `<span class="tag ok">Counted</span>` : ph.status === 'draft' ? '<span class="tag warn">Being checked</span>' : '<span class="tag">Archived</span>';
    const dates = [`Added ${when(ph.at)}`]; if (ph.addedAt) dates.push(`counted ${when(ph.addedAt)}`); if (ph.archivedAt) dates.push(`archived ${when(ph.archivedAt)}${ph.archivedWhy ? ` (${esc(ph.archivedWhy.toLowerCase())})` : ''}`);
    return `<article class="card photocard"><a class="pv" href="#/${projPath('count', ph.id)}" aria-label="Open ${esc(ph.name)}">${u ? `<img src="${u}" alt="">` : ''}</a>
      <div style="display:grid;gap:4px;min-width:0"><div class="row"><b>${esc(ph.name)}</b>${status}<span class="tag">${esc(MODE[ph.mode] || 'Photo')}</span></div>
        <div class="small muted">${pn(s.pieces, 'piece')} identified${s.unknown ? ` · ${s.unknown} unknown` : ''}${s.check ? ` · ${s.check} to check` : ''}</div><div class="tiny muted">${dates.join(' · ')}</div></div>
      <div class="btnrow acts"><a class="btn small" href="#/${projPath('count', ph.id)}">Open</a>
        ${ph.status === 'added' ? `<button type="button" class="btn small" data-act="archive" data-id="${esc(ph.id)}">Stop counting</button>` : ''}
        ${ph.status === 'archived' ? `<button type="button" class="btn small" data-act="restore" data-id="${esc(ph.id)}">Count it again</button>` : ''}
        <button type="button" class="btn small ghost danger" data-act="del" data-id="${esc(ph.id)}">Delete</button></div></article>`;
  }
  async function act(a, id) {
    const p = store.project(); const ph = p.photos.find((x) => x.id === id); if (!ph) return;
    if (a === 'archive') { store.change((q) => { const before = counts(q); const x = q.photos.find((y) => y.id === id); x.status = 'archived'; x.archivedAt = Date.now(); x.archivedWhy = 'Stopped counting'; logEvent(q, 'photo', `Stopped counting ${x.name}`, diff(before, counts(q))); }); toast(`${esc(ph.name)} no longer counts`); }
    if (a === 'restore') { store.change((q) => { const before = counts(q); const x = q.photos.find((y) => y.id === id); x.status = 'added'; x.addedAt = Date.now(); delete x.archivedAt; delete x.archivedWhy; logEvent(q, 'photo', `Counted ${x.name} again`, diff(before, counts(q))); }); toast(`${esc(ph.name)} counts again`); }
    if (a === 'del') {
      if (!(await confirmBox({ title: `Delete ${esc(ph.name)}?`, text: isCounted(ph) ? 'Its pieces will stop counting, and the photo and what was found on it are removed.' : 'The photo and what was found on it are removed.', ok: 'Delete photo', danger: true }))) return;
      if (ph.file) await store.delFile(ph.file); if (ph.thumb) await store.delFile(ph.thumb);
      store.change((q) => { const before = counts(q); q.photos = q.photos.filter((x) => x.id !== id); logEvent(q, 'photo', `Deleted photo ${ph.name}`, diff(before, counts(q))); }); toast('Photo deleted');
    }
  }
  await draw();
  return { update: draw };
}
