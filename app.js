/* Booklet editor: cover + chapter postcards, rendered on canvas from a private asset pack.
   The pack (booklet-pack.zip) is loaded on the device and kept in IndexedDB; nothing is uploaded. */
'use strict';

const STATE_KEY = 'booklet-state-v1';
const FONT = 'BookletType';
const INK = [28, 25, 22];

const $ = (s) => document.querySelector(s);
let PACK = null;          // {manifest, img: {paper, scan, torn, photos:{}, stamps:{}, stickers:{}}}
let W = 2126, H = 1535, PX_PER_MM = W / 180;
let S = null;             // editable state
let current = 'cover';
let selected = null;      // selected sticker key on the cover

/* ------------------------------------------------------------------ utils */

function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) {     // mulberry32
  let a = seed >>> 0;
  const r = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  r.normal = (m = 0, sd = 1) => { const u = 1 - r(), v = r(); return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  r.uniform = (a0, b0) => a0 + (b0 - a0) * r();
  return r;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* Right-to-left paragraph -> characters in left-to-right drawing order.
   Hebrew runs are reversed; digit/Latin runs (e.g. "1–6", "2026") keep their order. */
function visualOrder(text) {
  const t = text.replace(/‎|‏/g, '');
  const heb = (c) => c >= '֐' && c <= '׿';
  const runs = []; let cur = '', kind = null;
  for (const c of t) {
    const k = heb(c) ? 'h' : (c === ' ' ? 's' : 'l');
    if (kind === null || k === kind) cur += c; else { runs.push([kind, cur]); cur = c; }
    kind = k;
  }
  runs.push([kind, cur]);
  let out = '';
  for (const [k, r] of runs.reverse()) out += k === 'h' ? [...r].reverse().join('') : r;
  return out;
}
const isRTL = (t) => /[֐-׿]/.test(t);

/* ------------------------------------------------------------------ storage */

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('booklet-editor', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => {
  const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => {
  const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }

function saveState() { try { localStorage.setItem(STATE_KEY, JSON.stringify(S)); } catch (e) { /* storage may be unavailable */ } }
function loadState() { try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { return null; } }

/* ------------------------------------------------------------------ pack */

async function openPack(buf) {
  const zip = await JSZip.loadAsync(buf);
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  const bmp = async (name) => createImageBitmap(await zip.file(name).async('blob'));
  const img = { photos: {}, stamps: {}, stickers: {} };
  const status = $('#loader-status');
  [img.paper, img.scan, img.torn] = await Promise.all([bmp('paper.jpg'), bmp('scan.jpg'), bmp('torn.png')]);
  let n = 0;
  await Promise.all(manifest.pages.map(async (p) => {
    [img.photos[p.key], img.stamps[p.key], img.stickers[p.key]] = await Promise.all([
      bmp(`photos/${p.key}.jpg`), bmp(`stamps/${p.key}.webp`), bmp(`stickers/${p.key}.webp`)]);
    if (status) status.textContent = `נטענו ${++n} מתוך ${manifest.pages.length} מקומות…`;
  }));
  const font = new FontFace(FONT, await zip.file('font.ttf').async('arraybuffer'));
  await font.load(); document.fonts.add(font);
  W = manifest.page.w; H = manifest.page.h; PX_PER_MM = W / manifest.page.w_mm;
  return { manifest, img };
}

/* ------------------------------------------------------------------ state */

function defaultState(m) {
  const pages = {};
  for (const p of m.pages) pages[p.key] = {
    place: p.place, keywords: p.keywords.join(', '), date: p.date,
    photo: { cx: p.photo_center[0], cy: p.photo_center[1], zoom: 1 },
    stamp: { dx: 0, dy: 0, scale: 1 },
  };
  const s = {
    v: 1,
    settings: { marginMM: 0, marginSide: 'none', edge: 'torn', included: Object.fromEntries(m.pages.map((p) => [p.key, true])) },
    cover: { titleLines: m.title_lines.slice(), dates: m.dates, titleY: 0.27, titleSize: 1, stickers: {}, seed: 1 },
    pages,
  };
  autoArrange(s, m);
  return s;
}

function includedPages() { return PACK.manifest.pages.filter((p) => S.settings.included[p.key]); }

/* Cover auto-arrange: a U. The most stickers along the bottom (heaviest in the middle),
   then fewer and fewer as they climb both sides; nothing above or on the title. */
function autoArrange(s = S, m = PACK.manifest) {
  const keys = m.pages.filter((p) => s.settings.included[p.key]).map((p) => p.key);
  const r = rng(1000 + (s.cover.seed || 1));
  // shuffle which sticker goes where
  for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
  // slots in priority order, as fractions of the content area (x) and page (y)
  const slots = [
    [0.50, 0.86], [0.355, 0.875], [0.645, 0.875], [0.215, 0.86], [0.785, 0.86], [0.08, 0.85], [0.92, 0.85],  // bottom: 7
    [0.43, 0.73], [0.57, 0.735],                                                                                // pile rises in the middle: 2
    [0.09, 0.64], [0.91, 0.64],                                                                                 // sides, low: 2
    [0.10, 0.44], [0.90, 0.44],                                                                                 // sides, middle: 2
    [0.09, 0.24], [0.91, 0.24],                                                                                 // sides, high: 2
    [0.25, 0.66], [0.75, 0.66], [0.22, 0.47], [0.78, 0.47],
  ];
  const n = keys.length;
  const size = n <= 9 ? 0.23 : n <= 13 ? 0.215 : 0.2;    // sticker size (square-equivalent) as a share of the page height
  s.cover.stickers = {};
  keys.forEach((k, i) => {
    const [fx, fy] = slots[i % slots.length];
    s.cover.stickers[k] = {
      fx: fx + r.normal(0, 0.012), fy: fy + r.normal(0, 0.012),
      rot: r.normal(0, 6), size: size * r.uniform(0.94, 1.06), z: i, hidden: false,
    };
  });
}

/* ------------------------------------------------------------------ geometry */

function pageIndex(id) { return id === 'cover' ? 0 : 1 + includedPages().findIndex((p) => p.key === id); }
function marginSide(id) {
  const ms = S.settings.marginSide;
  if (ms !== 'alternate') return ms;
  return pageIndex(id) % 2 === 0 ? 'right' : 'left';   // cover/even pages bind on the right, odd on the left
}
function contentRect(id) {
  const m = S.settings.marginSide === 'none' ? 0 : Math.round((S.settings.marginMM || 0) * PX_PER_MM);
  const side = marginSide(id);
  return { x: side === 'left' ? m : 0, w: W - m, m, side };
}

/* ------------------------------------------------------------------ typewriter */

function typedWidth(ctx, text, size) {
  ctx.font = `${size}px ${FONT}`;
  let w = 0; for (const c of text) w += ctx.measureText(c).width + size * 0.06;
  return w;
}
function fitSize(ctx, text, size, maxW) { while (size > 14 && typedWidth(ctx, text, size) > maxW) size -= 2; return size; }

/* Draw one line glyph by glyph: each key strikes a touch higher/lower, a hair bigger/smaller,
   with uneven ink and the odd faint double strike. */
function typeLine(ctx, text, x, y, size, r, { align = 'left', jitter = 1 } = {}) {
  const chars = isRTL(text) ? visualOrder(text) : text;
  const w = typedWidth(ctx, chars, size);
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.textBaseline = 'alphabetic';
  for (const c of chars) {
    const gs = size * (1 + r.normal(0, 0.03 * jitter));
    const dy = r.normal(0, size * 0.035 * jitter) + (size - gs) * 0.8;
    const dx = r.normal(0, size * 0.014 * jitter);
    const a = r.uniform(0.84, 1);
    ctx.font = `${gs.toFixed(1)}px ${FONT}`;
    ctx.fillStyle = `rgba(${INK},${a})`;
    ctx.fillText(c, cx + dx, y + dy);
    if (r() < 0.06) { ctx.fillStyle = `rgba(${INK},${a / 3})`; ctx.fillText(c, cx + dx + 1.2, y + dy); }
    ctx.font = `${size}px ${FONT}`;
    cx += ctx.measureText(c).width + size * 0.06;
  }
  return w;
}

/* ------------------------------------------------------------------ rendering */

function drawPaper(ctx) { ctx.drawImage(PACK.img.paper, 0, 0, W, H); }
function drawScan(ctx, x0, alpha = 1) {
  ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = alpha;
  ctx.drawImage(PACK.img.scan, x0, 0, W - x0, H, x0, 0, W - x0, H);
  ctx.restore();
}

function postcardLayout(ctx, key) {
  const pg = S.pages[key], cr = contentRect(key);
  const split = cr.x + 0.58 * cr.w;
  const paperW = cr.x + cr.w - split;
  const st = PACK.img.stamps[key];
  const sc = Math.min((0.40 * H) / st.height, (0.84 * paperW) / st.width) * pg.stamp.scale;
  const sw = st.width * sc, sh = st.height * sc;
  const num = 1 + includedPages().findIndex((p) => p.key === key);
  const maxW = paperW * 0.86;
  const kw = pg.keywords.split(',').map((t) => t.trim()).filter(Boolean).join(' / ');
  const lines = [
    [pg.place, fitSize(ctx, pg.place, 60, maxW)],
    [null, 46],
    [`No. ${num} · ${pg.date}`, fitSize(ctx, `No. ${num} · ${pg.date}`, 46, maxW)],
    [kw, fitSize(ctx, kw, 46, maxW)],
  ];
  const th = lines.reduce((t, [txt, sz]) => t + (txt === null ? sz * 0.6 : sz * 1.45), 0);
  const gap = 0.04 * H;
  const group = sh + gap + th;
  const top = 0.54 * H - group / 2 + pg.stamp.dy;
  const sx = split + paperW / 2 - sw / 2 + pg.stamp.dx;
  let tx = sx;
  const widest = Math.max(...lines.filter(([t]) => t).map(([t, sz]) => typedWidth(ctx, t, sz)));
  tx = Math.min(tx, cr.x + cr.w - (paperW - maxW) / 2 - widest);
  tx = Math.max(tx, split + (paperW - maxW) / 2);
  return { cr, split, paperW, stamp: { x: sx, y: top, w: sw, h: sh }, text: { x: tx, y: top + sh + gap, lines } };
}

function photoRect(key) {
  const L = postcardLayout(scratchCtx, key);
  const reach = S.settings.edge === 'torn' ? 70 : 0;
  return { x: L.cr.x, y: 0, w: L.split + reach - L.cr.x, h: H, L };
}

function drawPhoto(ctx, key, rect) {
  const img = PACK.img.photos[key], ph = S.pages[key].photo;
  const s = Math.max(rect.w / img.width, rect.h / img.height) * ph.zoom;
  const vw = rect.w / s, vh = rect.h / s;
  const sx = clamp(ph.cx * img.width - vw / 2, 0, img.width - vw);
  const sy = clamp(ph.cy * img.height - vh / 2, 0, img.height - vh);
  ctx.drawImage(img, sx, sy, vw, vh, rect.x, rect.y, rect.w, rect.h);
}

function renderPostcard(ctx, key) {
  const R = photoRect(key), L = R.L;
  drawPaper(ctx);
  drawPhoto(ctx, key, R);
  const torn = S.settings.edge === 'torn';
  if (torn) {
    const t = PACK.img.torn;
    ctx.save();
    ctx.shadowColor = 'rgba(30,22,14,0.30)'; ctx.shadowBlur = 16 * ctx.__v; ctx.shadowOffsetX = -5 * ctx.__v; ctx.shadowOffsetY = 4 * ctx.__v;
    ctx.drawImage(t, L.split - 70, 0, t.width, H);
    ctx.restore();
  }
  // stamp, multiplied into the paper like ink
  ctx.save(); ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(PACK.img.stamps[key], L.stamp.x, L.stamp.y, L.stamp.w, L.stamp.h);
  ctx.restore();
  // caption
  const r = rng(hashStr(key) + 7);
  let y = L.text.y;
  for (const [txt, sz] of L.text.lines) {
    if (txt === null) { y += sz * 0.6; continue; }
    typeLine(ctx, txt, L.text.x, y + sz, sz, r, { jitter: 0.75 });
    y += sz * 1.45;
  }
  drawScan(ctx, torn ? L.split - 70 : L.split);
}

function coverTitleBox(ctx) {
  const cr = contentRect('cover'), c = S.cover;
  const maxW = cr.w * 0.52;
  let size = Math.min(...c.titleLines.filter(Boolean).map((t) => fitSize(ctx, t, 150, maxW)));
  size = Math.round(size * c.titleSize);
  const ds = Math.round(58 * c.titleSize);
  const lh = size * 1.25;
  const h = c.titleLines.length * lh + ds * 1.6;
  const w = Math.max(...c.titleLines.map((t) => typedWidth(ctx, t, size)), typedWidth(ctx, c.dates, ds));
  return { cx: cr.x + cr.w / 2, y: c.titleY * H, size, ds, lh, w, h, cr };
}

function stickerGeom(key) {
  const st = S.cover.stickers[key], im = PACK.img.stickers[key], cr = contentRect('cover');
  // size = side of a square with the same area, so wide and tall stickers weigh the same
  const ar = im.width / im.height, a = st.size * H;
  const w = a * Math.sqrt(ar), h = a / Math.sqrt(ar);
  return { x: cr.x + st.fx * cr.w, y: st.fy * H, w, h, rot: st.rot * Math.PI / 180 };
}

function renderCover(ctx, { editing = false } = {}) {
  drawPaper(ctx);
  const T = coverTitleBox(ctx), c = S.cover;
  const r = rng(hashStr(c.titleLines.join('|') + c.dates));
  let y = T.y;
  for (const t of c.titleLines) { y += T.lh; typeLine(ctx, t, T.cx, y - T.lh * 0.2, T.size, r, { align: 'center' }); }
  typeLine(ctx, c.dates, T.cx, y + T.ds * 1.35, T.ds, r, { align: 'center' });
  drawScan(ctx, 0, 0.9);
  // stickers on top of the typed sheet, in sticking order
  const keys = Object.keys(c.stickers).filter((k) => S.settings.included[k] && !c.stickers[k].hidden)
    .sort((a, b) => c.stickers[a].z - c.stickers[b].z);
  for (const k of keys) {
    const g = stickerGeom(k);
    ctx.save();
    ctx.translate(g.x, g.y); ctx.rotate(g.rot);
    ctx.shadowColor = 'rgba(40,28,16,0.32)'; ctx.shadowBlur = 14 * ctx.__v;
    ctx.shadowOffsetX = 4 * ctx.__v; ctx.shadowOffsetY = 7 * ctx.__v;
    ctx.drawImage(PACK.img.stickers[k], -g.w / 2, -g.h / 2, g.w, g.h);
    if (editing && k === selected) {
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = '#2f6fdf'; ctx.lineWidth = 4; ctx.setLineDash([14, 10]);
      ctx.strokeRect(-g.w / 2 - 6, -g.h / 2 - 6, g.w + 12, g.h + 12);
    }
    ctx.restore();
  }
  if (editing) {   // title keep-clear guide
    ctx.save(); ctx.strokeStyle = 'rgba(138,75,42,.35)'; ctx.setLineDash([10, 10]); ctx.lineWidth = 3;
    ctx.strokeRect(T.cx - T.w / 2 - 20, T.y, T.w + 40, T.h + T.lh * 0.3); ctx.restore();
  }
}

function renderPage(ctx, id, opts = {}) {
  if (id === 'cover') renderCover(ctx, opts); else renderPostcard(ctx, id);
  if (opts.editing) {    // show the binding margin
    const cr = contentRect(id);
    if (cr.m) { ctx.save(); ctx.fillStyle = 'rgba(47,111,223,.08)';
      ctx.fillRect(cr.side === 'left' ? 0 : W - cr.m, 0, cr.m, H); ctx.restore(); }
  }
}

const scratchCtx = document.createElement('canvas').getContext('2d');

/* ------------------------------------------------------------------ stage */

const stage = $('#stage');
let view = 1;
function draw() {
  if (!PACK || $('#app').hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = stage.clientWidth;
  stage.width = Math.round(cw * dpr); stage.height = Math.round(cw * dpr * H / W);
  view = stage.width / W;
  const ctx = stage.getContext('2d');
  ctx.setTransform(view, 0, 0, view, 0, 0); ctx.__v = view;
  ctx.clearRect(0, 0, W, H);
  renderPage(ctx, current, { editing: true });
}
let raf = 0;
function redraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

function toPage(e) {
  const b = stage.getBoundingClientRect();
  return { x: (e.clientX - b.left) / b.width * W, y: (e.clientY - b.top) / b.height * H };
}

function hitSticker(p) {
  const c = S.cover;
  const keys = Object.keys(c.stickers).filter((k) => S.settings.included[k] && !c.stickers[k].hidden)
    .sort((a, b) => c.stickers[b].z - c.stickers[a].z);
  for (const k of keys) {
    const g = stickerGeom(k);
    const dx = p.x - g.x, dy = p.y - g.y, ca = Math.cos(-g.rot), sa = Math.sin(-g.rot);
    const lx = dx * ca - dy * sa, ly = dx * sa + dy * ca;
    if (Math.abs(lx) <= g.w / 2 && Math.abs(ly) <= g.h / 2) return k;
  }
  return null;
}

const pointers = new Map();
let drag = null;
stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, toPage(e));
  const p = toPage(e);
  if (pointers.size === 2) { startPinch(); return; }
  if (current === 'cover') {
    const k = hitSticker(p);
    selected = k;
    if (k) {
      const st = S.cover.stickers[k];
      st.z = Math.max(...Object.values(S.cover.stickers).map((s) => s.z)) + 1;   // picked up -> on top
      drag = { kind: 'sticker', k, start: p, fx: st.fx, fy: st.fy };
    } else drag = null;
    renderPanel();
  } else {
    const L = postcardLayout(scratchCtx, current), s = L.stamp;
    if (p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) {
      const st = S.pages[current].stamp; drag = { kind: 'stamp', start: p, dx: st.dx, dy: st.dy };
    } else if (p.x < L.split) {
      const ph = S.pages[current].photo; drag = { kind: 'photo', start: p, cx: ph.cx, cy: ph.cy };
    } else drag = null;
  }
  redraw();
});
stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, toPage(e));
  if (pointers.size === 2 && pinch) { doPinch(); return; }
  if (!drag) return;
  const p = toPage(e), dx = p.x - drag.start.x, dy = p.y - drag.start.y;
  if (drag.kind === 'sticker') {
    const st = S.cover.stickers[drag.k], cr = contentRect('cover');
    st.fx = drag.fx + dx / cr.w; st.fy = drag.fy + dy / H;
  } else if (drag.kind === 'stamp') {
    const st = S.pages[current].stamp; st.dx = drag.dx + dx; st.dy = drag.dy + dy;
  } else if (drag.kind === 'photo') {
    const R = photoRect(current), img = PACK.img.photos[current], ph = S.pages[current].photo;
    const s = Math.max(R.w / img.width, R.h / img.height) * ph.zoom;
    ph.cx = clamp(drag.cx - dx / s / img.width, 0, 1); ph.cy = clamp(drag.cy - dy / s / img.height, 0, 1);
  }
  redraw();
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0 && drag) { drag = null; commit(); }
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

