// 3D models: read STL files, measure them, render thumbnails and an interactive 3D view.
import { esc, openModal } from './util.js';

export const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
let threeP = null;
export const three = () => threeP || (threeP = import(THREE_URL));

/** Parse a binary or ASCII STL. Returns {pos: Float32Array of triangle vertices (9 per triangle), n}. */
export function parseSTL(buf) {
  const u8 = new Uint8Array(buf); const dv = new DataView(buf);
  if (u8.length >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === u8.length && n > 0) {
      const pos = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let j = 0; j < 9; j++) pos[i * 9 + j] = dv.getFloat32(o + j * 4, true); }
      return { pos, n };
    }
  }
  const txt = new TextDecoder().decode(u8); const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g; const v = []; let m;
  while ((m = re.exec(txt))) v.push(+m[1], +m[2], +m[3]);
  if (!v.length || v.length % 9) throw new Error('This doesn’t look like an STL file.');
  return { pos: Float32Array.from(v), n: v.length / 9 };
}

/** Size, volume and the flattest way to lay the part on a print bed. */
export function analyze({ pos, n }) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { const v = pos[i + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  let vol = 0, area = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 9; const ax = pos[o], ay = pos[o + 1], az = pos[o + 2], bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5], cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  const size = [0, 1, 2].map((a) => +(mx[a] - mn[a]).toFixed(2));
  const axi = size.indexOf(Math.min(...size)); const other = [0, 1, 2].filter((a) => a !== axi).map((a) => size[a]);
  const flat = { ax: 'xyz'[axi], fx: Math.max(...other), fy: Math.min(...other), fz: size[axi], vol: +(Math.abs(vol) / 1000).toFixed(3) };
  const dims = [...size].sort((a, b) => b - a);
  return { size, tri: n, vol: flat.vol, area: +(area / 100).toFixed(2), flat, dims: { l: dims[0], w: dims[1], h: dims[2] } };
}

/** Triangles rotated to lie flat (the longest side along X), centred, bottom at z=0. Used by the 3MF writer. */
export function flatPositions({ pos }, flat) {
  const out = new Float32Array(pos.length); const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]; let X = x, Y = y, Z = z;
    if (flat.ax === 'y') { X = x; Y = -z; Z = y; } else if (flat.ax === 'x') { X = z; Y = y; Z = -x; }
    out[i] = X; out[i + 1] = Y; out[i + 2] = Z;
    if (X < mn[0]) mn[0] = X; if (Y < mn[1]) mn[1] = Y; if (Z < mn[2]) mn[2] = Z; if (X > mx[0]) mx[0] = X; if (Y > mx[1]) mx[1] = Y; if (Z > mx[2]) mx[2] = Z;
  }
  const swap = mx[1] - mn[1] > mx[0] - mn[0]; const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2;
  for (let i = 0; i < out.length; i += 3) { let X = out[i] - cx, Y = out[i + 1] - cy; if (swap) { const t = X; X = -Y; Y = t; } out[i] = X; out[i + 1] = Y; out[i + 2] -= mn[2]; }
  return out;
}

