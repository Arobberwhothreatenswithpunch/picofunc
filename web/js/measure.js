// 自動測定と FFT (オシロの Measure / Math FFT 相当)
// 画面区間を等間隔サンプリングしたレコードから計算する。

export const MEAS_N = 16384;
export const FFT_N = 65536;

export const MEAS_TYPES = {
  freq:   { label: "周波数",     short: "Freq",  unit: "Hz" },
  period: { label: "周期",       short: "Prd",   unit: "s" },
  duty:   { label: "+デューティ", short: "Duty",  unit: "%" },
  pwidth: { label: "+パルス幅",   short: "+Wid",  unit: "s" },
  nwidth: { label: "−パルス幅",   short: "−Wid",  unit: "s" },
  vpp:    { label: "Vpp",        short: "Pk-Pk", unit: "V" },
  vmax:   { label: "最大",       short: "Max",   unit: "V" },
  vmin:   { label: "最小",       short: "Min",   unit: "V" },
  vavg:   { label: "平均",       short: "Avg",   unit: "V" },
  vrms:   { label: "実効値",     short: "RMS",   unit: "V" },
  vrmsac: { label: "実効値(AC)", short: "AC RMS", unit: "V" },
  phase:  { label: "位相差",     short: "Phase", unit: "°" },
};

// ch.v(t) を [t0, t0+tw) で n 点サンプリング
// avg > 1: 各サンプル区間を avg 点で平均 (FFT 用の簡易アンチエイリアス)
export function record(ch, t0, tw, n = MEAS_N, avg = 1) {
  const x = new Float64Array(n);
  const dt = tw / n;
  if (avg <= 1) {
    for (let i = 0; i < n; i++) x[i] = ch.v(t0 + i * dt);
  } else {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < avg; j++) s += ch.v(t0 + (i + (j + 0.5) / avg - 0.5) * dt);
      x[i] = s / avg;
    }
  }
  return { x, dt, t0, ch };
}

// 50% レベル・ヒステリシス 10% で立上り / 立下りを検出 (時刻は線形補間)
export function edges(rec) {
  const { x, dt } = rec;
  let lo = Infinity, hi = -Infinity;
  for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const res = { lo, hi, rises: [], falls: [], alias: false };
  const pp = hi - lo;
  if (!(pp > 1e-9)) return res;
  const mid = (hi + lo) / 2, h = pp * 0.1;
  let state = x[0] > mid ? 1 : 0, lastBelow = -1, lastAbove = -1;
  // サンプル間の交差点: 元の関数があれば二分法で精密化 (シミュレーションなので厳密に求まる)
  const ch = rec.ch;
  const cross = (k) => {
    if (!ch) return (k + (mid - x[k]) / (x[k + 1] - x[k])) * dt;
    let a = rec.t0 + k * dt, b = a + dt;
    const up = x[k + 1] > x[k];
    for (let i = 0; i < 32; i++) {
      const m = (a + b) / 2;
      if ((ch.v(m) >= mid) === up) b = m; else a = m;
    }
    return (a + b) / 2 - rec.t0;
  };
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v < mid) lastBelow = i; else lastAbove = i;
    if (state === 0 && v >= mid + h && lastBelow >= 0) { res.rises.push(cross(lastBelow)); state = 1; }
    else if (state === 1 && v <= mid - h && lastAbove >= 0) { res.falls.push(cross(lastAbove)); state = 0; }
  }
  // 1 周期あたり 6 点未満 = エイリアシング (実機同様に測定不可)
  res.alias = res.rises.length > x.length / 6 || (ch && ch.period > 0 && ch.period < 6 * dt);
  return res;
}

function cyclesRange(rec, e) {
  // 立上りから立上りまでの整数周期区間 (なければ全画面)
  if (e.rises.length >= 2 && !e.alias) {
    const a = Math.round(e.rises[0] / rec.dt), b = Math.round(e.rises[e.rises.length - 1] / rec.dt);
    if (b - a > 8) return [a, b];
  }
  return [0, rec.x.length];
}