let pinch = null;
function pinchVals() {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
}
function startPinch() {
  drag = null;
  const v = pinchVals();
  if (current === 'cover' && selected) { const st = S.cover.stickers[selected]; pinch = { ...v, size: st.size, rot: st.rot }; }
  else if (current !== 'cover') { pinch = { ...v, zoom: S.pages[current].photo.zoom }; }
}
function doPinch() {
  const v = pinchVals(), f = v.d / pinch.d;
  if (current === 'cover' && selected) {
    const st = S.cover.stickers[selected];
    st.size = clamp(pinch.size * f, 0.08, 0.6); st.rot = pinch.rot + (v.ang - pinch.ang) * 180 / Math.PI;
  } else if (current !== 'cover') {
    S.pages[current].photo.zoom = clamp(pinch.zoom * f, 1, 4);
  }
  redraw();
}
stage.addEventListener('wheel', (e) => {
  if (current === 'cover' && selected) {
    e.preventDefault();
    const st = S.cover.stickers[selected];
    if (e.shiftKey) st.rot += e.deltaY * 0.05; else st.size = clamp(st.size * (1 - e.deltaY * 0.001), 0.08, 0.6);
    redraw(); commitSoon();
  } else if (current !== 'cover') {
    e.preventDefault();
    const ph = S.pages[current].photo; ph.zoom = clamp(ph.zoom * (1 - e.deltaY * 0.001), 1, 4); redraw(); commitSoon();
  }
}, { passive: false });

