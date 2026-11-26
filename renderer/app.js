'use strict';
/* BlurStudio renderer — manual redaction editor */

const $ = (id) => document.getElementById(id);
const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
const stage = $('stage'), timeline = $('timeline'), tlInner = $('tlInner');
const ruler = $('ruler'), rctx = ruler.getContext('2d'), tracksEl = $('tracks'), playhead = $('playhead');

const frameDur = () => 1 / (state.fps || 30);
const MIN_LEN = 0.05;
const PALETTE = ['#4f8cff', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#d6409f', '#e2731c', '#3e63dd', '#7c9a2a'];
const SHAPE_FA = { rect: 'مستطیل', ellipse: 'بیضی' };
const MODE_FA = { blur: 'بلور', pixelate: 'پیکسلی', color: 'رنگ' };

const state = {
  videoPath: null, duration: 0, vw: 0, vh: 0,
  items: [], nextNum: 1, selectedId: null,
  tool: 'rect', pps: 10, fitPps: 10,
  undo: [], redo: [], pre: null,
  dirty: false,
  fps: 30,
  suggestions: [], selSug: null, analyzing: false
};
const CATS = { password: 'پسورد', credential: 'یوزر / مقدار فرم', secret: 'کلید / توکن', url: 'لینک', email: 'ایمیل', ip: 'IP', phone: 'تلفن', card: 'کارت بانکی', username: 'نام کاربری' };

/* ---------- utils ---------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
function fmt(t) {
  if (!isFinite(t)) t = 0;
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000) % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}
function fmtShort(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = s.toFixed(1).padStart(4, '0');
  return h ? `${h}:${pad(m)}:${ss}` : `${pad(m)}:${ss}`;
}
function parseTime(str) {
  str = String(str).trim().replace(',', '.');
  if (!str) return NaN;
  const parts = str.split(':').map(Number);
  if (parts.some((p) => isNaN(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
function toast(msg, ms = 2200) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms);
}
const colorOf = (it) => PALETTE[(it.num - 1) % PALETTE.length];
const byId = (id) => state.items.find((i) => i.id === id);
const selected = () => byId(state.selectedId);
const isActive = (it, t) => t >= it.start && t <= it.end;

/* ---------- history ---------- */
const serialize = () => JSON.stringify({ items: state.items, nextNum: state.nextNum });
function beginChange() { if (state.pre === null) state.pre = serialize(); }
function endChange() {
  if (state.pre !== null) {
    const now = serialize();
    if (now !== state.pre) { state.undo.push(state.pre); if (state.undo.length > 300) state.undo.shift(); state.redo = []; state.dirty = true; }
    state.pre = null;
  }
}
function change(fn) { beginChange(); fn(); endChange(); refreshAll(); }
function restore(snap) {
  const d = JSON.parse(snap); state.items = d.items; state.nextNum = d.nextNum;
  if (!byId(state.selectedId)) state.selectedId = null;
  refreshAll();
}
function undo() { if (!state.undo.length) return; state.redo.push(serialize()); restore(state.undo.pop()); }
function redo() { if (!state.redo.length) return; state.undo.push(serialize()); restore(state.redo.pop()); }

/* ---------- video loading ---------- */
function loadVideo(p) {
  state.videoPath = p;
  video.src = window.api.fileUrl(p);
  document.title = 'Sahand Fast Blurer — ' + p.split(/[\\/]/).pop();
}
video.addEventListener('loadedmetadata', () => {
  state.duration = video.duration; state.vw = video.videoWidth; state.vh = video.videoHeight;
  $('drop').classList.add('hidden');
  $('scrub').max = state.duration;
  $('tDur').textContent = fmt(state.duration);
  for (const it of state.items) { it.end = Math.min(it.end, state.duration); it.start = Math.min(it.start, it.end - MIN_LEN); }
  fitZoom(); resizeCanvas(); refreshAll();
  window.api.probe(state.videoPath).then((r) => { if (r && r.fps) state.fps = r.fps; });
  toast(`${state.vw}×${state.vh} · ${fmt(state.duration)}`);
});
video.addEventListener('error', () => {
  toast('این ویدیو باز نشد. احتمالاً کدک آن پشتیبانی نمی‌شود (در OBS از H.264 استفاده کنید).', 5000);
});
video.addEventListener('play', () => ($('btnPlay').textContent = '❚❚'));
video.addEventListener('pause', () => ($('btnPlay').textContent = '▶'));

async function openVideoDialog() { const p = await window.api.openVideo(); if (p) confirmReplace() && loadVideo(p); }
function confirmReplace() {
  if (state.items.length && state.dirty) {
    if (!confirm('موارد فعلی حفظ شوند؟ (OK = حفظ، Cancel = پاک شوند)')) { state.items = []; state.nextNum = 1; state.selectedId = null; state.undo = []; state.redo = []; }
  }
  return true;
}

/* drag & drop */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0]; if (!f) return;
  const p = window.api.pathForFile(f);
  if (/\.(blurproj|json)$/i.test(p)) { const txt = await f.text(); applyProject(JSON.parse(txt)); return; }
  confirmReplace(); loadVideo(p);
});

