// App shell: routing, top bar, .star opening (drag-drop, file picker, installed-app file launch), service worker.
import * as store from './store.js';
import { counts, total, kitStatus, photoSummary } from './proj.js';
import { $, esc, APP, toast, choiceBox, promptBox, busy, when, modalOpen } from './util.js';
import { pickOpenStar, canSaveInPlace } from './star.js';

const VIEWS = {
  home: () => import('./ui/home.js'),
  inventory: () => import('./ui/inventory.js'),
  count: () => import('./ui/count.js'),
  kits: () => import('./ui/kits.js'),
  print: () => import('./ui/print.js'),
  history: () => import('./ui/history.js'),
};
const TABS = [['inventory', 'Inventory'], ['count', 'Count'], ['kits', 'Kits'], ['print', 'Print'], ['history', 'History']];

let route = null, view = null, viewMod = null, renderTok = 0;
export const ctx = { route: () => route, go, openStarFile, refreshBar: () => renderBar(), dropHandler: null };

export function parseRoute() {
  const h = location.hash.replace(/^#\/?/, ''); const seg = h.split('/').filter(Boolean).map(decodeURIComponent);
  if (seg[0] === 'p' && seg[1]) return { name: TABS.some((t) => t[0] === seg[2]) ? seg[2] : 'inventory', pid: seg[1], sub: seg.slice(3) };
  return { name: 'home', sub: [] };
}
export function go(path) { const h = '#/' + path.replace(/^#?\/?/, ''); if (location.hash === h) onRoute(); else location.hash = h; }
export const projPath = (tab, ...rest) => ['p', store.project().id, tab, ...rest].map(encodeURIComponent).join('/');

async function onRoute() {
  const r = parseRoute(); const tok = ++renderTok;
  if (view && view.unmount) { try { view.unmount(); } catch (e) {} }
  view = null;
  if (r.name !== 'home') {
    const p = await store.openProject(r.pid);
    if (!p) { toast('That project isn’t in this browser.'); go(''); return; }
  }
  if (tok !== renderTok) return;
  route = r;
  document.title = r.name === 'home' ? APP.name : `${store.project().name} · ${APP.name}`;
  const app = $('app');
  app.innerHTML = `<header class="topbar" id="topbar"></header><div id="view"></div><footer class="foot" id="foot"></footer>`;
  renderBar(); renderFoot();
  viewMod = await VIEWS[r.name]();
  if (tok !== renderTok) return;
  view = (await viewMod.mount($('view'), r, ctx)) || {};
  if (r.name !== 'home') window.scrollTo(0, 0);
}

function renderFoot() {
  $('foot').innerHTML = `${esc(APP.name)} ${APP.version} “${APP.codename}” · Projects are saved in this browser. Use <b>Save .star</b> to keep a file you can back up or share.`;
}

async function renderBar() {
  const bar = $('topbar'); if (!bar || !route) return;
  const brand = `<a class="brand" href="#/" aria-label="${esc(APP.name)} home"><span class="logo-star" aria-hidden="true"></span><b>${esc(APP.name)}</b><span class="ver">${APP.version}</span></a>`;
  bar.classList.toggle('inproj', route.name !== 'home');
  if (route.name === 'home') { bar.innerHTML = brand + `<div class="savebox"><span class="save muted" id="saveTxt">Saved in this browser</span></div>`; return; }
  const p = store.project(); const c = counts(p);
  const chk = p.photos.filter((ph) => ph.status === 'draft').length;
  const kitN = p.kits.length ? Math.max(...p.kits.map((k) => kitStatus(p, k, c).complete)) : null;
  const printN = Object.values(p.print || {}).reduce((a, b) => a + (+b || 0), 0);
  const nums = { inventory: total(c), count: chk ? chk + ' open' : '', kits: kitN == null ? '' : kitN + ' complete', print: printN || '', history: '' };
  bar.innerHTML = `${brand}<span class="crumb"><span class="sep">/</span><button type="button" class="pname" id="pName" title="Rename project">${esc(p.name)}</button></span>
    <nav class="tabs" aria-label="Project sections">${TABS.map(([k, l]) => `<a href="#/${projPath(k)}" ${route.name === k ? 'aria-current="page"' : ''}>${l}${nums[k] !== '' && nums[k] != null ? `<span class="n">${nums[k]}</span>` : ''}</a>`).join('')}</nav>
    <div class="savebox"><span class="save" id="saveTxt" data-s="ok">Saved in this browser</span><button type="button" class="btn small star" id="saveStar" title="Save this project as a .star file">Save .star</button></div>`;
  $('pName').onclick = async () => { const n = await promptBox({ title: 'Rename project', label: 'Project name', value: p.name }); if (n) { await store.renameProject(p.id, n); renderBar(); } };
  $('saveStar').onclick = (e) => saveStarUI(p.id, e.currentTarget);
  updateSave();
}
async function updateSave() {
  const el = $('saveTxt'); const p = store.project(); if (!el || !p) return;
  const s = store.status(); const info = await store.fileInfo(p.id);
  if (s.saving || s.dirty) { el.dataset.s = 'busy'; el.textContent = 'Saving…'; return; }
  const need = store.needsFileSave(p, info);
  el.dataset.s = need ? 'dirty' : 'ok';
  el.textContent = need ? (info ? `Changes not in ${info.name} yet` : 'Saved in this browser only') : `Saved · ${info.name}`;
  el.title = info && info.savedAt ? `Last saved to ${info.name} ${when(info.savedAt)}` : 'Save a .star file to back this project up or share it';
}
export async function saveStarUI(id, btn, as = false) {
  await busy(btn, async () => {
    try {
      const r = await store.saveStar(id, { as }); if (!r) return;
      toast(r.inPlace ? `Saved to ${esc(r.name)}` : `Downloaded ${esc(r.name)}. Keep it somewhere safe, or open it on another computer.`);
    } catch (e) { console.error(e); toast('Couldn’t save the file: ' + esc(e.message || e)); }
  });
  updateSave();
}

/* ---------- opening .star files ---------- */
export async function openStarFile(file, handle) {
  let un;
  try { un = await store.readStar(file); } catch (e) { toast(esc(e.message || 'That file couldn’t be opened.')); return; }
  let mode = 'replace';
  if (un.existing) {
    mode = await choiceBox({ title: `You already have “${esc(un.existing.name)}”`, text: `This browser has its own copy, last changed ${when(un.existing.updated)}. The file was saved ${when(un.project.updated)}.`,
      options: [{ value: 'replace', icon: '↻', label: 'Open the file', desc: 'Replace this browser’s copy with the one in the file.' },
        { value: 'copy', icon: '+', label: 'Keep both', desc: 'Open the file as a separate project.' },
        { value: 'mine', icon: '←', label: 'Keep mine', desc: 'Don’t open the file. Go to this browser’s copy.' }] });
    if (!mode) return;
    if (mode === 'mine') { go('p/' + un.existing.id); return; }
  }
  const p = await store.storeStar(un, { mode, handle, fileName: file.name });
  toast(`Opened ${esc(p.name)}`);
  go('p/' + encodeURIComponent(p.id));
}
export async function openStarPicker() { const r = await pickOpenStar(); if (r) await openStarFile(r.file, r.handle); }

/* ---------- drag & drop anywhere ---------- */
let dragN = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragN++; $('dropzone').hidden = false; $('dropText').textContent = ctx.dropHandler ? ctx.dropHandler.label : 'Drop a .star file to open it'; });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragN = Math.max(0, dragN - 1); if (!dragN) $('dropzone').hidden = true; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return; e.preventDefault(); dragN = 0; $('dropzone').hidden = true;
  const files = Array.from(e.dataTransfer.files || []); if (!files.length || modalOpen()) return;
  const star = files.find((f) => /\.star$/i.test(f.name));
  if (star) { await openStarFile(star, null); return; }
  if (ctx.dropHandler) ctx.dropHandler.run(files); else toast('Open a project first, then drop photos or 3D models on it.');
});

/* ---------- boot ---------- */
store.on((what) => {
  if (what === 'status') { updateSave(); return; }
  if (what === 'change') { renderBar(); if (view && view.update) view.update(); }
});
window.addEventListener('hashchange', onRoute);

async function boot() {
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      for (const h of params.files || []) { try { const f = await h.getFile(); if (/\.star$/i.test(f.name)) await openStarFile(f, h); } catch (e) { console.error(e); } }
    });
  }
  try { await store.syncBuiltins(); } catch (e) { console.warn(e); }
  await onRoute();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && !/[?&]nosw/.test(location.search)) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
  }
}
boot();
export { store, canSaveInPlace };
