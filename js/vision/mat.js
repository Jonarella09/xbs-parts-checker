// The printable counting mat: four ArUco markers at known positions give an exact mm scale and straighten the photo.
import { loadScript, openModal, esc } from '../util.js';

const PAGES = [
  { id: 'letter', name: 'Letter (8.5 × 11 in)', W: 215.9, H: 279.4, ids: [0, 1, 2, 3], s: 22 },
  { id: 'a4', name: 'A4', W: 210, H: 297, ids: [4, 5, 6, 7], s: 22 },
  { id: 'tabloid', name: 'Tabloid (11 × 17 in)', W: 279.4, H: 431.8, ids: [8, 9, 10, 11], s: 28 },
  { id: 'a3', name: 'A3', W: 297, H: 420, ids: [12, 13, 14, 15], s: 28 },
];
const M = 12; // page margin in mm
export const LAYOUTS = PAGES.map((p) => {
  const off = M + (p.s * 1.25) / 2;
  return { id: p.id, name: p.name, ids: p.ids, marker: p.s, page: [p.W, p.H],
    centers: [[off, off], [p.W - off, off], [p.W - off, p.H - off], [off, p.H - off]],
    area: [M, M, +(p.W - M).toFixed(2), +(p.H - M).toFixed(2)], cornerZone: p.s * 1.25 + 5 };
});

async function aruco() { await loadScript('lib/aruco/cv.js'); await loadScript('lib/aruco/aruco.js'); return window.AR; }

export async function matSVG(id) {
  const AR = await aruco(); const L = LAYOUTS.find((x) => x.id === id); const [W, H] = L.page; const dict = new AR.Dictionary('ARUCO_MIP_36h12');
  const u = L.marker / 8;
  const marks = L.ids.map((mid, k) => { const [cx, cy] = L.centers[k]; const inner = dict.generateSVG(mid).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    return `<svg x="${cx - 5 * u}" y="${cy - 5 * u}" width="${10 * u}" height="${10 * u}" viewBox="0 0 10 10" shape-rendering="crispEdges">${inner}</svg>`; }).join('');
  const [ax0, ay0, ax1, ay1] = L.area;
  const tick = (x, y, dx, dy) => `<path d="M${x} ${y + dy * 6}V${y}H${x + dx * 6}" fill="none" stroke="#c9ced6" stroke-width="0.35"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="Helvetica,Arial,sans-serif">
    <rect width="${W}" height="${H}" fill="#fff"/>${marks}
    ${tick(ax0 + L.cornerZone, ay0 - 1.5, 1, 1)}${tick(ax1 - L.cornerZone, ay0 - 1.5, -1, 1)}
    <text x="${W / 2}" y="${M - 4}" text-anchor="middle" font-size="3.4" fill="#5a6878">The Indexer counting mat · ${esc(L.name)} · print at 100% (actual size)</text>
    <text x="${W / 2}" y="${H - M + 7.5}" text-anchor="middle" font-size="2.8" fill="#8a96a5">Keep all four corner squares in the photo and uncovered. Pieces go anywhere between them.</text>
    <g transform="translate(${W / 2 - 25} ${H - M + 2})"><path d="M0 0H50M0 -1.2V1.2M10 -.7V.7M20 -.7V.7M30 -.7V.7M40 -.7V.7M50 -1.2V1.2" stroke="#8a96a5" stroke-width="0.3" fill="none"/><text x="52" y="1" font-size="2.4" fill="#8a96a5">50 mm: measure to check the print</text></g>
  </svg>`;
}

export async function openMatDialog() {
  let cur = 'letter';
  const m = openModal({ title: 'Counting mat', cls: 'wide', body: `
    <p>Print this sheet and lay your pieces on it. The four corner squares tell the counter exactly how big everything is (so it can tell an 8 mm screw from a 10 mm one) and straighten photos taken at an angle.</p>
    <div class="row"><span class="flabel">Paper</span><div class="seg" id="matSz">${LAYOUTS.map((l) => `<button type="button" data-sz="${l.id}" aria-pressed="${l.id === cur}">${esc(l.name)}</button>`).join('')}</div></div>
    <div class="matprev" id="matPrev"></div>
    <div class="steps3"><div class="s"><i>PRINT</i><b>At 100% size</b><span class="small muted">Turn off “fit to page”. Check the 50 mm line with a ruler.</span></div>
      <div class="s"><i>COLOUR</i><b>Coloured paper helps</b><span class="small muted">Shiny metal parts stand out best on a coloured sheet (light blue or green). White works for most plastic parts.</span></div>
      <div class="s"><i>PHOTO</i><b>From above, even light</b><span class="small muted">All four squares in the shot, no strong shadows, pieces not touching if you can.</span></div></div>`,
    foot: `<button type="button" class="btn" id="matDl">Download SVG</button><button type="button" class="btn primary" id="matPrint">Print the mat</button>` });
  const draw = async () => { m.el.querySelector('#matPrev').innerHTML = await matSVG(cur); m.el.querySelectorAll('[data-sz]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.sz === cur)); };
  m.el.querySelectorAll('[data-sz]').forEach((b) => (b.onclick = () => { cur = b.dataset.sz; draw(); }));
  m.el.querySelector('#matPrint').onclick = async () => {
    const L = LAYOUTS.find((x) => x.id === cur); const svg = await matSVG(cur);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Counting mat · ${esc(L.name)}</title><style>@page{size:${L.page[0]}mm ${L.page[1]}mm;margin:0}html,body{margin:0}svg{display:block}</style></head><body>${svg}<script>window.onload=()=>setTimeout(()=>print(),300)<\/script></body></html>`;
    const w = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank'); if (!w) alertPop();
  };
  m.el.querySelector('#matDl').onclick = async () => { const svg = await matSVG(cur); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); a.download = `counting-mat-${cur}.svg`; a.click(); };
  draw();
}
function alertPop() { import('../util.js').then((u) => u.toast('Your browser blocked the print window. Use “Download SVG” and print that file at 100%.')); }