/* ------------------------------------------------------------------ panel */

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (k === 'class') n.className = v;
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) n.append(k);
  return n;
}
function field(label, input) { return el('label', {}, label, input); }
function range(value, min, max, step, oninput) {
  const i = el('input', { type: 'range', min, max, step, value });
  i.addEventListener('input', () => { oninput(+i.value); redraw(); commitSoon(); });
  return i;
}
function text(value, oninput) {
  const i = el('input', { type: 'text', value });
  i.addEventListener('input', () => { oninput(i.value); redraw(); commitSoon(); });
  return i;
}

function renderPanel() {
  const P = $('#panel'); P.innerHTML = '';
  if (current === 'cover') {
    const c = S.cover;
    P.append(el('h3', {}, 'כריכה'),
      el('p', { class: 'hint' }, 'גוררים מדבקה כדי להזיז אותה. במגע: שתי אצבעות על מדבקה מסומנת משנות גודל וסיבוב. בעכבר: גלגלת לגודל, Shift+גלגלת לסיבוב.'),
      el('div', { class: 'grid' },
        ...c.titleLines.map((t, i) => field(`כותרת, שורה ${i + 1}`, text(t, (v) => { c.titleLines[i] = v; }))),
        field('תאריכים', text(c.dates, (v) => { c.dates = v; })),
        field('גובה הכותרת', range(c.titleY, 0.05, 0.55, 0.005, (v) => { c.titleY = v; })),
        field('גודל הכותרת', range(c.titleSize, 0.6, 1.3, 0.01, (v) => { c.titleSize = v; })),
      ),
      el('div', { class: 'row' },
        el('button', { onclick: () => { autoArrange(); selected = null; commit(); renderPanel(); } }, 'סידור אוטומטי'),
        el('button', { onclick: () => { S.cover.seed = (S.cover.seed || 1) + 1; autoArrange(); selected = null; commit(); renderPanel(); } }, 'ערבוב'),
      ));
    if (selected) {
      const st = c.stickers[selected], pg = S.pages[selected];
      P.append(el('h3', {}, `מדבקה: ${pg.place}`), el('div', { class: 'grid' },
        field('גודל', range(st.size, 0.08, 0.6, 0.005, (v) => { st.size = v; })),
        field('סיבוב', range(st.rot, -45, 45, 0.5, (v) => { st.rot = v; })),
      ), el('div', { class: 'row' },
        el('button', { onclick: () => { st.z = Math.max(...Object.values(c.stickers).map((s) => s.z)) + 1; commit(); } }, 'להביא קדימה'),
        el('button', { onclick: () => { st.z = Math.min(...Object.values(c.stickers).map((s) => s.z)) - 1; commit(); } }, 'לשלוח אחורה'),
        el('button', { class: 'ghost', onclick: () => { st.hidden = true; selected = null; commit(); renderPanel(); } }, 'להסתיר מהכריכה'),
      ));
    }
    const hidden = Object.keys(c.stickers).filter((k) => c.stickers[k].hidden && S.settings.included[k]);
    if (hidden.length) P.append(el('div', { class: 'row' }, el('span', { class: 'hint' }, 'מוסתרות:'),
      ...hidden.map((k) => el('button', { class: 'ghost', onclick: () => { c.stickers[k].hidden = false; commit(); renderPanel(); } }, `↩ ${S.pages[k].place}`))));
    return;
  }
  const pg = S.pages[current];
  const num = 1 + includedPages().findIndex((p) => p.key === current);
  P.append(el('h3', {}, `פרק ${num}: ${pg.place}`),
    el('p', { class: 'hint' }, 'גוררים את התמונה כדי למקם אותה, ואת החותמת כדי להזיז אותה. צביטה או גלגלת על התמונה מגדילות.'),
    el('div', { class: 'grid' },
      field('שם המקום', text(pg.place, (v) => { pg.place = v; })),
      field('שלוש מילים (מופרדות בפסיק)', text(pg.keywords, (v) => { pg.keywords = v; })),
      field('תאריך', text(pg.date, (v) => { pg.date = v; })),
      field('הגדלת התמונה', range(pg.photo.zoom, 1, 4, 0.01, (v) => { pg.photo.zoom = v; })),
      field('גודל החותמת', range(pg.stamp.scale, 0.4, 1.4, 0.01, (v) => { pg.stamp.scale = v; })),
    ),
    el('div', { class: 'row' },
      el('button', { class: 'ghost', onclick: () => {
        const m = PACK.manifest.pages.find((p) => p.key === current);
        pg.photo = { cx: m.photo_center[0], cy: m.photo_center[1], zoom: 1 }; pg.stamp = { dx: 0, dy: 0, scale: 1 };
        commit(); renderPanel(); } }, 'איפוס מיקום התמונה והחותמת'),
    ));
}

