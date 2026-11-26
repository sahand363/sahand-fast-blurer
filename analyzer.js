// Worker thread: samples frames with FFmpeg, runs OCR on frames that changed,
// classifies sensitive text and tracks it over time.
const { parentPort, workerData } = require('worker_threads');
const { spawn } = require('child_process');
const { OCR } = require('./ocr');
const { classify } = require('./sensitive');

const { ffmpeg, input, width, height, duration, interval = 0.5, modelDir, cats, maxSide = 1920, preferGpu = true } = workerData;

let proc = null, stopped = false;
parentPort.on('message', (m) => { if (m === 'cancel') { stopped = true; if (proc) proc.kill('SIGKILL'); } });

const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i || 1);
};
const union = (a, b) => {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
};
const norm = (s) => s.replace(/\s+/g, '').toLowerCase();

async function main() {
  const s = Math.min(1, maxSide / Math.max(width, height));
  const FW = Math.max(32, Math.round((width * s) / 32) * 32), FH = Math.max(32, Math.round((height * s) / 32) * 32);
  const sx = width / FW, sy = height / FH;
  const frameSize = FW * FH * 3;

  const ocr = await OCR.create(modelDir, { preferGpu });
  const fps = 1 / interval;
  const args = ['-hide_banner', '-loglevel', 'error', '-hwaccel', 'auto', '-i', input,
    '-an', '-sn', '-vf', `fps=${fps},scale=${FW}:${FH}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1'];
  proc = spawn(ffmpeg, args, { windowsHide: true });
  let errTail = '';
  proc.stderr.on('data', (b) => { errTail = (errTail + b).slice(-2000); });

  // change detection on a small grayscale thumbnail
  const TW = Math.floor(FW / 4), TH = Math.floor(FH / 4);
  let refThumb = null;
  const thumb = (f) => {
    const t = new Uint8Array(TW * TH);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const p = ((y * 4) * FW + x * 4) * 3; t[y * TW + x] = (f[p] * 29 + f[p + 1] * 150 + f[p + 2] * 77) >> 8;
    }
    return t;
  };
  const changed = (t) => {
    if (!refThumb) return true;
    let c = 0; const lim = TW * TH * 0.001;
    for (let i = 0; i < t.length; i++) if (Math.abs(t[i] - refThumb[i]) > 30 && ++c > lim) return true;
    return false;
  };

  const active = [], done = [];
  let idx = 0, ocrCount = 0, nextId = 1;
  const started = Date.now();

  const processFrame = async (frame, t) => {
    const th = thumb(frame);
    if (!changed(th)) {
      // same picture as the last OCR'd frame: visible things stay, missed things are gone
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].miss) { done.push(active[i]); active.splice(i, 1); } else active[i].lastT = t;
      }
      return;
    }
    refThumb = th; ocrCount++;
    const lines = await ocr.run(frame, FW, FH);
    const scaled = lines.map((d) => ({ ...d, x: d.x * sx, y: d.y * sy, w: d.w * sx, h: d.h * sy }));
    const finds = classify(scaled).filter((f) => !cats || cats.includes(f.cat));
    const matched = new Set();
    for (const f of finds) {
      let best = null, bs = 0;
      for (const tr of active) {
        if (tr.cat !== f.cat || matched.has(tr)) continue;
        let sc = iou(tr.lastBox, f);
        if (norm(tr.text) === norm(f.text)) sc += 0.3;
        if (sc > bs) { bs = sc; best = tr; }
      }
      const box = { x: f.x, y: f.y, w: f.w, h: f.h };
      if (best && bs > 0.3) {
        best.lastBox = box; best.box = union(best.box, box); best.lastT = t; best.miss = 0;
        if (f.text.length > best.text.length) best.text = f.text;
        matched.add(best);
      } else {
        const tr = { id: nextId++, cat: f.cat, text: f.text, box, lastBox: box, firstT: t, lastT: t, miss: 0 };
        active.push(tr); matched.add(tr);
      }
    }
    for (let i = active.length - 1; i >= 0; i--) {
      const tr = active[i];
      if (matched.has(tr)) continue;
      if (++tr.miss >= 2) { done.push(tr); active.splice(i, 1); }
    }
    parentPort.postMessage({ type: 'found', count: done.length + active.length });
  };

  const frameBuf = new Uint8Array(frameSize);
  let filled = 0;
  for await (const chunk of proc.stdout) {
    if (stopped) break;
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(frameSize - filled, chunk.length - off);
      frameBuf.set(chunk.subarray(off, off + n), filled);
      filled += n; off += n;
      if (filled === frameSize) {
        filled = 0;
        const t = idx * interval;
        await processFrame(frameBuf, t);
        idx++;
        if (idx % 2 === 0) {
          const p = Math.min(1, t / duration), el = (Date.now() - started) / 1000;
          parentPort.postMessage({ type: 'progress', progress: p, t, ocrFrames: ocrCount, eta: p > 0.01 ? el / p - el : null, found: done.length + active.length });
        }
        if (stopped) break;
      }
    }
    if (stopped) break;
  }
  if (stopped) { parentPort.postMessage({ type: 'cancelled' }); return; }
  await new Promise((r) => (proc.exitCode !== null ? r() : proc.on('close', r)));
  if (proc.exitCode && idx === 0) throw new Error(errTail || 'ffmpeg failed');
  done.push(...active);

  // merge fragments of the same thing separated by short gaps
  done.sort((a, b) => a.firstT - b.firstT);
  const merged = [];
  for (const tr of done) {
    const m = merged.find((o) => o.cat === tr.cat && tr.firstT - o.lastT <= 1.5 && (iou(o.box, tr.box) > 0.4 || norm(o.text) === norm(tr.text)));
    if (m) { m.box = union(m.box, tr.box); m.lastT = Math.max(m.lastT, tr.lastT); if (tr.text.length > m.text.length) m.text = tr.text; }
    else merged.push({ ...tr });
  }

  const results = merged.map((tr, i) => ({
    id: 's' + (i + 1), cat: tr.cat, text: tr.text,
    start: Math.max(0, tr.firstT - interval), end: Math.min(duration, tr.lastT + interval),
    x: tr.box.x / width, y: tr.box.y / height, w: tr.box.w / width, h: tr.box.h / height
  }));
  parentPort.postMessage({ type: 'done', results, ocrFrames: ocrCount, frames: idx, seconds: (Date.now() - started) / 1000 });
}

main().catch((e) => parentPort.postMessage({ type: 'error', message: String(e && e.message || e) }));