/* ---------- seeking ---------- */
let pendingSeek = null;
function seek(t) {
  if (!state.duration) return;
  pendingSeek = clamp(t, 0, state.duration);
  if (!video.seeking) { video.currentTime = pendingSeek; pendingSeek = null; }
}
video.addEventListener('seeked', () => { if (pendingSeek !== null) { video.currentTime = pendingSeek; pendingSeek = null; } });
const curTime = () => (pendingSeek !== null ? pendingSeek : video.currentTime);
function togglePlay() { if (!state.duration) return; video.paused ? video.play() : video.pause(); }

/* ---------- canvas geometry ---------- */
let dpr = 1;
function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
}
new ResizeObserver(() => { resizeCanvas(); drawRuler(); }).observe(stage);
new ResizeObserver(() => { if (state.duration) { const keepFit = Math.abs(state.pps - state.fitPps) < 1e-6; computeFit(); if (keepFit) setPps(state.fitPps); else layoutTimeline(); } }).observe(timeline);

function videoRect() {
  const cw = canvas.width / dpr, ch = canvas.height / dpr;
  if (!state.vw) return { x: 0, y: 0, w: cw, h: ch, s: 1 };
  const s = Math.min(cw / state.vw, ch / state.vh);
  const w = state.vw * s, h = state.vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, s };
}
function itemBox(it, vr) { return { x: vr.x + it.x * vr.w, y: vr.y + it.y * vr.h, w: it.w * vr.w, h: it.h * vr.h }; }
function shapePath(c, shape, b) {
  c.beginPath();
  if (shape === 'ellipse') c.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(0.5, b.w / 2), Math.max(0.5, b.h / 2), 0, 0, Math.PI * 2);
  else c.rect(b.x, b.y, b.w, b.h);
}

/* ---------- overlay rendering ---------- */
const off = document.createElement('canvas'), offCtx = off.getContext('2d');
function drawEffect(it, vr) {
  const b = itemBox(it, vr);
  if (b.w < 1 || b.h < 1) return;
  ctx.save();
  shapePath(ctx, it.shape, b); ctx.clip();
  if (it.mode === 'color') {
    ctx.fillStyle = it.color; ctx.fillRect(b.x, b.y, b.w, b.h);
  } else if (video.readyState >= 2) {
    const sx = it.x * state.vw, sy = it.y * state.vh, sw = it.w * state.vw, sh = it.h * state.vh;
    if (it.mode === 'pixelate') {
      const k = Math.max(2, it.strength);
      const ow = Math.max(1, Math.round(sw / k)), oh = Math.max(1, Math.round(sh / k));
      off.width = ow; off.height = oh;
      offCtx.imageSmoothingEnabled = true;
      offCtx.drawImage(video, sx, sy, sw, sh, 0, 0, ow, oh);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, ow, oh, b.x, b.y, b.w, b.h);
    } else {
      const r = Math.max(1, Math.min(it.strength, Math.floor(Math.min(sw, sh) / 2) - 1));
      const m = r * 3;
      const ax = clamp(sx - m, 0, state.vw), ay = clamp(sy - m, 0, state.vh);
      const bx = clamp(sx + sw + m, 0, state.vw), by = clamp(sy + sh + m, 0, state.vh);
      ctx.filter = `blur(${(0.82 * r * vr.s).toFixed(2)}px)`;
      ctx.drawImage(video, ax, ay, bx - ax, by - ay, vr.x + ax * vr.s, vr.y + ay * vr.s, (bx - ax) * vr.s, (by - ay) * vr.s);
      ctx.filter = 'none';
    }
  }
  ctx.restore();
}
function drawOutline(it, vr, sel, active) {
  const b = itemBox(it, vr), col = colorOf(it);
  ctx.save();
  ctx.lineWidth = sel ? 2 : 1;
  ctx.strokeStyle = col;
  ctx.setLineDash(active ? [] : [6, 4]);
  ctx.globalAlpha = active ? 1 : 0.8;
  shapePath(ctx, it.shape, b); ctx.stroke();
  ctx.setLineDash([]);
  // number badge
  ctx.fillStyle = col; ctx.font = 'bold 11px Segoe UI, Tahoma';
  const label = String(it.num), tw = ctx.measureText(label).width + 8;
  ctx.fillRect(b.x, b.y - 16, tw, 15);
  ctx.fillStyle = '#fff'; ctx.fillText(label, b.x + 4, b.y - 4.5);
  if (sel) {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = col;
    for (const [hx, hy] of corners(b)) { ctx.fillRect(hx - 4, hy - 4, 8, 8); ctx.strokeRect(hx - 4, hy - 4, 8, 8); }
  }
  ctx.restore();
}
const corners = (b) => [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];

let drawing = null; // {x0,y0,x1,y1,shape}
function render() {
  try { renderFrame(); } catch (err) { console.error(err); }
  requestAnimationFrame(render);
}
function renderFrame() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.vw) {
    const vr = videoRect(), t = curTime();
    for (const it of state.items) if (isActive(it, t)) drawEffect(it, vr);
    for (const it of state.items) {
      const sel = it.id === state.selectedId, act = isActive(it, t);
      if (act || sel) drawOutline(it, vr, sel, act);
    }
    if ($('aShow').checked) for (const sg of state.suggestions) if (isActive(sg, t) || sg.id === state.selSug) drawSuggestion(sg, vr, isActive(sg, t));
    if (drawing) {
      const b = normRect(drawing);
      ctx.save(); ctx.strokeStyle = '#fff'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
      shapePath(ctx, drawing.shape, b); ctx.stroke(); ctx.restore();
    }
  }
  updateTimeUI();
}

