// Project data model: parts, kits, counts, photos, history. Pure functions over the project object.
import { uid, PALETTE } from './util.js';

export const SCHEMA = 2;
export const KINDS = {
  kits: { label: 'Kits', short: 'Kits', desc: 'Pieces that make up something. Define a kit once, then see how many complete kits you have and what’s missing.' },
  count: { label: 'Just counting', short: 'Counting', desc: 'Index and count stuff: screws, field elements, balls, anything. You can still add a kit later.' },
};

export function newProject({ name, kind = 'count', id }) {
  const t = Date.now();
  return {
    format: 'indexer-project', schema: SCHEMA, id: id || uid('p_'), name: name || 'Untitled project', kind,
    created: t, updated: t, color: PALETTE[Math.floor(Math.random() * 8)],
    parts: [], cats: [], kits: [], adjust: {}, photos: [], print: {}, plan: {}, printKit: null,
    vision: { examples: {}, settings: {} }, log: [], notes: '',
  };
}

export function migrate(p) {
  p.schema = p.schema || SCHEMA;
  for (const k of ['parts', 'cats', 'kits', 'photos', 'log']) if (!Array.isArray(p[k])) p[k] = [];
  for (const k of ['adjust', 'print', 'plan']) if (!p[k] || typeof p[k] !== 'object') p[k] = {};
  if (!p.vision) p.vision = { examples: {}, settings: {} };
  p.vision.examples = p.vision.examples || {}; p.vision.settings = p.vision.settings || {};
  p.kind = p.kind || 'count';
  return p;
}

/* ---------- parts ---------- */
export function newPart(p, f = {}) {
  const id = f.id || uid('t_');
  const used = new Set(p.parts.map((x) => x.color));
  const color = f.color || PALETTE.find((c) => !used.has(c)) || PALETTE[p.parts.length % PALETTE.length];
  return Object.assign({ id, code: '', name: 'New part', cat: '', color, partNo: '', barcode: '', perPack: null, dims: {}, weight: null, notes: '', model: null, thumb: null, created: Date.now() }, f, { id, color });
}
export const partById = (p, id) => p.parts.find((x) => x.id === id);
export const partLabel = (t) => (t ? t.code || t.name : 'Unknown');
export function catOrder(p) {
  const seen = []; for (const c of p.cats || []) if (!seen.includes(c)) seen.push(c);
  for (const t of p.parts) { const c = t.cat || ''; if (!seen.includes(c)) seen.push(c); }
  return seen;
}
export function sortedParts(p) {
  const order = catOrder(p);
  return p.parts.map((t, i) => ({ t, i })).sort((a, b) => order.indexOf(a.t.cat || '') - order.indexOf(b.t.cat || '') || a.i - b.i).map((x) => x.t);
}
export const printable = (p) => p.parts.filter((t) => t.model && t.model.file);

/* ---------- counts ---------- */
export function tally(photo) {
  const o = {};
  for (const it of photo.items || []) { if (it.st === 'gone' || !it.part) continue; o[it.part] = (o[it.part] || 0) + Math.max(1, Math.round(it.n || 1)); }
  return o;
}
export const isCounted = (ph) => ph.status === 'added';
export function photoCounts(p) {
  const o = {};
  for (const ph of p.photos) if (isCounted(ph)) { const t = tally(ph); for (const k in t) o[k] = (o[k] || 0) + t[k]; }
  return o;
}
export function counts(p) {
  const o = {}; const pc = photoCounts(p);
  for (const t of p.parts) o[t.id] = Math.max(0, (pc[t.id] || 0) + (+p.adjust[t.id] || 0));
  return o;
}
export const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
export function setCount(p, id, n) {
  const pc = photoCounts(p)[id] || 0; const v = Math.max(0, Math.round(+n || 0));
  const old = Math.max(0, pc + (+p.adjust[id] || 0));
  p.adjust[id] = v - pc; if (p.adjust[id] === 0) delete p.adjust[id];
  return v - old;
}

/* ---------- kits ---------- */
export function newKit(p, f = {}) { return Object.assign({ id: uid('k_'), name: 'New kit', need: {}, notes: '' }, f); }
export const kitById = (p, id) => p.kits.find((k) => k.id === id);
export const kitParts = (p, k) => sortedParts(p).filter((t) => (k.need[t.id] || 0) > 0);
export const kitPieces = (k) => Object.values(k.need).reduce((a, b) => a + (+b || 0), 0);
export function kitStatus(p, k, c = counts(p)) {
  const ids = Object.keys(k.need).filter((id) => k.need[id] > 0 && partById(p, id));
  if (!ids.length) return { complete: 0, limiting: [], next: {}, nextN: 0, ids, ready: false };
  const per = ids.map((id) => Math.floor((c[id] || 0) / k.need[id]));
  const complete = Math.min(...per);
  const limiting = ids.filter((id, i) => per[i] === complete);
  const next = shortFor(p, k, complete + 1, c);
  return { complete, limiting, next, nextN: Object.values(next).reduce((a, b) => a + b, 0), ids, ready: true };
}
export function shortFor(p, k, n, c = counts(p)) {
  const o = {};
  for (const id in k.need) { if (!partById(p, id)) continue; const q = Math.max(0, n * (k.need[id] || 0) - (c[id] || 0)); if (q) o[id] = q; }
  return o;
}

/* ---------- photos ---------- */
export const photoById = (p, id) => p.photos.find((x) => x.id === id);
export function photoSummary(ph) {
  const items = (ph.items || []).filter((it) => it.st !== 'gone');
  const pieces = items.reduce((a, it) => a + (it.part ? Math.max(1, Math.round(it.n || 1)) : 0), 0);
  const unknown = items.filter((it) => !it.part).length;
  const check = items.filter((it) => it.part && it.st === 'check').length;
  return { pieces, unknown, check, objects: items.length };
}

/* ---------- history ---------- */
export function logEvent(p, kind, text, d) {
  const e = { t: Date.now(), kind, text };
  if (d && Object.keys(d).length) e.d = d;
  p.log.unshift(e); if (p.log.length > 600) p.log.length = 600;
}
export function diff(a, b) { const o = {}; const ks = new Set([...Object.keys(a), ...Object.keys(b)]); for (const k of ks) { const v = (b[k] || 0) - (a[k] || 0); if (v) o[k] = v; } return o; }

/* ---------- reset ---------- */
export function resetInventory(p, why) {
  const before = counts(p); const at = Date.now();
  for (const ph of p.photos) if (ph.status !== 'archived') { ph.status = 'archived'; ph.archivedAt = at; ph.archivedWhy = why || 'Inventory reset'; }
  p.adjust = {};
  logEvent(p, 'reset', why || 'Inventory reset to zero', diff(before, counts(p)));
}
