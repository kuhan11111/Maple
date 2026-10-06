// Name-tag tracking by normalised cross-correlation on a grayscale copy of the frame.
//
// Each player's name tag is cut out once as a template. Every frame we search near where it
// was last seen on a half-resolution image (cheap), then refine at full resolution. A global
// search over the whole frame is available for re-acquiring a lost tag.

export function toGray(rgba, n, out) {
  const g = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  return g;
}

function halve(src, W, H, out) {
  const w2 = W >> 1;
  const h2 = H >> 1;
  const dst = out && out.length === w2 * h2 ? out : new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    let a = 2 * y * W;
    let b = a + W;
    for (let x = 0; x < w2; x++, a += 2, b += 2) dst[y * w2 + x] = (src[a] + src[a + 1] + src[b] + src[b + 1]) / 4;
  }
  return dst;
}

function zeroMean(data) {
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length;
  const out = new Float32Array(data.length);
  let ss = 0;
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] - mean;
    ss += out[i] * out[i];
  }
  return { data: out, norm: Math.sqrt(ss) };
}

/** Cut a template out of a gray frame. Coordinates are snapped to even pixels. */
export function makeTemplate(gray, W, H, rect) {
  const x = Math.max(0, Math.min(W - 8, rect.x & ~1));
  const y = Math.max(0, Math.min(H - 8, rect.y & ~1));
  const w = Math.min(W - x, rect.w) & ~1;
  const h = Math.min(H - y, rect.h) & ~1;
  if (w < 8 || h < 6) return null;
  const raw = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) raw[j * w + i] = gray[(y + j) * W + x + i];
  return { ...buildTemplate(raw, w, h), x, y };
}

/** Rebuild a template from its raw gray bytes (used when restoring from storage). */
export function buildTemplate(raw, w, h) {
  const full = zeroMean(raw);
  const half = zeroMean(halve(raw, w, h));
  return { raw, w, h, full, half, w2: w >> 1, h2: h >> 1 };
}

export class Tracker {
  constructor() {
    this.W = 0;
    this.H = 0;
  }

  /** Load a new frame (RGBA ImageData bytes or an already-gray Uint8Array). */
  setFrame(pixels, W, H, isGray = false) {
    const n = W * H;
    this.gray = isGray ? pixels : toGray(pixels, n, this._gray);
    if (!isGray) this._gray = this.gray;
    this.W = W;
    this.H = H;
    const w2 = W >> 1;
    const h2 = H >> 1;
    this.half = halve(this.gray, W, H, this.half);
    this.W2 = w2;
    this.H2 = h2;
    const iw = w2 + 1;
    if (!this.sum || this.sum.length !== iw * (h2 + 1)) {
      this.sum = new Float64Array(iw * (h2 + 1));
      this.sq = new Float64Array(iw * (h2 + 1));
    }
    const { sum, sq, half } = this;
    for (let y = 0; y < h2; y++) {
      let rs = 0;
      let rq = 0;
      for (let x = 0; x < w2; x++) {
        const v = half[y * w2 + x];
        rs += v;
        rq += v * v;
        sum[(y + 1) * iw + x + 1] = sum[y * iw + x + 1] + rs;
        sq[(y + 1) * iw + x + 1] = sq[y * iw + x + 1] + rq;
      }
    }
  }

  // best match of the half-res template with top-left in [x0..x1] x [y0..y1] (half-res px)
  #searchHalf(tpl, x0, y0, x1, y1) {
    const { half, W2: w2, sum, sq } = this;
    const iw = w2 + 1;
    const { w2: tw, h2: th } = tpl;
    const T = tpl.half.data;
    const norm = tpl.half.norm;
    const N = tw * th;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(w2 - tw, x1);
    y1 = Math.min(this.H2 - th, y1);
    let best = { x: 0, y: 0, score: -1 };
    if (norm < 1e-6) return best;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const s = sum[(y + th) * iw + x + tw] - sum[y * iw + x + tw] - sum[(y + th) * iw + x] + sum[y * iw + x];
        const q = sq[(y + th) * iw + x + tw] - sq[y * iw + x + tw] - sq[(y + th) * iw + x] + sq[y * iw + x];
        const varI = q - (s * s) / N;
        if (varI < 4 * N) continue; // flat region
        let dot = 0;
        for (let j = 0; j < th; j++) {
          let ii = (y + j) * w2 + x;
          let ti = j * tw;
          for (let i = 0; i < tw; i++) dot += half[ii++] * T[ti++];
        }
        const score = dot / (Math.sqrt(varI) * norm);
        if (score > best.score) best = { x, y, score };
      }
    }
    return best;
  }

  // exact full-resolution NCC at one top-left position
  #nccFull(tpl, x, y) {
    const { gray, W } = this;
    const { w, h } = tpl;
    const T = tpl.full.data;
    let s = 0;
    let q = 0;
    let dot = 0;
    for (let j = 0; j < h; j++) {
      let ii = (y + j) * W + x;
      let ti = j * w;
      for (let i = 0; i < w; i++) {
        const v = gray[ii++];
        s += v;
        q += v * v;
        dot += v * T[ti++];
      }
    }
    const N = w * h;
    const varI = q - (s * s) / N;
    if (varI < 4 * N || tpl.full.norm < 1e-6) return -1;
    return dot / (Math.sqrt(varI) * tpl.full.norm);
  }

  /** NCC of the template with its top-left at exactly (x, y); -1 when outside the frame. */
  score(tpl, x, y) {
    if (!this.gray || !tpl || x < 0 || y < 0 || x + tpl.w > this.W || y + tpl.h > this.H) return -1;
    return this.#nccFull(tpl, x, y);
  }

  /**
   * Find the template. `hint` = {x, y} top-left where it was last seen; search ±radius
   * around it. Without a hint (or with global=true) the whole region is searched.
   * Returns {x, y, score} in full-resolution pixels, or null.
   */
  find(tpl, { hint = null, radius = 90, global = false, region = null } = {}) {
    if (!this.gray || !tpl) return null;
    let coarse;
    if (hint && !global) {
      const hx = hint.x >> 1;
      const hy = hint.y >> 1;
      const r = Math.ceil(radius / 2);
      coarse = this.#searchHalf(tpl, hx - r, hy - r, hx + r, hy + r);
    } else {
      const rg = region ?? { x: 0, y: 0, w: this.W, h: this.H };
      coarse = this.#searchHalf(tpl, rg.x >> 1, rg.y >> 1, (rg.x + rg.w) >> 1, (rg.y + rg.h) >> 1);
    }
    if (coarse.score < 0.3) return null;
    let best = { x: coarse.x * 2, y: coarse.y * 2, score: -1 };
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = coarse.x * 2 + dx;
        const y = coarse.y * 2 + dy;
        if (x < 0 || y < 0 || x + tpl.w > this.W || y + tpl.h > this.H) continue;
        const score = this.#nccFull(tpl, x, y);
        if (score > best.score) best = { x, y, score };
      }
    }
    return best.score < 0 ? null : best;
  }
}