/* ---------- canvas interaction ---------- */
function normRect(d) {
  let x0 = d.x0, y0 = d.y0, x1 = d.x1, y1 = d.y1;
  if (d.square) { const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s; }
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}
function canvasPt(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function hitHandle(it, p, vr) {
  const b = itemBox(it, vr);
  const cs = corners(b);
  for (let i = 0; i < 4; i++) if (Math.abs(p.x - cs[i][0]) <= 7 && Math.abs(p.y - cs[i][1]) <= 7) return i;
  return -1;
}
function hitShape(it, p, vr) {
  const b = itemBox(it, vr);
  if (it.shape === 'ellipse') {
    const rx = b.w / 2, ry = b.h / 2; if (rx < 1 || ry < 1) return false;
    const dx = (p.x - b.x - rx) / rx, dy = (p.y - b.y - ry) / ry; return dx * dx + dy * dy <= 1;
  }
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

let cdrag = null; // {type:'move'|'resize', id, corner, p0, orig}
canvas.addEventListener('pointerdown', (e) => {
  if (!state.vw || e.button !== 0) return;
  const p = canvasPt(e), vr = videoRect(), t = curTime();
  const sel = selected();
  if (sel) {
    const h = hitHandle(sel, p, vr);
    if (h >= 0) { beginChange(); cdrag = { type: 'resize', id: sel.id, corner: h, p0: p, orig: { ...sel } }; canvas.setPointerCapture(e.pointerId); return; }
  }
  if (state.tool === 'select') {
    const cands = state.items.filter((it) => isActive(it, t) || it.id === state.selectedId).reverse();
    const hit = cands.find((it) => hitShape(it, p, vr));
    if (hit) {
      select(hit.id, false); beginChange();
      cdrag = { type: 'move', id: hit.id, p0: p, orig: { ...hit } };
      canvas.setPointerCapture(e.pointerId);
    } else select(null);
    return;
  }
  // draw new
  const x = clamp(p.x, vr.x, vr.x + vr.w), y = clamp(p.y, vr.y, vr.y + vr.h);
  drawing = { x0: x, y0: y, x1: x, y1: y, shape: state.tool, square: e.shiftKey };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  const p = canvasPt(e), vr = videoRect();
  if (drawing) {
    drawing.x1 = clamp(p.x, vr.x, vr.x + vr.w); drawing.y1 = clamp(p.y, vr.y, vr.y + vr.h); drawing.square = e.shiftKey; return;
  }
  if (cdrag) {
    const it = byId(cdrag.id); if (!it) return;
    const dx = (p.x - cdrag.p0.x) / vr.w, dy = (p.y - cdrag.p0.y) / vr.h, o = cdrag.orig;
    if (cdrag.type === 'move') {
      it.x = clamp(o.x + dx, 0, 1 - o.w); it.y = clamp(o.y + dy, 0, 1 - o.h);
    } else {
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      const c = cdrag.corner;
      if (c === 0 || c === 2) x0 = clamp(o.x + dx, 0, 1); else x1 = clamp(o.x + o.w + dx, 0, 1);
      if (c === 0 || c === 1) y0 = clamp(o.y + dy, 0, 1); else y1 = clamp(o.y + o.h + dy, 0, 1);
      it.x = Math.min(x0, x1); it.y = Math.min(y0, y1); it.w = Math.max(0.004, Math.abs(x1 - x0)); it.h = Math.max(0.004, Math.abs(y1 - y0));
    }
    return;
  }
  // cursor feedback
  const sel = selected();
  if (sel && hitHandle(sel, p, vr) >= 0) canvas.style.cursor = 'nwse-resize';
  else if (state.tool === 'select') canvas.style.cursor = state.items.some((it) => (isActive(it, curTime()) || it.id === state.selectedId) && hitShape(it, p, vr)) ? 'move' : 'default';
  else canvas.style.cursor = 'crosshair';
});
canvas.addEventListener('pointerup', (e) => {
  if (drawing) {
    const vr = videoRect(), b = normRect(drawing); const shape = drawing.shape; drawing = null;
    if (b.w >= 5 && b.h >= 5) addItem(shape, { x: (b.x - vr.x) / vr.w, y: (b.y - vr.y) / vr.h, w: b.w / vr.w, h: b.h / vr.h });
  }
  if (cdrag) { cdrag = null; endChange(); refreshAll(); }
});

function addItem(shape, r) {
  const t = curTime(), dur = Math.max(MIN_LEN, Number($('defDur').value) || 5);
  const it = {
    id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    num: state.nextNum, shape,
    mode: $('defMode').value, strength: Number($('defStrength').value), color: $('defColor').value,
    x: clamp(r.x, 0, 1), y: clamp(r.y, 0, 1), w: Math.min(r.w, 1 - r.x), h: Math.min(r.h, 1 - r.y),
    start: t, end: Math.min(state.duration, t + dur)
  };
  if (it.end - it.start < MIN_LEN) it.start = Math.max(0, it.end - dur);
  change(() => { state.items.push(it); state.nextNum++; state.selectedId = it.id; });
  scrollTrackIntoView(it);
}

/* ---------- selection & panel ---------- */
function select(id, seekTo = false) {
  state.selectedId = id;
  const it = selected();
  if (it && seekTo) seek(it.start);
  refreshAll();
  if (it) scrollTrackIntoView(it);
}
function deleteSelected() {
  const it = selected(); if (!it) return;
  change(() => { state.items = state.items.filter((x) => x !== it); state.selectedId = null; });
}
function duplicateSelected() {
  const it = selected(); if (!it) return;
  const c = { ...it, id: 'i' + Date.now().toString(36), num: state.nextNum, x: clamp(it.x + 0.02, 0, 1 - it.w), y: clamp(it.y + 0.02, 0, 1 - it.h) };
  change(() => { state.items.push(c); state.nextNum++; state.selectedId = c.id; });
}

function renderList() {
  const list = $('list'); list.innerHTML = '';
  const t = curTime();
  for (const it of state.items) {
    const el = document.createElement('div');
    el.className = 'item' + (it.id === state.selectedId ? ' sel' : '') + (isActive(it, t) ? '' : ' inactive');
    el.dataset.id = it.id;
    el.innerHTML = `<span class="num" style="background:${colorOf(it)}">${it.num}</span>
      <span class="meta"><span>${SHAPE_FA[it.shape]} · ${MODE_FA[it.mode]}${it.mode === 'color' ? '' : ' ' + it.strength}</span>
      <span class="times mono">${fmtShort(it.start)} → ${fmtShort(it.end)}</span></span>
      <button class="x" title="حذف">✕</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) { state.selectedId = it.id; deleteSelected(); return; }
      select(it.id, true);
    });
    list.appendChild(el);
  }
  $('count').textContent = state.items.length;
}
function updateListActive() {
  const t = curTime();
  for (const el of $('list').children) { const it = byId(el.dataset.id); if (it) el.classList.toggle('inactive', !isActive(it, t)); }
}
function renderDetails() {
  const it = selected(), d = $('details');
  if (!it) { d.classList.add('hidden'); $('tSetStart').disabled = $('tSetEnd').disabled = true; return; }
  d.classList.remove('hidden');
  $('dNum').textContent = '#' + it.num;
  $('dNum').style.color = colorOf(it);
  $('dShape').textContent = SHAPE_FA[it.shape];
  if (document.activeElement !== $('dStart')) $('dStart').value = fmt(it.start);
  if (document.activeElement !== $('dEnd')) $('dEnd').value = fmt(it.end);
  $('dDur').textContent = fmt(it.end - it.start);
  $('dMode').value = it.mode; $('dColor').value = it.color; $('dShapeSel').value = it.shape;
  $('dStrength').value = it.strength; $('dStrengthVal').textContent = it.strength;
  $('dColor').classList.toggle('hidden', it.mode !== 'color');
  $('tSetStart').disabled = $('tSetEnd').disabled = false;
  $('dStrength').disabled = it.mode === 'color';
}

function setTimeField(field, v) {
  const it = selected(); if (!it) return;
  const t = parseTime(v);
  if (isNaN(t)) { renderDetails(); return toast('فرمت زمان: hh:mm:ss.mmm'); }
  change(() => {
    if (field === 'start') it.start = clamp(t, 0, it.end - MIN_LEN);
    else it.end = clamp(t, it.start + MIN_LEN, state.duration || t);
  });
  seek(field === 'start' ? it.start : it.end);
}
function setEdgeHere(field) {
  const it = selected(); if (!it) return;
  const t = curTime();
  change(() => {
    if (field === 'start') { it.start = clamp(t, 0, state.duration); if (it.end - it.start < MIN_LEN) it.end = Math.min(state.duration, it.start + MIN_LEN); }
    else { it.end = clamp(t, 0, state.duration); if (it.end - it.start < MIN_LEN) it.start = Math.max(0, it.end - MIN_LEN); }
  });
}

$('dStart').addEventListener('change', (e) => setTimeField('start', e.target.value));
$('dEnd').addEventListener('change', (e) => setTimeField('end', e.target.value));
for (const id of ['dStart', 'dEnd']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('dSetStart').onclick = () => setEdgeHere('start');
$('tSetStart').onclick = () => setEdgeHere('start');
$('tSetEnd').onclick = () => setEdgeHere('end');
$('dSetEnd').onclick = () => setEdgeHere('end');
$('dMode').onchange = (e) => { const it = selected(); if (it) change(() => (it.mode = e.target.value)); };
$('dShapeSel').onchange = (e) => { const it = selected(); if (it) change(() => (it.shape = e.target.value)); };
$('dColor').addEventListener('input', (e) => { const it = selected(); if (it) { beginChange(); it.color = e.target.value; } });
$('dColor').addEventListener('change', () => { endChange(); refreshAll(); });
$('dStrength').addEventListener('input', (e) => { const it = selected(); if (it) { beginChange(); it.strength = Number(e.target.value); $('dStrengthVal').textContent = it.strength; } });
$('dStrength').addEventListener('change', () => { endChange(); refreshAll(); });
$('dGoStart').onclick = () => { const it = selected(); if (it) seek(it.start); };
$('dDup').onclick = duplicateSelected;
$('dDelete').onclick = deleteSelected;

/* ---------- timeline ---------- */
const ZMAX = 400; // px per second at max zoom
function computeFit() {
  const w = Math.max(200, timeline.clientWidth - 20);
  state.fitPps = state.duration ? w / state.duration : 10;
}
function fitZoom() { computeFit(); setPps(state.fitPps); $('zoom').value = 0; }
function setPps(pps, anchorClientX) {
  const old = state.pps;
  const anchorT = anchorClientX !== undefined ? (timeline.scrollLeft + anchorClientX) / old : null;
  state.pps = clamp(pps, state.fitPps, Math.max(ZMAX, state.fitPps));
  const lo = Math.log(state.fitPps), hi = Math.log(Math.max(ZMAX, state.fitPps * 1.0001));
  $('zoom').value = Math.round(((Math.log(state.pps) - lo) / (hi - lo || 1)) * 1000);
  layoutTimeline();
  if (anchorT !== null) timeline.scrollLeft = anchorT * state.pps - anchorClientX;
  else { const x = curTime() * state.pps; if (x < timeline.scrollLeft || x > timeline.scrollLeft + timeline.clientWidth) timeline.scrollLeft = x - timeline.clientWidth / 2; }
  drawRuler();
}
$('zoom').addEventListener('input', (e) => {
  const lo = Math.log(state.fitPps), hi = Math.log(Math.max(ZMAX, state.fitPps * 1.0001));
  const pps = Math.exp(lo + (hi - lo) * (Number(e.target.value) / 1000));
  const phX = curTime() * state.pps - timeline.scrollLeft;
  setPps(pps, clamp(phX, 0, timeline.clientWidth));
});
$('btnFit').onclick = fitZoom;
timeline.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = timeline.getBoundingClientRect();
  setPps(state.pps * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - r.left);
}, { passive: false });
timeline.addEventListener('scroll', drawRuler);

function layoutTimeline() {
  const width = Math.max(timeline.clientWidth, state.duration * state.pps + 20);
  tlInner.style.width = width + 'px';
  for (const row of tracksEl.children) positionBar(row.firstChild, byId(row.dataset.id));
}
function positionBar(bar, it) {
  if (!bar || !it) return;
  bar.style.left = it.start * state.pps + 'px';
  bar.style.width = Math.max(6, (it.end - it.start) * state.pps) + 'px';
}
function renderTracks() {
  tracksEl.innerHTML = '';
  for (const it of state.items) {
    const row = document.createElement('div');
    row.className = 'track' + (it.id === state.selectedId ? ' sel' : ''); row.dataset.id = it.id;
    const bar = document.createElement('div');
    bar.className = 'bar' + (it.id === state.selectedId ? ' sel' : '');
    bar.style.background = colorOf(it);
    bar.innerHTML = `<div class="h l"></div><span class="lbl">#${it.num} ${MODE_FA[it.mode]}</span><div class="h r"></div>`;
    bar.addEventListener('pointerdown', (e) => barDown(e, it, bar));
    bar.addEventListener('dblclick', () => seek(it.start));
    row.appendChild(bar);
    tracksEl.appendChild(row);
    positionBar(bar, it);
  }
  tlInner.style.minHeight = 24 + state.items.length * 27 + 'px';
}
function scrollTrackIntoView(it) {
  const row = tracksEl.querySelector(`[data-id="${it.id}"]`); if (!row) return;
  const top = row.offsetTop + 24, bottom = top + row.offsetHeight;
  if (top - 24 < timeline.scrollTop || bottom > timeline.scrollTop + timeline.clientHeight) timeline.scrollTop = top - 24 - 30;
}

let bdrag = null;
function barDown(e, it, bar) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
  if (state.selectedId !== it.id) { state.selectedId = it.id; renderList(); renderDetails(); markSelectedTrack(); }
  beginChange();
  bdrag = { it, mode, x0: e.clientX, s0: it.start, e0: it.end, bar, moved: false };
  bar.setPointerCapture(e.pointerId);
  bar.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
  seek(mode === 'r' ? it.end : it.start);
}
window.addEventListener('pointermove', (e) => {
  if (!bdrag) return;
  const { it, mode, s0, e0 } = bdrag, dt = (e.clientX - bdrag.x0) / state.pps, D = state.duration;
  if (Math.abs(e.clientX - bdrag.x0) > 1) bdrag.moved = true;
  if (mode === 'l') { it.start = clamp(s0 + dt, 0, it.end - MIN_LEN); seek(it.start); }
  else if (mode === 'r') { it.end = clamp(e0 + dt, it.start + MIN_LEN, D); seek(it.end); }
  else { const len = e0 - s0; it.start = clamp(s0 + dt, 0, D - len); it.end = it.start + len; seek(it.start); }
  positionBar(bdrag.bar, it);
  renderDetails();
  const tEl = $('list').querySelector(`[data-id="${it.id}"] .times`); if (tEl) tEl.textContent = `${fmtShort(it.start)} → ${fmtShort(it.end)}`;
});
window.addEventListener('pointerup', () => {
  if (!bdrag) return;
  bdrag.bar.style.cursor = ''; bdrag = null; endChange(); refreshAll();
});
function markSelectedTrack() {
  for (const row of tracksEl.children) {
    const s = row.dataset.id === state.selectedId; row.classList.toggle('sel', s); row.firstChild.classList.toggle('sel', s);
  }
}

/* ruler & scrubbing in the timeline */
function drawRuler() {
  const w = timeline.clientWidth, h = 24;
  ruler.width = Math.round(w * dpr); ruler.height = Math.round(h * dpr); ruler.style.width = w + 'px';
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.fillStyle = '#15181d'; rctx.fillRect(0, 0, w, h);
  if (!state.duration) return;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((s) => s * state.pps >= 90) || 3600;
  const minor = step / 5, sl = timeline.scrollLeft;
  const t0 = Math.floor(sl / state.pps / minor) * minor, t1 = (sl + w) / state.pps;
  rctx.strokeStyle = '#3a404c'; rctx.fillStyle = '#8b93a1'; rctx.font = '10px Consolas, monospace';
  rctx.beginPath();
  for (let t = t0; t <= t1 && t <= state.duration + 1e-6; t += minor) {
    const x = Math.round(t * state.pps - sl) + 0.5;
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    rctx.moveTo(x, major ? 8 : 16); rctx.lineTo(x, h);
    if (major) rctx.fillText(fmtShort(t).replace(/\.0$/, ''), x + 3, 10);
  }
  rctx.stroke();
}
let rulerDrag = false;
function timelineSeek(e) { const r = timeline.getBoundingClientRect(); seek((e.clientX - r.left + timeline.scrollLeft) / state.pps); }
ruler.addEventListener('pointerdown', (e) => { rulerDrag = true; ruler.setPointerCapture(e.pointerId); timelineSeek(e); });
ruler.addEventListener('pointermove', (e) => { if (rulerDrag) timelineSeek(e); });
ruler.addEventListener('pointerup', () => (rulerDrag = false));
tracksEl.addEventListener('pointerdown', (e) => { if (e.target === tracksEl || e.target.classList.contains('track')) { timelineSeek(e); } });

/* ---------- transport ---------- */
$('btnPlay').onclick = togglePlay;
let scrubbing = false;
$('scrub').addEventListener('input', (e) => { scrubbing = true; seek(Number(e.target.value)); });
$('scrub').addEventListener('change', () => (scrubbing = false));

let lastListUpdate = 0, lastT = -1;
function updateTimeUI() {
  const t = curTime();
  if (t !== lastT) {
    lastT = t;
    $('tCur').textContent = fmt(t);
    if (!scrubbing) $('scrub').value = t;
    playhead.style.left = t * state.pps + 'px';
    if (!video.paused) {
      const x = t * state.pps;
      if (x > timeline.scrollLeft + timeline.clientWidth - 40 || x < timeline.scrollLeft) timeline.scrollLeft = x - 60;
    }
    const now = performance.now();
    if (now - lastListUpdate > 200) { lastListUpdate = now; updateListActive(); }
  }
}

/* ---------- toolbar ---------- */
function setTool(t) {
  state.tool = t;
  for (const b of $('tools').children) b.classList.toggle('active', b.dataset.tool === t);
  canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
}
for (const b of $('tools').children) b.onclick = () => setTool(b.dataset.tool);
$('defStrength').addEventListener('input', (e) => ($('defStrengthVal').textContent = e.target.value));
$('btnOpen').onclick = openVideoDialog;
$('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
$('btnPanel').onclick = () => { document.body.classList.toggle('panel-hidden'); };

/* project files */
function projectData() {
  return { app: 'BlurStudio', version: 1, videoPath: state.videoPath, items: state.items, nextNum: state.nextNum, suggestions: state.suggestions,
    defaults: { mode: $('defMode').value, strength: Number($('defStrength').value), color: $('defColor').value, duration: Number($('defDur').value) } };
}
async function saveProject() {
  const base = state.videoPath ? state.videoPath.replace(/\.[^.\\/]+$/, '') + '.blurproj' : 'project.blurproj';
  const p = await window.api.saveProject(base, projectData());
  if (p) { state.dirty = false; toast('پروژه ذخیره شد'); }
}
async function applyProject(d) {
  if (!d || !Array.isArray(d.items)) return toast('فایل پروژه نامعتبر است');
  state.items = d.items; state.nextNum = d.nextNum || (Math.max(0, ...d.items.map((i) => i.num)) + 1);
  state.selectedId = null; state.undo = []; state.redo = []; state.dirty = false;
  state.suggestions = Array.isArray(d.suggestions) ? d.suggestions : []; state.selSug = null; renderSuggestions();
  if (d.defaults) { $('defMode').value = d.defaults.mode; $('defStrength').value = d.defaults.strength; $('defStrengthVal').textContent = d.defaults.strength; $('defColor').value = d.defaults.color; $('defDur').value = d.defaults.duration || 5; }
  if (d.videoPath && d.videoPath !== state.videoPath) {
    if (await window.api.fileExists(d.videoPath)) loadVideo(d.videoPath);
    else toast('ویدیوی پروژه پیدا نشد؛ ویدیو را دستی باز کنید.', 4000);
  }
  refreshAll();
}
$('btnSaveProj').onclick = saveProject;
$('btnLoadProj').onclick = async () => { const r = await window.api.openProject(); if (r) applyProject(r.data); };

/* export */
let lastOutput = null;
$('btnExport').onclick = async () => {
  if (!state.videoPath || !state.duration) return toast('اول یک ویدیو باز کنید');
  if (!state.items.length) return toast('هنوز هیچ موردی اضافه نشده');
  const out = await window.api.chooseOutput(state.videoPath); if (!out) return;
  video.pause(); lastOutput = out;
  openModal();
  try {
    const r = await window.api.exportVideo({ input: state.videoPath, output: out, items: state.items,
      width: state.vw, height: state.vh, duration: state.duration, encoder: $('encoder').value, quality: $('quality').value });
    finishModal(true, `ذخیره شد با ${r.encoder}\n${out}`);
  } catch (err) {
    const msg = String(err.message || err).replace(/^Error invoking remote method 'export': (Error: )?/, '');
    finishModal(false, msg === 'cancelled' ? 'لغو شد.' : msg);
  }
};
function openModal() {
  $('modal').classList.remove('hidden'); $('mTitle').textContent = 'در حال ساخت خروجی…';
  $('mBar').style.width = '0%'; $('mInfo').textContent = 'آماده‌سازی…';
  $('mCancel').classList.remove('hidden'); $('mClose').classList.add('hidden'); $('mOpen').classList.add('hidden');
}
function finishModal(ok, info) {
  $('mTitle').textContent = ok ? 'خروجی آماده است ✓' : 'خروجی ساخته نشد';
  if (ok) $('mBar').style.width = '100%';
  $('mInfo').textContent = info;
  $('mCancel').classList.add('hidden'); $('mClose').classList.remove('hidden'); $('mOpen').classList.toggle('hidden', !ok);
}
window.api.onExportProgress((p) => {
  if (p.note) { $('mInfo').textContent = p.note; return; }
  const pct = (p.progress * 100).toFixed(1);
  $('mBar').style.width = pct + '%';
  $('mInfo').textContent = `${pct}% · ${p.encoder}` + (p.eta != null ? ` · باقیمانده ~${fmtShort(p.eta)}` : '');
});
$('mCancel').onclick = () => window.api.cancelExport();
$('mClose').onclick = () => $('modal').classList.add('hidden');
$('mOpen').onclick = () => lastOutput && window.api.showInFolder(lastOutput);

/* ---------- keyboard ---------- */
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = (tag === 'input' && !['range', 'color'].includes(e.target.type)) || tag === 'select' || tag === 'textarea';
  if (e.ctrlKey || e.metaKey) {
    const k = ({ KeyZ: 'z', KeyY: 'y', KeyS: 's', KeyO: 'o', KeyD: 'd' })[e.code] || e.key.toLowerCase();
    if (k === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y' && !typing) { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); saveProject(); }
    else if (k === 'o') { e.preventDefault(); openVideoDialog(); }
    else if (k === 'd' && !typing) { e.preventDefault(); duplicateSelected(); }
    return;
  }
  if (typing) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); video.pause(); seek(curTime() - (e.shiftKey ? 1 : frameDur())); break;
    case 'ArrowRight': e.preventDefault(); video.pause(); seek(curTime() + (e.shiftKey ? 1 : frameDur())); break;
    case 'Home': seek(0); break;
    case 'End': seek(state.duration); break;
    case 'Delete': case 'Backspace': deleteSelected(); break;
    case 'Escape': select(null); break;
  }
  // letter shortcuts by physical key, so they work with the Persian layout too
  switch (e.code) {
    case 'KeyI': setEdgeHere('start'); break;
    case 'KeyO': setEdgeHere('end'); break;
    case 'KeyV': setTool('select'); break;
    case 'KeyR': setTool('rect'); break;
    case 'KeyE': setTool('ellipse'); break;
    case 'KeyH': document.body.classList.toggle('panel-hidden'); break;
    case 'Equal': case 'NumpadAdd': setPps(state.pps * 1.25); break;
    case 'Minus': case 'NumpadSubtract': setPps(state.pps * 0.8); break;
  }
});
window.addEventListener('beforeunload', () => {});