/* ------------------------------------------------------------------ page strip */

const thumbCache = {};
function renderThumb(id) {
  const c = document.createElement('canvas'); const s = 200 / W;
  c.width = 200; c.height = Math.round(H * s);
  const ctx = c.getContext('2d'); ctx.setTransform(s, 0, 0, s, 0, 0); ctx.__v = s;
  renderPage(ctx, id);
  thumbCache[id] = c.toDataURL('image/jpeg', 0.7);
}
function renderStrip() {
  const N = $('#pages'); N.innerHTML = '';
  const ids = ['cover', ...includedPages().map((p) => p.key)];
  if (!ids.includes(current)) current = 'cover';
  ids.forEach((id, i) => {
    if (!thumbCache[id]) renderThumb(id);
    const label = id === 'cover' ? 'כריכה' : `${i}. ${S.pages[id].place.split(',')[0]}`;
    N.append(el('button', { class: id === current ? 'active' : '', onclick: () => { current = id; selected = null; renderStrip(); renderPanel(); redraw(); } },
      el('img', { src: thumbCache[id], alt: '' }), label));
  });
}

let commitTimer = 0;
function commit() {
  saveState();
  delete thumbCache[current];
  if (current !== 'cover') delete thumbCache.cover;   // numbering / text can touch other pages
  renderStrip(); redraw();
}
function commitSoon() { clearTimeout(commitTimer); commitTimer = setTimeout(commit, 400); }
function invalidateAll() { for (const k of Object.keys(thumbCache)) delete thumbCache[k]; }