/* ---------- rendering ---------- */
let R = null;
async function renderer(w, h) {
  const T = await three();
  if (!R) { R = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); R.setPixelRatio(1); }
  R.setSize(w, h, false); return { T, R };
}
function buildScene(T, geo, color) {
  const scene = new T.Scene();
  scene.add(new T.HemisphereLight(0xffffff, 0x445566, 1.1));
  const d1 = new T.DirectionalLight(0xffffff, 1.6); d1.position.set(1, 1.6, 2.2); scene.add(d1);
  const d2 = new T.DirectionalLight(0xffffff, 0.5); d2.position.set(-2, -1, 1); scene.add(d2);
  const mat = new T.MeshStandardMaterial({ color: new T.Color(color || '#8a9bb0'), roughness: 0.55, metalness: 0.08, flatShading: false });
  const mesh = new T.Mesh(geo, mat); scene.add(mesh); return { scene, mesh };
}
function geometryOf(T, pos) {
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.computeVertexNormals(); g.computeBoundingSphere(); g.center(); return g;
}
/** Render a part thumbnail (isometric view) to a WebP/PNG blob. */
export async function thumbnail(stl, color, size = 256) {
  const { T, R } = await renderer(size, size);
  const geo = geometryOf(T, stl.pos.slice()); const { scene, mesh } = buildScene(T, geo, color);
  const flat = analyze(stl).flat; // lay it flat first so thumbnails look like the piece on a table
  if (flat.ax === 'y') mesh.rotation.x = -Math.PI / 2; else if (flat.ax === 'x') mesh.rotation.y = Math.PI / 2;
  const box = new T.Box3().setFromObject(mesh); const c = box.getCenter(new T.Vector3()); mesh.position.sub(c);
  const r = box.getSize(new T.Vector3()).length() / 2 || 1;
  const cam = new T.PerspectiveCamera(30, 1, r / 50, r * 50);
  cam.position.set(r * 1.55, -r * 2.35, r * 2.0); cam.up.set(0, 0, 1); cam.lookAt(0, 0, 0);
  R.setClearColor(0x000000, 0); R.render(scene, cam);
  const blob = await new Promise((res) => R.domElement.toBlob((b) => res(b), 'image/webp', 0.9));
  geo.dispose();
  if (blob && blob.type === 'image/webp') return blob;
  return new Promise((res) => R.domElement.toBlob(res, 'image/png'));
}

/** Open a 3D viewer the user can rotate (drag) and zoom (wheel / pinch). */
export async function view3D({ title, stl, color, info = '' }) {
  const m = openModal({ title: esc(title), cls: 'wide', body: `<div class="v3d" id="v3d" aria-label="3D view, drag to turn"></div><div class="small muted">Drag to turn it, scroll or pinch to zoom.${info ? ' ' + info : ''}</div>`, onClose: () => { stop = true; ro.disconnect(); } });
  const host = m.el.querySelector('#v3d'); let stop = false;
  const T = await three(); const r = new T.WebGLRenderer({ antialias: true, alpha: true }); r.setPixelRatio(Math.min(2, devicePixelRatio || 1)); host.appendChild(r.domElement);
  const geo = geometryOf(T, stl.pos.slice()); const { scene, mesh } = buildScene(T, geo, color);
  const flat = analyze(stl).flat; if (flat.ax === 'y') mesh.rotation.x = -Math.PI / 2; else if (flat.ax === 'x') mesh.rotation.y = Math.PI / 2;
  const grp = new T.Group(); scene.remove(mesh); grp.add(mesh); scene.add(grp);
  const box = new T.Box3().setFromObject(grp); grp.position.sub(box.getCenter(new T.Vector3()));
  const rad = box.getSize(new T.Vector3()).length() / 2 || 1; let dist = rad * 3.2, rx = -0.9, rz = 0.6;
  const cam = new T.PerspectiveCamera(32, 1, rad / 50, rad * 80); cam.up.set(0, 0, 1);
  const size = () => { const w = host.clientWidth, h = host.clientHeight; r.setSize(w, h, false); r.domElement.style.width = '100%'; r.domElement.style.height = '100%'; cam.aspect = w / h; cam.updateProjectionMatrix(); };
  const ro = new ResizeObserver(size); ro.observe(host); size();
  const draw = () => { if (stop) return; cam.position.set(dist * Math.sin(rz) * Math.cos(rx), -dist * Math.cos(rz) * Math.cos(rx), -dist * Math.sin(rx)); cam.lookAt(0, 0, 0); r.render(scene, cam); };
  const pts = new Map(); let pinch = 0;
  host.addEventListener('pointerdown', (e) => { host.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); });
  host.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return; const [x0, y0] = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) dist = Math.max(rad * 1.2, Math.min(rad * 12, dist * pinch / d)); pinch = d; }
    else { rz += (e.clientX - x0) * 0.01; rx = Math.max(-1.55, Math.min(1.55, rx + (e.clientY - y0) * 0.01)); }
    draw();
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; };
  host.addEventListener('pointerup', up); host.addEventListener('pointercancel', up);
  host.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.max(rad * 1.2, Math.min(rad * 12, dist * (1 + Math.sign(e.deltaY) * 0.1))); draw(); }, { passive: false });
  const prevClose = m.onClose; m.onClose = () => { prevClose && prevClose(); r.dispose(); geo.dispose(); };
  const ro2 = new ResizeObserver(() => draw()); ro2.observe(host); draw();
}