/* ---------- refresh ---------- */
function refreshAll() { renderList(); renderDetails(); renderTracks(); }

// keep keyboard shortcuts (Space) from re-triggering the last clicked button
document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });

setTool('rect');
resizeCanvas(); drawRuler(); refreshAll();
requestAnimationFrame(render);


/* ---------- automatic detection ---------- */
function drawSuggestion(sg, vr, active) {
  const b = itemBox(sg, vr);
  ctx.save();
  ctx.strokeStyle = sg.id === state.selSug ? '#ffd166' : '#f5a524';
  ctx.lineWidth = sg.id === state.selSug ? 2 : 1.2;
  ctx.setLineDash(active ? [4, 3] : [2, 4]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  ctx.font = '10px Segoe UI, Tahoma';
  const label = CATS[sg.cat] || sg.cat, tw = ctx.measureText(label).width + 8;
  ctx.fillStyle = 'rgba(245,165,36,.9)'; ctx.fillRect(b.x + b.w - tw, b.y + b.h + 1, tw, 13);
  ctx.fillStyle = '#111'; ctx.fillText(label, b.x + b.w - tw + 4, b.y + b.h + 11);
  ctx.restore();
}

for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('active', x === b);
    $('tabManual').classList.toggle('hidden', b.dataset.tab !== 'manual');
    $('tabAuto').classList.toggle('hidden', b.dataset.tab !== 'auto');
  };
}
(function buildCats() {
  const box = $('aCats');
  for (const [k, v] of Object.entries(CATS)) {
    const l = document.createElement('label'); l.className = 'chk';
    l.innerHTML = `<input type="checkbox" value="${k}" ${k === 'phone' ? '' : 'checked'} /> ${v}`;
    box.appendChild(l);
  }
})();