/* ------------------------------------------------------------------ settings */

function openSettings() {
  const d = $('#settings'), st = S.settings;
  $('#set-margin').value = st.marginMM;
  d.querySelectorAll('input[name=mside]').forEach((i) => { i.checked = i.value === st.marginSide; });
  d.querySelectorAll('input[name=edge]').forEach((i) => { i.checked = i.value === st.edge; });
  const pl = $('#set-places'); pl.innerHTML = '';
  for (const p of PACK.manifest.pages) {
    const cb = el('input', { type: 'checkbox' }); cb.checked = !!st.included[p.key];
    cb.addEventListener('change', () => {
      st.included[p.key] = cb.checked;
      if (cb.checked && !S.cover.stickers[p.key]) autoArrange();
      invalidateAll(); commit(); renderPanel();
    });
    pl.append(el('label', {}, cb, S.pages[p.key].place));
  }
  d.showModal();
}
$('#btn-settings').addEventListener('click', openSettings);
$('#set-margin').addEventListener('input', (e) => { S.settings.marginMM = clamp(+e.target.value || 0, 0, 30); invalidateAll(); commit(); });
document.querySelectorAll('input[name=mside]').forEach((i) => i.addEventListener('change', () => {
  S.settings.marginSide = i.value; invalidateAll(); commit(); }));
