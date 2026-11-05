// Shared bits of UI used by several views.
import * as store from '../store.js';
import { partLabel, sortedParts, catOrder } from '../proj.js';
import { esc, inkOn, openModal, closeModal } from '../util.js';

export async function warmThumbs(p) { await store.warmUrls(p.parts.map((t) => t.thumb)); }
export function thumbHTML(t, cls = '') {
  if (!t) return `<span class="thumb ${cls}"><span class="ini">?</span></span>`;
  const u = t.thumb && store.cachedUrl(t.thumb);
  if (u) return `<span class="thumb ${cls}"><img src="${u}" alt="" loading="lazy"></span>`;
  const ini = esc((t.code || t.name || '?').slice(0, 4));
  return `<span class="thumb ${cls}" style="background:${esc(t.color)};color:${inkOn(t.color)}"><span class="ini" style="color:inherit">${ini}</span></span>`;
}
/** The thumbnail as a button (attrs is a string of extra attributes). */
export function thumbButton(t, attrs = '', cls = '') {
  const u = t.thumb && store.cachedUrl(t.thumb);
  if (u) return `<button type="button" class="thumb ${cls}" ${attrs}><img src="${u}" alt="" loading="lazy"></button>`;
  return `<button type="button" class="thumb ${cls}" ${attrs} style="background:${esc(t.color)};color:${inkOn(t.color)}"><span class="ini" style="color:inherit">${esc((t.code || t.name || '?').slice(0, 4))}</span></button>`;
}
export const codeTag =(t) => (t && t.code ? `<span class="code" style="border-color:${esc(t.color)}">${esc(t.code)}</span>` : '');
export function mchip(t, q, prefix = '×') {
  const u = t.thumb && store.cachedUrl(t.thumb);
  return `<span class="mchip" title="${esc(t.name)}">${u ? `<img src="${u}" alt="">` : `<span class="sw" style="width:18px;height:18px;border-radius:50%;background:${esc(t.color)}"></span>`}${esc(partLabel(t))} <b>${prefix}${q}</b></span>`;
}
export function dimsText(t) {
  const d = t.dims || {}; const v = [d.l, d.w, d.h].filter((x) => x > 0).map((x) => (Math.round(x * 10) / 10));
  return v.length ? v.join(' × ') + ' mm' : '';
}

/** A searchable visual picker for parts. Resolves with a part id, '__new' or null. */
export function pickPart(p, { title = 'Which part is it?', current = null, allowNew = true, hint = '' } = {}) {
  return new Promise((res) => {
    let done = false; let q = '';
    const m = openModal({ title, cls: 'wide', body: `${hint ? `<div class="note">${hint}</div>` : ''}<div class="search"><span class="muted">⌕</span><input type="search" id="ppq" placeholder="Search by name, code or part number" autofocus></div><div id="ppl" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px"></div>`,
      foot: `${allowNew ? '<button type="button" class="btn" id="ppNew">+ New part</button>' : ''}<span class="spacer"></span><button type="button" class="btn" data-close>Cancel</button>`, onClose: () => { if (!done) res(null); } });
    const list = m.el.querySelector('#ppl');
    const draw = () => {
      const s = q.toLowerCase(); const cats = catOrder(p);
      const parts = sortedParts(p).filter((t) => !s || [t.name, t.code, t.partNo, t.cat].join(' ').toLowerCase().includes(s));
      list.innerHTML = parts.length ? parts.map((t) => `<button type="button" class="alt${t.id === current ? ' best' : ''}" data-id="${esc(t.id)}" style="grid-template-columns:44px 1fr;padding:6px">${thumbHTML(t, 'sm')}<span style="display:grid;min-width:0"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</b><span class="tiny muted">${esc([t.code, t.cat].filter(Boolean).join(' · '))}</span></span></button>`).join('') : `<div class="muted">No parts match “${esc(q)}”.</div>`;
      list.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => { done = true; res(b.dataset.id); closeModal(m); }));
      void cats;
    };
    m.el.querySelector('#ppq').oninput = (e) => { q = e.target.value; draw(); };
    const nb = m.el.querySelector('#ppNew'); if (nb) nb.onclick = () => { done = true; res('__new'); closeModal(m); };
    draw();
  });
}