function renderSuggestions() {
  const list = $('sList'); list.innerHTML = '';
  $('sCount').textContent = state.suggestions.length;
  if (!state.suggestions.length) {
    list.innerHTML = `<div class="muted" style="padding:14px 12px;line-height:1.8">${state.analyzing ? 'در حال آنالیز…' : 'ویدیو را باز کنید و «شروع آنالیز» را بزنید. موارد پیدا شده اینجا با زمان نمایششان لیست می‌شوند.'}</div>`;
    return;
  }
  for (const sg of state.suggestions) {
    const el = document.createElement('div');
    el.className = 'sug' + (sg.id === state.selSug ? ' sel' : '');
    el.innerHTML = `<input type="checkbox" ${sg.checked ? 'checked' : ''} />
      <span class="cat">${CATS[sg.cat] || sg.cat}</span>
      <span class="meta"><span class="txt"></span><span class="times mono">${fmtShort(sg.start)} → ${fmtShort(sg.end)}</span></span>`;
    el.querySelector('.txt').textContent = sg.text;
    el.querySelector('.txt').title = sg.text;
    const cb = el.querySelector('input');
    cb.onclick = (e) => { e.stopPropagation(); sg.checked = cb.checked; };
    el.onclick = () => { state.selSug = sg.id; seek(sg.start + Math.min(0.3, (sg.end - sg.start) / 2)); renderSuggestions(); };
    list.appendChild(el);
  }
}
$('sAll').onchange = (e) => { for (const sg of state.suggestions) sg.checked = e.target.checked; renderSuggestions(); };