document.querySelectorAll('input[name=edge]').forEach((i) => i.addEventListener('change', () => {
  S.settings.edge = i.value; invalidateAll(); commit(); }));
$('#btn-reset').addEventListener('click', () => {
  if (!confirm('לאפס את כל העריכה (מיקומים, טקסטים והגדרות)?')) return;
  S = defaultState(PACK.manifest); invalidateAll(); commit(); renderPanel(); $('#settings').close();
});
$('#btn-save-layout').addEventListener('click', () => {
  download(new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' }), 'booklet-layout.json');
});
$('#layout-input').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { S = JSON.parse(await f.text()); invalidateAll(); commit(); renderPanel(); $('#settings').close(); }
  catch (err) { alert('הקובץ לא נקרא: ' + err.message); }
});
$('#btn-new-pack').addEventListener('click', () => { $('#settings').close(); showLoader(); });

/* ------------------------------------------------------------------ export */

function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
// JPEG from canvas carries a JFIF header; set its density to 300 dpi so it prints at 18 x 13 cm.
function setDpi(buf, dpi) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF && b[3] === 0xE0 && String.fromCharCode(...b.slice(6, 10)) === 'JFIF') {
    b[13] = 1; b[14] = dpi >> 8; b[15] = dpi & 255; b[16] = dpi >> 8; b[17] = dpi & 255;
  }
  return b;
}
async function renderJpeg(id) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'); ctx.__v = 1;
  renderPage(ctx, id);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
  return setDpi(await blob.arrayBuffer(), PACK.manifest.page.dpi);
}
const fileName = (id, i) => id === 'cover' ? '00-cover.jpg' : `${String(i).padStart(2, '0')}-${id}.jpg`;
function busy(msg) { $('#busy-text').textContent = msg; $('#busy').hidden = !msg; }

