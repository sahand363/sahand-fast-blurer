// Builds an FFmpeg filter graph from redaction items and runs the export.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const even = (n) => Math.max(0, Math.floor(n / 2) * 2);

function itemRect(it, W, H) {
  let x = even(it.x * W), y = even(it.y * H);
  let w = even(it.w * W), h = even(it.h * H);
  if (x >= W - 2 || y >= H - 2) return null;
  if (x + w > W) w = even(W - x);
  if (y + h > H) h = even(H - y);
  if (w < 4 || h < 4) return null;
  return { x, y, w, h };
}

function effectFor(it, r) {
  const s = Math.max(1, Number(it.strength) || 20);
  if (it.mode === 'color') {
    const hex = (it.color || '#000000').replace('#', '');
    return `drawbox=x=0:y=0:w=iw:h=ih:color=0x${hex}@1:t=fill`;
  }
  if (it.mode === 'pixelate') {
    const k = Math.max(2, s);
    const sw = Math.max(1, Math.round(r.w / k));
    const sh = Math.max(1, Math.round(r.h / k));
    return `scale=${sw}:${sh}:flags=area,scale=${r.w}:${r.h}:flags=neighbor`;
  }
  // blur
  const m = Math.min(r.w, r.h);
  const lr = Math.max(1, Math.min(s, Math.floor(m / 2) - 1));
  const cr = Math.max(0, Math.min(Math.round(lr / 2), Math.floor(m / 4) - 1));
  return `boxblur=${lr}:2:${cr}:2`;
}

const ELLIPSE_MASK =
  "format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':" +
  "a='if(lte(pow((X-W/2+0.5)/(W/2),2)+pow((Y-H/2+0.5)/(H/2),2),1),255,0)'";

function buildFilterGraph(items, W, H, duration) {
  const lines = [];
  let cur = '[0:v]';
  let n = 0;
  for (const it of items) {
    if (it.hidden) continue;
    const S = Math.max(0, Number(it.start));
    const E = Math.min(duration || Infinity, Number(it.end));
    if (!(E > S)) continue;
    const r = itemRect(it, W, H);
    if (!r) continue;
    const s3 = S.toFixed(3), e3 = E.toFixed(3);
    const mask = it.shape === 'ellipse' ? ',' + ELLIPSE_MASK : '';
    lines.push(`${cur}split=2[b${n}][s${n}]`);
    lines.push(`[s${n}]trim=start=${s3}:end=${e3},crop=${r.w}:${r.h}:${r.x}:${r.y},${effectFor(it, r)}${mask}[e${n}]`);
    const out = `[v${n + 1}]`;
    lines.push(`[b${n}][e${n}]overlay=${r.x}:${r.y}:eof_action=pass:enable='between(t,${s3},${e3})'${out}`);
    cur = out;
    n++;
  }
  if (n === 0) return null;
  lines.push(`${cur}format=yuv420p[vout]`);
  return lines.join(';\n');
}

// quality levels: lower number = higher quality
const Q = {
  balanced: { crf: 20, x264: 'veryfast', nv: 'p4', cq: 21 },
  high: { crf: 16, x264: 'fast', nv: 'p6', cq: 17 },
  max: { crf: 12, x264: 'medium', nv: 'p7', cq: 13 }
};
function encoderArgs(enc, quality) {
  const q = Q[quality] || Q.high;
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', q.nv, '-tune', 'hq', '-rc', 'vbr', '-cq', String(q.cq), '-b:v', '0', '-spatial-aq', '1'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-global_quality', String(q.cq), '-preset', 'slow'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q.cq - 2), '-qp_p', String(q.cq)];
    default: return ['-c:v', 'libx264', '-preset', q.x264, '-crf', String(q.crf)];
  }
}

let cachedHw = undefined;
function detectHwEncoder(ffmpeg) {
  if (cachedHw !== undefined) return cachedHw;
  cachedHw = null;
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    try {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'color=c=black:s=256x256:d=0.2', '-c:v', enc, '-f', 'null', '-'], { timeout: 15000, windowsHide: true });
      if (r.status === 0) { cachedHw = enc; break; }
    } catch (_) { /* ignore */ }
  }
  return cachedHw;
}

class ExportJob {
  constructor(opts, onProgress) {
    this.opts = opts; // { ffmpeg, input, output, items, width, height, duration, encoder: 'auto'|'cpu' }
    this.onProgress = onProgress;
    this.proc = null;
    this.cancelled = false;
  }

  run() {
    const { ffmpeg, items, width, height, duration, encoder } = this.opts;
    const graph = buildFilterGraph(items, width, height, duration);
    if (!graph) return Promise.reject(new Error('هیچ مورد معتبری برای خروجی وجود ندارد.'));
    this.scriptPath = path.join(os.tmpdir(), `blurstudio-${Date.now()}.txt`);
    fs.writeFileSync(this.scriptPath, graph, 'utf8');
    const hw = encoder === 'cpu' ? null : detectHwEncoder(ffmpeg);
    const order = hw ? [hw, 'libx264'] : ['libx264'];
    const attempt = (i) => this._runWith(order[i]).catch((err) => {
      if (this.cancelled || i + 1 >= order.length) throw err;
      this.onProgress({ note: `انکودر ${order[i]} خطا داد، با CPU ادامه می‌دهم…` });
      return attempt(i + 1);
    });
    return attempt(0).finally(() => { try { fs.unlinkSync(this.scriptPath); } catch (_) {} });
  }

  _runWith(enc) {
    const { ffmpeg, input, output, duration } = this.opts;
    const args = ['-hide_banner', '-y', '-i', input,
      '-/filter_complex', this.scriptPath,
      '-map', '[vout]', '-map', '0:a?',
      ...encoderArgs(enc, this.opts.quality), '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats', output];
    return new Promise((resolve, reject) => {
      const started = Date.now();
      this.proc = spawn(ffmpeg, args, { windowsHide: true });
      let errTail = '';
      this.proc.stdout.on('data', (buf) => {
        const m = /out_time_us=(\d+)/g; let mm, last = null;
        const s = buf.toString();
        while ((mm = m.exec(s))) last = mm[1];
        if (last && duration) {
          const t = Number(last) / 1e6;
          const p = Math.min(1, t / duration);
          const el = (Date.now() - started) / 1000;
          const eta = p > 0.01 ? el / p - el : null;
          this.onProgress({ progress: p, encoder: enc, eta });
        }
      });
      this.proc.stderr.on('data', (b) => { errTail = (errTail + b.toString()).slice(-4000); });
      this.proc.on('error', reject);
      this.proc.on('close', (code) => {
        this.proc = null;
        if (this.cancelled) return reject(new Error('cancelled'));
        if (code === 0) return resolve({ encoder: enc });
        reject(new Error(errTail.split('\n').filter(Boolean).slice(-6).join('\n') || `ffmpeg exit ${code}`));
      });
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.proc) {
      try { this.proc.stdin.write('q'); } catch (_) {}
      setTimeout(() => { if (this.proc) this.proc.kill('SIGKILL'); }, 1500);
    }
  }
}

module.exports = { buildFilterGraph, ExportJob, detectHwEncoder };
