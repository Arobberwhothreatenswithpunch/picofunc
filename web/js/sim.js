// 出力波形シミュレーション: ファームウェア (src/main.cpp) と同じ計算で実出力を予測する
// pc/scope.py の移植。定数・計算を変えるときは main.cpp / scope.py と揃えること。

export const SYS_HZ = 200e6;
export const VDD = 3.3;
export const PWM_F_MIN = 0.1, PWM_F_MAX = 25e6;
export const WAVE_TOP = 511, WAVE_FULL = WAVE_TOP + 1;
export const WAVE_N_MAX = 4096, WAVE_N_MIN = 16;
const EXACT_MAX_CYCLES = 20000;   // これ以下ならキャリア1周期ずつ厳密に RC を計算

const lround = (x) => Math.floor(x + 0.5);
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// ---------------------------------------------------------------------
// Python Fraction(x).limit_denominator(maxD) の厳密な再現 (BigInt)
// ---------------------------------------------------------------------
function floatToFraction(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (exp === 0) e = -1074;
  else { mant |= 1n << 52n; e = exp - 1075; }
  let n = mant, d = 1n;
  if (e >= 0) n <<= BigInt(e); else d <<= BigInt(-e);
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
  const g = gcd(n, d) || 1n;
  return [n / g, d / g];
}

function limitDenominator(x, maxD) {
  const [num, den] = floatToFraction(x);
  const M = BigInt(maxD);
  if (den <= M) return [Number(num), Number(den)];
  let p0 = 0n, q0 = 1n, p1 = 1n, q1 = 0n, n = num, d = den;
  for (;;) {
    const a = n / d;
    const q2 = q0 + a * q1;
    if (q2 > M) break;
    [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
    [n, d] = [d, n - a * d];
  }
  const k = (M - q0) / q1;
  if (2n * d * (q0 + k * q1) <= den) return [Number(p1), Number(q1)];
  return [Number(p0 + k * p1), Number(q0 + k * q1)];
}

// ---------------------------------------------------------------------
// firmware の再現
// ---------------------------------------------------------------------
export function calcPwm(freq, duty) {
  freq = clamp(freq, PWM_F_MIN, PWM_F_MAX);
  duty = clamp(duty, 0, 100);
  const hwMin = SYS_HZ / (65535 * (255 + 15 / 16));
  if (freq >= hwMin * 1.001) {
    const period = SYS_HZ / freq;
    let div16 = 16;
    if (period > 65535) div16 = Math.min(Math.ceil(period * 16 / 65535), 255 * 16 + 15);
    const top1 = clamp(lround(period * 16 / div16), 2, 65535);
    const level = lround(duty / 100 * top1);
    const f = SYS_HZ * 16 / div16 / top1;
    return { mode: "HW", f, duty: 100 * level / top1, steps: top1, period: 1 / f, high: level / top1 / f };
  }
  if (duty <= 0 || duty >= 100) {
    return { mode: "DC", f: freq, duty, steps: 0, period: 1 / freq, high: duty >= 100 ? 1 / freq : 0 };
  }
  const periodUs = lround(1e6 / freq);
  const hi = Math.max(lround(periodUs * duty / 100), 1);
  const lo = Math.max(periodUs - hi, 1);
  return { mode: "SW", f: 1e6 / (hi + lo), duty: 100 * hi / (hi + lo), steps: 0,
           period: (hi + lo) * 1e-6, high: hi * 1e-6 };
}

export function waveShape(kind, ph) {
  switch (kind) {
    case "SINE": return Math.sin(2 * Math.PI * ph);
    case "TRI": return ph < 0.25 ? 4 * ph : (ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4);
    case "SAW": return 2 * ph - 1;
    default: return ph < 0.5 ? 1 : -1;
  }
}

export function calcWave(kind, freq, amp, ofs) {
  amp = clamp(amp, 0, 100);
  ofs = clamp(ofs, 0, 100);
  const carrier = SYS_HZ / WAVE_FULL;
  freq = clamp(freq, SYS_HZ / 65535 / WAVE_N_MAX, carrier / WAVE_N_MIN);
  const n = clamp(Math.floor(carrier / freq), WAVE_N_MIN, WAVE_N_MAX);
  let [x, y] = limitDenominator(freq * n / SYS_HZ, 65535);
  if (x === 0) [x, y] = [1, 65535];
  const fs = SYS_HZ * x / y;
  const levels = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = clamp(ofs / 100 + amp / 200 * waveShape(kind, i / n), 0, 1);
    levels[i] = lround(v * WAVE_FULL);
  }
  return { f: fs / n, n, fs, carrier, levels };
}

// ---------------------------------------------------------------------
// CH2 出力の時間波形
// ---------------------------------------------------------------------
export function waveIdeal(w, tWin) {
  const { n, fs, levels } = w;
  const ts = [], vp = [], vn = [];
  const count = Math.ceil(tWin * fs) + 1;
  for (let k = 0; k < count; k++) {
    const d = levels[k % n] / WAVE_FULL;
    ts.push(k / fs, (k + 1) / fs);
    vp.push(d * VDD, d * VDD);
    vn.push((1 - d) * VDD, (1 - d) * VDD);
  }
  return { ts, vp, vn };
}