$('#btn-export-page').addEventListener('click', async () => {
  busy('מייצא עמוד…');
  try {
    const i = pageIndex(current);
    download(new Blob([await renderJpeg(current)], { type: 'image/jpeg' }), fileName(current, i));
  } finally { busy(''); }
});
$('#btn-export-all').addEventListener('click', async () => {
  const ids = ['cover', ...includedPages().map((p) => p.key)];
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [PACK.manifest.page.h_mm, PACK.manifest.page.w_mm] });
  const zip = new JSZip();
  try {
    for (let i = 0; i < ids.length; i++) {
      busy(`מייצא ${i + 1} מתוך ${ids.length}…`);
      const bytes = await renderJpeg(ids[i]);
      zip.file(fileName(ids[i], i), bytes);
      if (i) pdf.addPage();
      pdf.addImage(bytes, 'JPEG', 0, 0, PACK.manifest.page.w_mm, PACK.manifest.page.h_mm);
      await new Promise((r) => setTimeout(r, 0));
    }
    busy('אורז…');
    download(pdf.output('blob'), 'booklet.pdf');
    const zb = await zip.generateAsync({ type: 'blob' });
    setTimeout(() => download(zb, 'booklet-jpg-300dpi.zip'), 800);
  } finally { busy(''); }
});