$('aStart').onclick = async () => {
  if (!state.videoPath || !state.duration) return toast('اول یک ویدیو باز کنید');
  const cats = [...$('aCats').querySelectorAll('input:checked')].map((i) => i.value);
  if (!cats.length) return toast('حداقل یک دسته را انتخاب کنید');
  state.analyzing = true; state.suggestions = []; state.selSug = null; renderSuggestions();
  $('aStart').classList.add('hidden'); $('aCancel').classList.remove('hidden'); $('aProg').classList.remove('hidden');
  $('aBar').style.width = '0%'; $('aInfo').textContent = 'بارگذاری مدل OCR…';
  try {
    const r = await window.api.analyze({ input: state.videoPath, width: state.vw, height: state.vh, duration: state.duration,
      interval: Number($('aInterval').value), cats });
    state.suggestions = r.results.map((x) => ({ ...x, checked: true }));
    $('aBar').style.width = '100%';
    $('aInfo').textContent = `${r.results.length} مورد · ${r.frames} فریم بررسی شد (${r.ocrFrames} با OCR) · ${fmtShort(r.seconds)}`;
    state.dirty = true;
  } catch (err) {
    const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('aInfo').textContent = msg === 'cancelled' ? 'لغو شد.' : 'خطا: ' + msg;
  } finally {
    state.analyzing = false;
    $('aStart').classList.remove('hidden'); $('aCancel').classList.add('hidden');
    renderSuggestions();
  }
};
$('aCancel').onclick = () => window.api.cancelAnalyze();
window.api.onAnalyzeProgress((m) => {
  if (m.type !== 'progress') return;
  $('aBar').style.width = (m.progress * 100).toFixed(1) + '%';
  $('aInfo').textContent = `${(m.progress * 100).toFixed(1)}% · ${fmtShort(m.t)} · ${m.found} مورد` + (m.eta != null ? ` · باقیمانده ~${fmtShort(m.eta)}` : '');
});

$('sAdd').onclick = () => {
  const pick = state.suggestions.filter((s) => s.checked);
  if (!pick.length) return toast('موردی انتخاب نشده');
  const pad = Math.max(0, Number($('sPad').value) || 0);
  const px = pad / (state.vw || 1), py = pad / (state.vh || 1);
  change(() => {
    for (const sg of pick) {
      const x = clamp(sg.x - px, 0, 1), y = clamp(sg.y - py, 0, 1);
      state.items.push({
        id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        num: state.nextNum++, shape: 'rect',
        mode: $('defMode').value, strength: Number($('defStrength').value), color: $('defColor').value,
        x, y, w: Math.min(1 - x, sg.w + 2 * px), h: Math.min(1 - y, sg.h + 2 * py),
        start: sg.start, end: sg.end, auto: sg.cat
      });
    }
  });
  state.suggestions = state.suggestions.filter((s) => !s.checked);
  state.selSug = null; renderSuggestions();
  toast(`${pick.length} مورد به لیست بلور اضافه شد`);
};
renderSuggestions();
