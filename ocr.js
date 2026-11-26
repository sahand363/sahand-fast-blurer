// PP-OCRv5 (mobile det + English rec) running on ONNX Runtime. No Python needed.
const ort = require('onnxruntime-node');
const fs = require('fs');
const path = require('path');

const DET_MEAN = [0.485, 0.456, 0.406], DET_STD = [0.229, 0.224, 0.225];
const DET_THRESH = 0.3, BOX_THRESH = 0.6, UNCLIP = 1.5, MIN_SIZE = 3;
const REC_H = 48, REC_MAX_W = 3200, REC_BATCH = 16;

class OCR {
  static async create(modelDir, { preferGpu = true } = {}) {
    const o = new OCR();
    const eps = [];
    if (preferGpu && process.platform === 'win32') eps.push('dml');
    eps.push('cpu');
    const opts = { executionProviders: eps, logSeverityLevel: 3, graphOptimizationLevel: 'all' };
    const tryCreate = async (file) => {
      try { return await ort.InferenceSession.create(path.join(modelDir, file), opts); }
      catch (e) { return await ort.InferenceSession.create(path.join(modelDir, file), { ...opts, executionProviders: ['cpu'] }); }
    };
    o.det = await tryCreate('det.onnx');
    o.rec = await tryCreate('rec.onnx');
    o.dict = JSON.parse(fs.readFileSync(path.join(modelDir, 'rec_dict.json'), 'utf8'));
    o.dict.push(' ');
    return o;
  }

  /** frame: Uint8Array BGR (w*h*3), w and h multiples of 32. Returns [{x,y,w,h,text,score}] in frame px. */
  async run(frame, w, h) {
    const boxes = await this.detect(frame, w, h);
    if (!boxes.length) return [];
    const texts = await this.recognize(frame, w, h, boxes);
    const out = [];
    for (let i = 0; i < boxes.length; i++) if (texts[i].text.trim()) out.push({ ...boxes[i], ...texts[i] });
    return out;
  }

  async detect(frame, w, h) {
    const n = w * h, data = new Float32Array(3 * n);
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      data[i] = (frame[p] / 255 - DET_MEAN[0]) / DET_STD[0];
      data[n + i] = (frame[p + 1] / 255 - DET_MEAN[1]) / DET_STD[1];
      data[2 * n + i] = (frame[p + 2] / 255 - DET_MEAN[2]) / DET_STD[2];
    }
    const res = await this.det.run({ [this.det.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, h, w]) });
    const out = res[this.det.outputNames[0]];
    const [, , oh, ow] = out.dims;
    return dbPostprocess(out.data, ow, oh, w / ow, h / oh);
  }

  async recognize(frame, fw, fh, boxes) {
    const order = boxes.map((b, i) => i).sort((a, b) => boxes[a].w / boxes[a].h - boxes[b].w / boxes[b].h);
    const results = new Array(boxes.length);
    for (let s = 0; s < order.length; s += REC_BATCH) {
      const idx = order.slice(s, s + REC_BATCH);
      const maxRatio = Math.max(320 / REC_H, ...idx.map((i) => boxes[i].w / Math.max(1, boxes[i].h)));
      const W = Math.min(REC_MAX_W, Math.ceil(REC_H * maxRatio / 8) * 8);
      const data = new Float32Array(idx.length * 3 * REC_H * W); // zeros = padding
      idx.forEach((bi, k) => {
        const b = boxes[bi];
        const tw = Math.min(W, Math.max(1, Math.ceil(REC_H * b.w / Math.max(1, b.h))));
        cropResizeNorm(frame, fw, fh, b, tw, REC_H, data, k * 3 * REC_H * W, W);
      });
      const res = await this.rec.run({ [this.rec.inputNames[0]]: new ort.Tensor('float32', data, [idx.length, 3, REC_H, W]) });
      const out = res[this.rec.outputNames[0]];
      const [, T, C] = out.dims;
      idx.forEach((bi, k) => { results[bi] = ctcDecode(out.data, k * T * C, T, C, this.dict); });
    }
    return results;
  }
}

function dbPostprocess(prob, w, h, sx, sy) {
  const n = w * h, labels = new Int32Array(n), stack = new Int32Array(n);
  const boxes = [];
  let label = 0;
  for (let start = 0; start < n; start++) {
    if (labels[start] || prob[start] <= DET_THRESH) continue;
    label++;
    let sp = 0; stack[sp++] = start; labels[start] = label;
    let minx = w, miny = h, maxx = 0, maxy = 0, sum = 0, cnt = 0;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p - x) / w;
      sum += prob[p]; cnt++;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0 && !labels[p - 1] && prob[p - 1] > DET_THRESH) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && !labels[p + 1] && prob[p + 1] > DET_THRESH) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (y > 0 && !labels[p - w] && prob[p - w] > DET_THRESH) { labels[p - w] = label; stack[sp++] = p - w; }
      if (y < h - 1 && !labels[p + w] && prob[p + w] > DET_THRESH) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (Math.min(bw, bh) < MIN_SIZE) continue;
    if (sum / cnt < BOX_THRESH) continue;
    const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
    const x0 = Math.max(0, minx - d), y0 = Math.max(0, miny - d);
    const x1 = Math.min(w, maxx + 1 + d), y1 = Math.min(h, maxy + 1 + d);
    boxes.push({ x: x0 * sx, y: y0 * sy, w: (x1 - x0) * sx, h: (y1 - y0) * sy, detScore: sum / cnt });
  }
  return boxes;
}

function cropResizeNorm(frame, fw, fh, b, tw, th, out, offset, W) {
  const plane = th * W;
  const bx = b.x, by = b.y, sxr = b.w / tw, syr = b.h / th;
  for (let y = 0; y < th; y++) {
    const fy = Math.min(fh - 1, Math.max(0, by + (y + 0.5) * syr - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(fh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = Math.min(fw - 1, Math.max(0, bx + (x + 0.5) * sxr - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(fw - 1, x0 + 1), wx = fx - x0;
      const p00 = (y0 * fw + x0) * 3, p01 = (y0 * fw + x1) * 3, p10 = (y1 * fw + x0) * 3, p11 = (y1 * fw + x1) * 3;
      for (let c = 0; c < 3; c++) {
        const v = (frame[p00 + c] * (1 - wx) + frame[p01 + c] * wx) * (1 - wy) + (frame[p10 + c] * (1 - wx) + frame[p11 + c] * wx) * wy;
        out[offset + c * plane + y * W + x] = (v / 255 - 0.5) / 0.5;
      }
    }
  }
}

function ctcDecode(data, off, T, C, dict) {
  let text = '', last = -1, sum = 0, cnt = 0;
  for (let t = 0; t < T; t++) {
    let best = 0, bv = -Infinity;
    const base = off + t * C;
    for (let c = 0; c < C; c++) { const v = data[base + c]; if (v > bv) { bv = v; best = c; } }
    if (best !== 0 && best !== last) { text += dict[best - 1] ?? ''; sum += bv; cnt++; }
    last = best;
  }
  return { text, score: cnt ? sum / cnt : 0 };
}

module.exports = { OCR };
