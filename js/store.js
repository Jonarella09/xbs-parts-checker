// Project storage: the open project, autosave to this browser, files (models, photos), .star import/export, built-in projects.
import * as db from './db.js';
import { migrate, newProject, counts, total, kitStatus, sortedParts } from './proj.js';
import { packStar, unpackStar, filePaths, starName, canSaveInPlace, pickSaveHandle, writeHandle } from './star.js';
import { uid, debounce, clone, saveBlob, mimeOf } from './util.js';

let cur = null;                // the open project
const urls = new Map();        // path -> object URL for the open project
const subs = new Set();
export const on = (fn) => (subs.add(fn), () => subs.delete(fn));
const emit = (what) => subs.forEach((f) => { try { f(what); } catch (e) { console.error(e); } });
export const project = () => cur;

/* ---------- save status ---------- */
let saving = false, dirty = false;
export const status = () => ({ saving, dirty });
const saveSoon = debounce(() => saveNow(), 350);
export async function saveNow() {
  if (!cur || !dirty) return; saving = true; dirty = false; emit('status');
  try { await db.put('projects', cur.id, cur); } catch (e) { console.error(e); dirty = true; }
  saving = false; emit('status');
}
window.addEventListener('pagehide', () => { if (dirty) saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) saveNow(); });

/** Change the open project. fn mutates the project; `quiet` skips re-render. */
export function change(fn, { quiet = false } = {}) {
  if (!cur) return;
  const r = fn(cur); cur.updated = Date.now(); dirty = true; saveSoon();
  if (!quiet) emit('change');
  emit('status');
  return r;
}

/* ---------- listing ---------- */
export async function listProjects() {
  const ps = (await db.all('projects')).map(migrate);
  return ps.map((p) => {
    const c = counts(p); const kits = p.kits.map((k) => ({ name: k.name, ...kitStatus(p, k, c) }));
    return { id: p.id, name: p.name, kind: p.kind, updated: p.updated, created: p.created, builtin: p.builtin || null, builtinVersion: p.builtinVersion || null,
      parts: p.parts.length, pieces: total(c), photos: p.photos.length, kits, color: p.color,
      thumbs: sortedParts(p).filter((t) => t.thumb).slice(0, 4).map((t) => ({ path: t.thumb, code: t.code || t.name.slice(0, 3) })),
      codes: sortedParts(p).slice(0, 4).map((t) => t.code || t.name.slice(0, 3)) };
  }).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}
export async function thumbUrlFor(pid, path) {
  const b = await db.get('files', pid + '/' + path); return b ? URL.createObjectURL(b) : null;
}

/* ---------- open / create / delete ---------- */
export async function openProject(id) {
  if (cur && cur.id === id) return cur;
  if (dirty) await saveNow();
  const p = await db.get('projects', id); if (!p) return null;
  for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear();
  cur = migrate(p); emit('open'); return cur;
}
export function closeProject() { cur = null; for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear(); }
export async function createProject(opts) {
  const p = newProject(opts); await db.put('projects', p.id, p); return p;
}
export async function deleteProject(id) {
  if (cur && cur.id === id) closeProject();
  await db.del('projects', id); await db.delPrefix('files', id + '/'); await db.del('meta', 'file:' + id);
}
export async function renameProject(id, name) {
  if (cur && cur.id === id) { change((p) => { p.name = name; }); await saveNow(); return; }
  const p = await db.get('projects', id); if (!p) return; p.name = name; p.updated = Date.now(); await db.put('projects', id, p);
}
export async function duplicateProject(id, name) {
  const p = migrate(await db.get('projects', id)); const q = clone(p);
  q.id = uid('p_'); q.name = name || p.name + ' (copy)'; q.created = q.updated = Date.now(); delete q.builtin; delete q.builtinVersion;
  const ks = await db.keys('files', id + '/');
  for (const k of ks) { const b = await db.get('files', k); await db.put('files', q.id + k.slice(id.length), b); }
  await db.put('projects', q.id, q); return q;
}

/* ---------- files of the open project ---------- */
export async function fileBlob(path, pid) { if (!path) return null; return db.get('files', (pid || cur.id) + '/' + path); }
export async function putFile(path, blob) { await db.put('files', cur.id + '/' + path, blob); const u = urls.get(path); if (u) { URL.revokeObjectURL(u); urls.delete(path); } }
export async function delFile(path) { await db.del('files', cur.id + '/' + path); const u = urls.get(path); if (u) { URL.revokeObjectURL(u); urls.delete(path); } }
export async function fileUrl(path) {
  if (!path || !cur) return null; if (urls.has(path)) return urls.get(path);
  const b = await fileBlob(path); if (!b) return null; const u = URL.createObjectURL(b); urls.set(path, u); return u;
}
export const cachedUrl = (path) => urls.get(path) || null;
/** Load object URLs for many paths, then call back (for images rendered from HTML strings). */
export async function warmUrls(paths) { await Promise.all(paths.filter(Boolean).map((p) => fileUrl(p))); }