export function measure(type, rec, rec2) {
  const e = edges(rec);
  const { x } = rec;
  const period = () => {
    if (e.alias || e.rises.length < 2) return NaN;
    return (e.rises[e.rises.length - 1] - e.rises[0]) / (e.rises.length - 1);
  };
  const highTimes = () => {
    const hs = [];
    for (let i = 0; i + 1 < e.rises.length; i++) {
      const f = e.falls.find((t) => t > e.rises[i] && t < e.rises[i + 1]);
      if (f !== undefined) hs.push(f - e.rises[i]);
    }
    return hs;
  };
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  switch (type) {
    case "vmax": return e.hi;
    case "vmin": return e.lo;
    case "vpp": return e.hi - e.lo;
    case "vavg": case "vrms": case "vrmsac": {
      const [a, b] = cyclesRange(rec, e);
      let s = 0, s2 = 0;
      for (let i = a; i < b; i++) { s += x[i]; s2 += x[i] * x[i]; }
      const n = b - a, m = s / n;
      if (type === "vavg") return m;
      if (type === "vrms") return Math.sqrt(s2 / n);
      return Math.sqrt(Math.max(s2 / n - m * m, 0));
    }
    case "period": return period();
    case "freq": { const p = period(); return 1 / p; }
    case "duty": case "pwidth": case "nwidth": {
      const p = period();
      const hs = highTimes();
      if (!isFinite(p) || !hs.length) return NaN;
      const hw = avg(hs);
      if (type === "duty") return hw / p * 100;
      return type === "pwidth" ? hw : p - hw;
    }
    case "phase": {
      if (!rec2) return NaN;
      const e2 = edges(rec2);
      const p = period();
      if (!isFinite(p) || e2.alias || !e2.rises.length) return NaN;
      const ta = e.rises[0];
      const tb = e2.rises.find((t) => t >= ta) ?? NaN;
      if (!isFinite(tb)) return NaN;
      return (((tb - ta) / p) * 360 % 360 + 360) % 360;
    }
  }
  return NaN;
}

// ---------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------
export const WINDOWS = {
  hann: { label: "Hann" },
  rect: { label: "矩形" },
  flattop: { label: "Flat top" },
  bh: { label: "Blackman-Harris" },
};

function windowFn(name, n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / (n - 1);
    switch (name) {
      case "rect": w[i] = 1; break;
      case "flattop": w[i] = 0.21557895 - 0.41663158 * Math.cos(a) + 0.277263158 * Math.cos(2 * a)
                           - 0.083578947 * Math.cos(3 * a) + 0.006947368 * Math.cos(4 * a); break;
      case "bh": w[i] = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a); break;
      default: w[i] = 0.5 - 0.5 * Math.cos(a);
    }
  }
  return w;
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// 振幅スペクトル (dBV, 正弦波の実効値基準: 1 Vrms = 0 dBV)
const LOBE = { rect: 1, hann: 2, bh: 4, flattop: 5 };   // DC の主ローブ幅 (bin)

export function spectrum(rec, winName = "hann") {
  const n = rec.x.length;
  const w = windowFn(winName, n);
  let cg = 0;
  for (const v of w) cg += v;
  cg /= n;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = rec.x[i] * w[i];
  fftInPlace(re, im);
  const half = n / 2;
  const db = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    let a = Math.hypot(re[k], im[k]) / (n * cg);
    a = k === 0 ? a : (2 * a) / Math.SQRT2;   // DC はそのまま、それ以外は実効値
    db[k] = 20 * Math.log10(Math.max(a, 1e-12));
  }
  return { db, df: 1 / (rec.dt * n), fmax: 1 / (2 * rec.dt), skip: LOBE[winName] || 2 };
}

// 上位ピーク (局所最大、近接は除外、放物線補間で周波数を補正)
export function peaks(sp, count = 5, fLimit = Infinity, floorDb = -100) {
  const { db, df } = sp;
  const cand = [];
  const kmax = Math.min(db.length - 2, Math.floor(fLimit / df));
  for (let k = Math.max(1, sp.skip || 1); k <= kmax; k++) {   // DC の主ローブは除外
    if (db[k] > floorDb && db[k] >= db[k - 1] && db[k] > db[k + 1]) cand.push(k);
  }
  cand.sort((a, b) => db[b] - db[a]);
  const out = [];
  for (const k of cand) {
    if (out.some((p) => Math.abs(p.k - k) < 6)) continue;
    const a = db[k - 1], b = db[k], c = db[k + 1];
    const d = (a - c) / (2 * (a - 2 * b + c)) || 0;
    out.push({ k, f: (k + d) * df, db: b - ((a - c) * d) / 4 });
    if (out.length >= count) break;
  }
  return out;
}