/* ------------------------------------------------------------------ boot */

function showLoader(msg = '') { $('#loader').hidden = false; $('#app').hidden = true; $('#loader-status').textContent = msg; }
async function start(buf) {
  $('#loader-status').textContent = 'פותח את החבילה…';
  PACK = await openPack(buf);
  const saved = loadState();
  S = saved && saved.v === 1 ? saved : defaultState(PACK.manifest);
  for (const p of PACK.manifest.pages) {         // new places in a newer pack
    if (!S.pages[p.key]) { const d = defaultState(PACK.manifest); S.pages[p.key] = d.pages[p.key]; S.settings.included[p.key] = true; }
  }
  $('#loader').hidden = true; $('#app').hidden = false;
  invalidateAll(); renderStrip(); renderPanel(); draw();
}
$('#pack-input').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    $('#loader-status').textContent = 'שומר בדפדפן…';
    await idbSet('pack', buf);
    await start(buf);
  } catch (err) { showLoader('לא הצלחתי לפתוח את החבילה: ' + err.message); }
});
window.addEventListener('resize', redraw);

(async () => {
  showLoader('טוען…');
  try {
    const url = new URLSearchParams(location.search).get('pack');   // optional: load a pack from a URL you control
    if (url) { const buf = await (await fetch(url)).arrayBuffer(); await idbSet('pack', buf); await start(buf); return; }
    const buf = await idbGet('pack');
    if (buf) await start(buf); else showLoader();
  } catch (err) { showLoader(''); }
})();
