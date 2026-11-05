// The .star project file: a zip with project.json plus the project's models, thumbnails and photos.
import { jszip, mimeOf, APP, slugify, today } from './util.js';

export const STAR_MIME = 'application/x-indexer-star';
export const STAR_TYPES = [{ description: 'Indexer project (.star)', accept: { [STAR_MIME]: ['.star'] } }];

export function filePaths(p) {
  const s = new Set();
  for (const part of p.parts || []) { if (part.model && part.model.file) s.add(part.model.file); if (part.thumb) s.add(part.thumb); }
  for (const ph of p.photos || []) { if (ph.file) s.add(ph.file); if (ph.thumb) s.add(ph.thumb); }
  return [...s];
}
export function starName(p) { return `${slugify(p.name)}.star`; }

export async function packStar(project, getBlob, onProgress) {
  const JSZip = await jszip(); const z = new JSZip();
  z.file('mimetype', STAR_MIME, { compression: 'STORE' });
  z.file('star.json', JSON.stringify({ format: 'indexer-star', version: 1, app: `${APP.name} ${APP.version}`, saved: new Date().toISOString(), name: project.name, id: project.id }, null, 1));
  const clean = Object.assign({}, project); delete clean._rt;
  z.file('project.json', JSON.stringify(clean));
  const paths = filePaths(project); let i = 0;
  for (const path of paths) {
    const b = await getBlob(path); i++;
    if (b) z.file(path, b, { compression: /\.(jpe?g|png|webp)$/i.test(path) ? 'STORE' : 'DEFLATE' });
    onProgress && onProgress(i / paths.length);
  }
  return z.generateAsync({ type: 'blob', mimeType: STAR_MIME, compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function unpackStar(blob) {
  const JSZip = await jszip(); let z;
  try { z = await JSZip.loadAsync(blob); } catch (e) { throw new Error('This file isn’t a .star project (it couldn’t be opened as one).'); }
  const pj = z.file('project.json');
  if (!pj) throw new Error('This file isn’t a .star project: it has no project inside.');
  let project;
  try { project = JSON.parse(await pj.async('string')); } catch (e) { throw new Error('The project inside this .star file is damaged.'); }
  if (!project || !Array.isArray(project.parts)) throw new Error('The project inside this .star file is damaged.');
  const files = new Map();
  for (const name of Object.keys(z.files)) {
    const f = z.files[name]; if (f.dir || ['project.json', 'star.json', 'mimetype'].includes(name)) continue;
    const buf = await f.async('arraybuffer'); files.set(name, new Blob([buf], { type: mimeOf(name) }));
  }
  return { project, files };
}

/* ---- saving to and opening files on this computer ---- */
export const canSaveInPlace = () => typeof window.showSaveFilePicker === 'function';
export async function pickSaveHandle(suggested) {
  return window.showSaveFilePicker({ suggestedName: suggested, types: STAR_TYPES, excludeAcceptAllOption: false });
}
export async function writeHandle(handle, blob) {
  if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('No permission to save to that file.');
  }
  const w = await handle.createWritable(); await w.write(blob); await w.close();
}
export async function pickOpenStar() {
  if (typeof window.showOpenFilePicker === 'function') {
    try { const [h] = await window.showOpenFilePicker({ types: STAR_TYPES, multiple: false }); return { file: await h.getFile(), handle: h }; }
    catch (e) { if (e && e.name === 'AbortError') return null; }
  }
  return new Promise((res) => {
    const i = document.getElementById('starIn'); i.value = '';
    i.onchange = () => res(i.files && i.files[0] ? { file: i.files[0], handle: null } : null); i.click();
  });
}
export const backupName = (p) => `${slugify(p.name)}_${today()}.star`;
