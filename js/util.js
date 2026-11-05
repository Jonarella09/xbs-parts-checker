// Small shared helpers: DOM, text, ids, toast, modals, downloads, script loading.
export const APP = { name: 'The Indexer', version: '2.1', codename: 'Polaris' };

export const $ = (id) => document.getElementById(id);
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const plural = (n, w, ws) => (n === 1 ? w : ws || w + 's');
export const pn = (n, w, ws) => `${fmtN(n)} ${plural(n, w, ws)}`;
export const fmtN = (n) => (Math.round(n) === n ? n.toLocaleString() : (+n).toFixed(1));
export const pad2 = (n) => String(n).padStart(2, '0');
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const slugify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/×/g, 'x').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
export function uid(prefix = '') {
  const a = new Uint8Array(8); crypto.getRandomValues(a);
  return prefix + Date.now().toString(36).slice(-5) + Array.from(a, (b) => (b % 36).toString(36)).join('').slice(0, 7);
}
export const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
export function when(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date(), s = (now - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (d.toDateString() === now.toDateString()) return 'today ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'yesterday ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
export const fullDate = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const fmtBytes = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
export const mm = (v) => (v == null || !isFinite(v) ? '–' : v >= 100 ? Math.round(v) + ' mm' : (Math.round(v * 10) / 10) + ' mm');

/* ---------- toast ---------- */
let toastT;
export function toast(msg, action) {
  const el = $('toast'); if (!el) return;
  el.innerHTML = `<span>${msg}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : '');
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), action ? 7000 : 3600);
}

/* ---------- modals ---------- */
const stack = [];
function topKey(e) {
  const top = stack[stack.length - 1]; if (!top) return;
  if (e.key === 'Escape' && !top.locked) { e.preventDefault(); e.stopPropagation(); closeModal(); }
}
document.addEventListener('keydown', topKey, true);
export function openModal({ title, body = '', foot = '', cls = '', onClose, locked = false, label }) {
  const root = $('modalRoot'); const wrap = document.createElement('div');
  wrap.className = 'modal-bg';
  wrap.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(label || title || 'Dialog')}">
    ${title != null ? `<header><h2>${title}</h2><button type="button" class="btn ghost small x" data-close>Close</button></header>` : ''}
    <div class="mbody">${body}</div>${foot ? `<footer>${foot}</footer>` : ''}</div>`;
  root.appendChild(wrap);
  const m = { el: wrap.firstElementChild, wrap, onClose, locked };
  stack.push(m);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap && !m.locked) closeModal(); });
  wrap.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => closeModal()));
  const f = wrap.querySelector('[autofocus]') || wrap.querySelector('input,select,textarea,button:not([data-close])');
  setTimeout(() => f && f.focus(), 30);
  return m;
}
export function closeModal(m) {
  const i = m ? stack.indexOf(m) : stack.length - 1; if (i < 0) return;
  const [x] = stack.splice(i, 1); x.wrap.remove(); x.onClose && x.onClose();
}
export const modalOpen = () => stack.length > 0;
export function confirmBox({ title, text, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((res) => {
    let done = false;
    const m = openModal({ title, body: `<p>${text}</p>`, foot: `<button type="button" class="btn" data-c>${esc(cancel)}</button><button type="button" class="btn ${danger ? 'danger solid' : 'primary'}" data-ok>${esc(ok)}</button>`, onClose: () => { if (!done) res(false); } });
    m.el.querySelector('[data-c]').onclick = () => { done = true; res(false); closeModal(m); };
    m.el.querySelector('[data-ok]').onclick = () => { done = true; res(true); closeModal(m); };
    setTimeout(() => m.el.querySelector('[data-ok]').focus(), 40);
  });
}
export function choiceBox({ title, text, options }) {
  return new Promise((res) => {
    let done = false;
    const m = openModal({ title, body: `${text ? `<p>${text}</p>` : ''}<div class="choice">${options.map((o, i) => `<button type="button" data-i="${i}"><span class="ic">${esc(o.icon || i + 1)}</span><b>${esc(o.label)}</b><span class="d">${esc(o.desc || '')}</span></button>`).join('')}</div>`, onClose: () => { if (!done) res(null); } });
    m.el.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => { done = true; res(options[+b.dataset.i].value); closeModal(m); }));
  });
}
export function promptBox({ title, label, value = '', ok = 'Save', placeholder = '' }) {
  return new Promise((res) => {
    let done = false;
    const m = openModal({ title, body: `<label class="field"><span>${esc(label)}</span><input type="text" id="pbx" value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus></label>`, foot: `<button type="button" class="btn" data-c>Cancel</button><button type="button" class="btn primary" data-ok>${esc(ok)}</button>`, onClose: () => { if (!done) res(null); } });
    const inp = m.el.querySelector('#pbx'); setTimeout(() => { inp.focus(); inp.select(); }, 40);
    const go = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } done = true; res(v); closeModal(m); };
    m.el.querySelector('[data-ok]').onclick = go; inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    m.el.querySelector('[data-c]').onclick = () => { done = true; res(null); closeModal(m); };
  });
}

/* ---------- drawer ---------- */
let drawerEl = null;
export function openDrawer(html, onClose) {
  closeDrawer();
  const bg = document.createElement('div'); bg.className = 'drawer-bg';
  const d = document.createElement('aside'); d.className = 'drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
  d.innerHTML = html; document.body.append(bg, d);
  drawerEl = { d, bg, onClose };
  bg.onclick = () => closeDrawer();
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => closeDrawer()));
  return d;
}
export function closeDrawer() { if (!drawerEl) return; const x = drawerEl; drawerEl = null; x.d.remove(); x.bg.remove(); x.onClose && x.onClose(); }
export const drawerOpen = () => !!drawerEl;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerEl && !stack.length) { e.preventDefault(); closeDrawer(); } });

/* ---------- scripts & files ---------- */
const scripts = {};
export function loadScript(src) {
  return scripts[src] || (scripts[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = () => { delete scripts[src]; rej(new Error('Could not load ' + src)); }; document.head.appendChild(s); }));
}
export async function jszip() {
  if (window.JSZip) return window.JSZip;
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  return window.JSZip;
}
export function saveBlob(name, blob) {
  const u = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
export function pickFiles({ accept = '', multiple = false, capture } = {}) {
  return new Promise((res) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = multiple;
    if (capture) i.setAttribute('capture', capture);
    i.onchange = () => res(Array.from(i.files || [])); i.click();
  });
}
export async function busy(btn, fn) {
  if (btn && btn.disabled) return; const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="boot-star" style="width:14px;height:14px"></span> Working…'; }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}
export const mimeOf = (path) => { const e = String(path).split('.').pop().toLowerCase(); return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', stl: 'model/stl', json: 'application/json', txt: 'text/plain', '3mf': 'model/3mf' }[e] || 'application/octet-stream'; };
export const PALETTE = ['#2563eb', '#16a34a', '#dc2626', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#be123c', '#a16207', '#9333ea', '#0284c7', '#475569'];
export function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff';
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#111' : '#fff';
}