/* ---------- .star export / import ---------- */
export async function exportStar(id, onProgress) {
  const p = cur && cur.id === id ? cur : migrate(await db.get('projects', id));
  if (cur && cur.id === id && dirty) await saveNow();
  return packStar(p, (path) => db.get('files', p.id + '/' + path), onProgress);
}
export async function fileInfo(id) { return (await db.get('meta', 'file:' + id)) || null; }
async function setFileInfo(id, info) { await db.put('meta', 'file:' + id, info); emit('status'); }
export function needsFileSave(p, info) { return !info || !info.savedAt || (p.updated || 0) > info.savedAt + 500; }

/** Save the project as a .star file. Uses the same file again when this browser can (Chrome, Edge). */
export async function saveStar(id, { as = false } = {}) {
  const p = cur && cur.id === id ? cur : migrate(await db.get('projects', id));
  const info = (await fileInfo(id)) || {};
  const blob = await exportStar(id);
  if (canSaveInPlace()) {
    let h = !as && info.handle ? info.handle : null;
    try {
      if (!h) h = await pickSaveHandle(info.name || starName(p));
      await writeHandle(h, blob);
      await setFileInfo(id, { name: h.name, handle: h, savedAt: Date.now() });
      return { name: h.name, inPlace: true };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      console.warn('save in place failed, downloading instead', e);
    }
  }
  const name = starName(p); saveBlob(name, blob);
  await setFileInfo(id, { name, savedAt: Date.now() });
  return { name, inPlace: false };
}

/** Read a .star file. Returns {project, files, existing} without saving. */
export async function readStar(blob) {
  const { project, files } = await unpackStar(blob); migrate(project);
  const existing = project.id ? await db.get('projects', project.id) : null;
  return { project, files, existing: existing ? migrate(existing) : null };
}
/** Store an unpacked .star. mode: 'replace' keeps the id, 'copy' gives it a new id. */
export async function storeStar({ project, files }, { mode = 'replace', handle = null, fileName = null, builtin = null } = {}) {
  const p = project;
  if (mode === 'copy' || !p.id) { p.id = uid('p_'); if (mode === 'copy') { delete p.builtin; delete p.builtinVersion; p.name = `${p.name} (copy)`; } }
  if (builtin) { p.builtin = builtin.id; p.builtinVersion = builtin.version; }
  if (cur && cur.id === p.id) closeProject();
  await db.delPrefix('files', p.id + '/');
  const entries = [];
  for (const [path, b] of files) entries.push([p.id + '/' + path, b.type ? b : new Blob([b], { type: mimeOf(path) })]);
  if (entries.length) await db.putMany('files', entries);
  p.updated = p.updated || Date.now();
  await db.put('projects', p.id, p);
  if (handle || fileName) await setFileInfo(p.id, { name: fileName || (handle && handle.name), handle: handle || null, savedAt: Date.now() });
  else await db.del('meta', 'file:' + p.id);
  return p;
}

/* ---------- built-in projects shipped with the site ---------- */
export async function builtinList() {
  try { const r = await fetch('projects/index.json', { cache: 'no-cache' }); if (!r.ok) return []; const j = await r.json(); return Array.isArray(j.projects) ? j.projects : []; }
  catch (e) { return []; }
}
export async function installBuiltin(entry, { replace = false } = {}) {
  const have = await db.get('projects', entry.id);
  if (have && !replace) return null;
  const r = await fetch(entry.file, { cache: 'no-cache' }); if (!r.ok) throw new Error('Couldn’t download the built-in project.');
  const un = await unpackStar(await r.blob()); migrate(un.project); un.project.id = entry.id;
  return storeStar(un, { mode: 'replace', builtin: entry });
}
/** Install built-in projects that this browser doesn't have yet. Returns entries with update flags. */
export async function syncBuiltins() {
  const list = await builtinList(); const out = [];
  for (const e of list) {
    const have = await db.get('projects', e.id); const skipped = await db.get('meta', 'skip-builtin:' + e.id);
    if (!have && !skipped) { try { await installBuiltin(e); } catch (err) { console.warn(err); } }
    out.push(Object.assign({}, e, { update: !!(have && have.builtinVersion && have.builtinVersion < e.version) }));
  }
  return out;
}
export async function forgetBuiltin(id) { await db.put('meta', 'skip-builtin:' + id, true); }
export async function unforgetBuiltin(id) { await db.del('meta', 'skip-builtin:' + id); }
export { filePaths };
