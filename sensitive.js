// Classifies OCR lines into sensitive findings. Each finding gets a box that covers only
// the sensitive part of the line (estimated from character positions).

const CATS = {
  password: 'پسورد',
  credential: 'یوزر / مقدار فرم',
  secret: 'کلید / توکن',
  url: 'لینک',
  email: 'ایمیل',
  ip: 'IP',
  phone: 'تلفن',
  card: 'کارت بانکی',
  username: 'نام کاربری'
};

const TLD = 'com|net|org|io|ir|dev|app|ai|co|me|xyz|info|gov|edu|uk|de|fr|ru|cn|tv|gg|ly|so|sh|cloud|site|online|tech|store|link|page|biz|us|ca|au|in|nl|tr|ae|eu|local|lan';
const RE = {
  url: new RegExp(`\\b(?:https?:\\/\\/|www\\.)\\S+|\\b(?:[a-z0-9-]+\\.)+(?:${TLD})(?::\\d+)?(?:\\/\\S*)?`, 'gi'),
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  ip: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{2,5})?\b/g,
  phone: /(?:\+|\b00)\d[\d\s-]{8,16}\d\b|\b09\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g,
  card: /\b(?:\d[ -]?){13,19}\b/g,
  handle: /(^|\s)@[A-Za-z0-9_.]{3,30}\b/g,
  secretKnown: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|glpat-[A-Za-z0-9_-]{20}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,})/g,
  kv: /\b(password|passwd|pwd|pass|passcode|pin|secret|token|api[_ -]?key|apikey|access[_ -]?key|private[_ -]?key|auth|bearer|client[_ -]?secret)\b\s*[:=]\s*["']?(\S+)/gi
};
const LABEL_RE = /^(?:user\s?name|username|user|login|log in|e-?mail|email address|account|account id|password|passwd|pwd|pass|passcode|pin|token|api\s?key|secret|phone|mobile|رمز|رمز عبور|نام کاربری|ایمیل)\s*[:*]?\s*$/i;
const PASSWORD_LABEL_RE = /pass|pwd|pin|secret|token|key|رمز/i;
const MASK_CHARS = new Set(['•', '●', '*', '·', '∙', '⋅', '◦', '.', '°']);

function luhn(num) {
  let s = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) { let d = +num[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } s += d; alt = !alt; }
  return s % 10 === 0;
}
function entropy(s) {
  const m = new Map(); for (const ch of s) m.set(ch, (m.get(ch) || 0) + 1);
  let e = 0; for (const v of m.values()) { const p = v / s.length; e -= p * Math.log2(p); } return e;
}
function isMasked(t) {
  const s = t.replace(/\s/g, '');
  if (s.length < 4) return false;
  let k = 0; for (const ch of s) if (MASK_CHARS.has(ch)) k++;
  return k / s.length >= 0.8 && /[•●*·∙⋅◦]/.test(s);
}
function subBox(d, start, end) {
  const len = Math.max(1, d.text.length), cw = d.w / len;
  const x0 = d.x + Math.max(0, start - 0.9) * cw, x1 = d.x + Math.min(len, end + 0.9) * cw;
  return { x: x0, y: d.y, w: Math.max(4, x1 - x0), h: d.h };
}

/** lines: [{x,y,w,h,text,score}] -> findings [{cat, text, x,y,w,h}] */
function classify(lines, minScore = 0.6) {
  const out = [];
  const L = lines.filter((d) => d.score >= minScore && d.text.trim().length >= 2);
  const used = new Set();
  const add = (cat, d, s, e, text) => { out.push({ cat, text, ...(s === 0 && e >= d.text.length ? { x: d.x, y: d.y, w: d.w, h: d.h } : subBox(d, s, e)) }); };

  L.forEach((d, i) => {
    const t = d.text;
    if (isMasked(t)) { add('password', d, 0, t.length, t); used.add(i); return; }
    const taken = [];
    const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);
    const scan = (re, cat, valid = () => true, group = 0) => {
      re.lastIndex = 0; let m;
      while ((m = re.exec(t))) {
        let s = m.index, val = m[0];
        if (group) { val = m[group]; s = m.index + m[0].lastIndexOf(val); }
        const e = s + val.length;
        if (!val || overlaps(s, e) || !valid(val)) continue;
        taken.push([s, e]); add(cat, d, s, e, val); used.add(i);
      }
    };
    scan(RE.kv, 'password', (v) => v.length >= 2, 2);
    scan(RE.secretKnown, 'secret');
    scan(RE.email, 'email');
    scan(RE.url, 'url', (v) => v.length >= 6 && !/^\d+(\.\d+)+$/.test(v));
    scan(RE.ip, 'ip');
    scan(RE.card, 'card', (v) => { const n = v.replace(/\D/g, ''); return n.length >= 13 && n.length <= 19 && luhn(n); });
    scan(RE.phone, 'phone');
    scan(RE.handle, 'username', (v) => !v.includes('..'));
    // generic high-entropy tokens
    const tokRe = /[A-Za-z0-9_\-+/=]{20,}/g; let m;
    while ((m = tokRe.exec(t))) {
      const v = m[0], s = m.index, e = s + v.length;
      if (overlaps(s, e)) continue;
      if (/\d/.test(v) && /[A-Za-z]/.test(v) && entropy(v) >= 3.5) { taken.push([s, e]); add('secret', d, s, e, v); used.add(i); }
    }
  });

  // values next to labels like "Username" / "Password"
  L.forEach((lab, i) => {
    if (!LABEL_RE.test(lab.text.trim())) return;
    const isPw = PASSWORD_LABEL_RE.test(lab.text);
    let best = null, bestDist = Infinity;
    L.forEach((v, j) => {
      if (j === i || LABEL_RE.test(v.text.trim())) return;
      const cyL = lab.y + lab.h / 2, cyV = v.y + v.h / 2;
      const sameLine = Math.abs(cyL - cyV) < Math.max(lab.h, v.h) * 0.6 && v.x >= lab.x + lab.w - 4 && v.x - (lab.x + lab.w) < lab.h * 14;
      const below = v.y >= lab.y + lab.h * 0.5 && v.y - (lab.y + lab.h) < lab.h * 3 && Math.abs(v.x - lab.x) < lab.h * 6;
      if (!sameLine && !below) return;
      const dist = sameLine ? v.x - (lab.x + lab.w) : (v.y - lab.y) * 1.5;
      if (dist < bestDist) { bestDist = dist; best = v; }
    });
    if (best && !out.some((f) => f.text === best.text && Math.abs(f.y - best.y) < 2)) {
      out.push({ cat: isPw ? 'password' : 'credential', text: best.text, x: best.x, y: best.y, w: best.w, h: best.h });
    }
  });
  return out;
}

module.exports = { classify, CATS };