// 各ピン → R → C(GND) の1次 RC。区分一定入力を厳密解で更新
export function waveRc(w, rc, tWin) {
  const { n, fs, levels } = w;
  const period = n / fs;
  let sum = 0;
  for (const v of levels) sum += v;
  const avg = sum / n / WAVE_FULL;
  let vp = avg * VDD, vn = (1 - avg) * VDD;      // DC 平均から始めて収束を早める
  let settle = Math.min(Math.ceil(5 * rc / period), 50);
  const tc = WAVE_FULL / SYS_HZ;
  let tStart = settle * period;
  const tEnd = tStart + tWin;
  const ts = [], op = [], on = [];

  if (tEnd / tc <= EXACT_MAX_CYCLES) {
    // キャリア1周期ごと: High 区間 → Low 区間 (− 側は逆相)
    const cache = new Map();
    for (let c = 0; ; c++) {
      const t = c * tc;
      if (t > tEnd) break;
      const v = levels[Math.floor(t * fs) % n];
      let e = cache.get(v);
      if (!e) {
        const th = v / WAVE_FULL * tc;
        e = [th, Math.exp(-th / rc), Math.exp(-(tc - th) / rc)];
        cache.set(v, e);
      }
      const [th, eh, el] = e;
      if (t >= tStart) { ts.push(t - tStart); op.push(vp); on.push(vn); }
      vp = VDD + (vp - VDD) * eh;
      vn = vn * eh;
      if (t >= tStart) { ts.push(t + th - tStart); op.push(vp); on.push(vn); }
      vp = vp * el;
      vn = VDD + (vn - VDD) * el;
    }
  } else {
    // キャリアが速すぎる区間はサンプル単位の平均入力で近似 (リップルは省略)
    const dt = 1 / fs;
    const e = Math.exp(-dt / rc);
    settle = Math.min(settle, 5);
    tStart = settle * period;
    const total = Math.ceil((tStart + tWin) * fs) + 1;
    for (let k = 0; k < total; k++) {
      const t = k * dt;
      if (t >= tStart) { ts.push(t - tStart); op.push(vp); on.push(vn); }
      const d = levels[k % n] / WAVE_FULL;
      vp = d * VDD + (vp - d * VDD) * e;
      vn = (1 - d) * VDD + (vn - (1 - d) * VDD) * e;
    }
  }
  return { ts, vp: op, vn: on };
}

// ---------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------
export function niceCeil(x) {
  if (x <= 0) return 1;
  const e = Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * 10 ** e >= x * 0.9999) return m * 10 ** e;
  return 10 ** (e + 1);
}

const g = (x, p) => String(Number(x.toPrecision(p)));

export function fmtTime(s) {
  const a = Math.abs(s) * (1 + 1e-9);
  for (const [scale, unit] of [[1, "s"], [1e-3, "ms"], [1e-6, "µs"]]) {
    if (a >= scale) return `${g(s / scale, 4)} ${unit}`;
  }
  return `${g(s * 1e9, 4)} ns`;
}

export function fmtHz(f) {
  if (f >= 1e6) return `${g(f / 1e6, 6)} MHz`;
  if (f >= 1e3) return `${g(f / 1e3, 6)} kHz`;
  return `${g(f, 6)} Hz`;
}

// ---------------------------------------------------------------------
// inverter (src/inverter.cpp の applyCarrier と同じ計算)
// ---------------------------------------------------------------------
export const INV = {
  FC_MIN: 10000, FC_MAX: 120000, F1_MIN: 1, F1_MAX: 1500,
  RATIO: 8, M_MAX: 0.8, M_DC_MAX: 0.3, DUTY_MIN: 0.02, T_LOW_MIN: 1e-6,
};

export function calcInverter(fc) {
  fc = clamp(fc, INV.FC_MIN, INV.FC_MAX);
  const top1 = Math.round(SYS_HZ / (2 * fc));
  const fcAct = SYS_HZ / (2 * top1);
  const dmin = Math.max(INV.DUTY_MIN, INV.T_LOW_MIN * fcAct);
  const lo = Math.ceil(dmin * top1);
  return { top1, fcAct, dmin, dLo: lo / top1, dHi: (top1 - lo) / top1 };
}

// 各脚の duty (0..1)。3P: [U, V, W]、1P: [A, B]
export function invDuties(mode, m, th, rev, c) {
  const cl = (d) => clamp(d, c.dLo, c.dHi);
  if (mode === "1P") {
    const v = m * Math.sin(th);
    return [cl((1 + v) / 2), cl((1 - v) / 2)];
  }
  const s = (k) => (1 + m * Math.sin(th - k * 2 * Math.PI / 3)) / 2;
  return rev ? [cl(s(0)), cl(s(-1)), cl(s(1))] : [cl(s(0)), cl(s(1)), cl(s(-1))];
}
