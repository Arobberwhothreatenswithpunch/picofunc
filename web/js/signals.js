// 表示チャンネルの組み立て
// 各チャンネルは v(t) (時刻 t の電圧) と span(t0, t1) (区間の最小/最大 = 描画用) を持つ。
//   period   : 基本波の周期 (測定のエイリアシング判定)
//   tbPeriod : 画面で見える繰り返しの周期 (自動時間軸の基準。スイッチング表示ではキャリア周期)
//   fsw / avg: スイッチング周波数と局所平均 (duty × 電圧)。縮小表示の平均波形と、FFT のアンチエイリアスに使う
//   fswMargin: キャリア側波帯の広がり (fsw − fswMargin が FFT の表示スパンより上なら平均値でサンプリング)
// 計算はファームウェアと同じ sim.js を使う。
import { VDD, WAVE_FULL, waveRc, invDuties, niceCeil } from "./sim.js";

export const COLORS = { 1: "#f4e21c", 2: "#3fe35a", 3: "#4aa8ff", 4: "#ff5f8f", M: "#c27dff" };
export const DIM = { 1: "#8f8417", 2: "#278a39", 3: "#2f6aa3", 4: "#a33d5c", M: "#7a4fa3" };

const mod = (t, p) => ((t % p) + p) % p;

function spanSample(v, t0, t1, k = 6) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= k; i++) {
    const x = v(t0 + ((t1 - t0) * i) / k);
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return [lo, hi];
}

// 周期 p の繰り返し波形を (ts, vs) の点列から作る (ts は 0..p の昇順)
function periodicArray(ts, vs, p) {
  const n = ts.length;
  let gLo = Infinity, gHi = -Infinity;
  for (const v of vs) { if (v < gLo) gLo = v; if (v > gHi) gHi = v; }
  const idx = (t) => {
    let a = 0, b = n - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (ts[m] <= t) a = m; else b = m; }
    return a;
  };
  const at = (u) => {
    if (u <= ts[0]) return vs[0];
    if (u >= ts[n - 1]) return vs[n - 1];
    const i = idx(u), dt = ts[i + 1] - ts[i];
    return dt > 0 ? vs[i] + ((vs[i + 1] - vs[i]) * (u - ts[i])) / dt : vs[i + 1];
  };
  const v = (t) => at(mod(t, p));
  const spanIn = (u0, u1) => {          // 0 <= u0 <= u1 <= p
    let lo = Math.min(at(u0), at(u1)), hi = Math.max(at(u0), at(u1));
    for (let i = idx(u0) + 1; i < n && ts[i] < u1; i++) { if (vs[i] < lo) lo = vs[i]; if (vs[i] > hi) hi = vs[i]; }
    return [lo, hi];
  };
  const span = (t0, t1) => {
    if (t1 - t0 >= p) return [gLo, gHi];
    const u0 = mod(t0, p), u1 = u0 + (t1 - t0);
    if (u1 <= p) return spanIn(u0, u1);
    const a = spanIn(u0, p), b = spanIn(0, u1 - p);
    return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
  };
  return { v, span };
}

// ---------------------------------------------------------------------
// 信号源 (CH1 PWM / CH2 波形)
// ---------------------------------------------------------------------
function genChannels(st) {
  const { pwm, wave } = st;
  // 接続中で出力 OFF のピンは Low (ファームウェアの停止動作と同じ)。未接続 / 設定プレビューなら設定値
  const pwmOn = !st.actual || st.active.pwm;
  const waveOn = !st.actual || st.active.wave;

  const T = pwm.period, th = pwm.high, d = pwmOn ? pwm.duty : 0;
  const v1 = d <= 0 ? () => 0 : d >= 100 ? () => VDD : (t) => (mod(t, T) < th ? VDD : 0);
  const span1 = (t0, t1) => {
    if (d <= 0 || d >= 100) { const x = v1(t0); return [x, x]; }
    if (t1 - t0 >= T) return [0, VDD];
    const k0 = Math.floor(t0 / T), k1 = Math.floor(t1 / T);
    const edge = k1 > k0 || (t0 < k0 * T + th && k0 * T + th <= t1) || (t0 < k1 * T + th && k1 * T + th <= t1);
    if (edge) return [0, VDD];
    const x = v1(t0);
    return [x, x];
  };
  const sw1 = d > 0 && d < 100;
  const avg1 = (d / 100) * VDD;
  const ch1 = {
    id: "1", label: "GP0", color: COLORS[1], vdiv: 1, pos: 0.5, v: v1, span: span1, period: T, tbPeriod: T,
    fsw: sw1 ? 1 / T : 0, fswMargin: 0, avg: sw1 ? () => avg1 : null, active: st.active.pwm, off: !pwmOn,
    extra: st.showB ? [{
      color: DIM[1], v: (t) => (pwmOn ? VDD - v1(t) : 0),
      span: (a, b) => { if (!pwmOn) return [0, 0]; const [lo, hi] = span1(a, b); return [VDD - hi, VDD - lo]; },
      fsw: sw1 ? 1 / T : 0, avg: sw1 ? () => VDD - avg1 : null,
    }] : [],
  };

  // CH2: 1 周期ぶんを計算して繰り返す (定常状態)
  const P = 1 / wave.f;
  let vp, vn, spP, spN;
  if (!waveOn) {
    vp = vn = () => 0;
    spP = spN = () => [0, 0];
  } else if (st.probe === "rc" && st.rc > 0) {
    const r = waveRc(wave, st.rc, P * 1.02);
    const ap = periodicArray(r.ts, r.vp, P), an = periodicArray(r.ts, r.vn, P);
    vp = ap.v; vn = an.v; spP = ap.span; spN = an.span;
  } else {
    const { n, fs, levels } = wave;
    vp = (t) => (levels[mod(Math.floor(t * fs), n)] / WAVE_FULL) * VDD;
    vn = (t) => VDD - vp(t);
    spP = (a, b) => spanSample(vp, a, b);
    spN = (a, b) => spanSample(vn, a, b);
  }
  const vd = (t) => vp(t) - vn(t);
  const common = { vdiv: 2, pos: -2, period: waveOn ? P : null, tbPeriod: P, active: st.active.wave, off: !waveOn };
  const note = st.actual && !st.active.pwm && !st.active.wave ? "出力 OFF（表示メニュー → 設定プレビュー で設定値を表示）" : "";
  return {
    note,
    chans: [
      ch1,
      { ...common, id: "2", label: "差動", color: COLORS[2], v: vd, span: (a, b) => spanSample(vd, a, b, 8) },
      { ...common, id: "3", label: "GP2(+)", color: COLORS[3], v: vp, span: spP },
      { ...common, id: "4", label: "GP3(−)", color: COLORS[4], v: vn, span: spN },
    ],
  };
}

// ---------------------------------------------------------------------
// インバータ
// ---------------------------------------------------------------------
function invChannels(st) {
  const s = st.inv;
  const c = s.c;
  const sw = st.invView === "sw";
  const legsN = s.mode === "1P" ? 2 : 3;
  const names = s.mode === "1P" ? ["A", "B"] : ["U", "V", "W"];
  const clampD = (d) => Math.min(Math.max(d, c.dLo), c.dHi);

  // 各脚の duty d(t)。fswMargin = キャリア側波帯の広がり (FFT の表示範囲判定に使う)
  let duty, period = null, note = "", fswMargin = 0, switching = true;
  if (s.kind === "OFF") {
    // SD = Low: ドライバ停止、全 IN = Low
    const z = new Array(legsN).fill(0);
    duty = () => z;
    switching = false;
    note = "インバータ停止中 (SD = Low)";
  } else if (s.kind === "IDLE") {
    const d = invDuties(s.mode, 0, 0, s.rev, c);      // m = 0 → 全脚 50 %
    duty = () => d;
    note = "待機中 (IDLE: 全脚 50 %)";
  } else if (s.kind === "AUDIO") {
    const a = s.audio;
    if (!a || !a.pcm) {
      note = "音声ファイルが未選択です (インバータ → 単相 → オーディオ)";
      duty = () => [0.5, 0.5];
    } else {
      const start = a.pos >= 0 ? a.pos * a.pcm.length : 0;
      const x = (t) => {
        const u = start + t * a.fs, i = Math.floor(u);
        if (i < 0 || i + 1 >= a.pcm.length) return 0;
        return (a.pcm[i] + (a.pcm[i + 1] - a.pcm[i]) * (u - i)) / 32768;
      };
      duty = (t) => { const v = s.m * x(t); return [clampD((1 + v) / 2), clampD((1 - v) / 2)]; };
      fswMargin = a.bw || 0;
    }
  } else if (s.kind === "DC") {
    const d = invDuties(s.mode, s.m, s.theta, s.rev, c);
    duty = () => d;
  } else {
    const w = 2 * Math.PI * s.f;
    duty = (t) => invDuties(s.mode, s.m, w * t, s.rev, c);
    period = 1 / s.f;
    fswMargin = 5 * s.f;
  }

  // 同じ時刻の duty を 3 脚・線間で使い回す
  {
    const raw = duty;
    let lastT = NaN, lastD = null;
    duty = (t) => (t === lastT ? lastD : ((lastT = t), (lastD = raw(t))));
  }

  // 三角キャリア (phase-correct: 周期の始めで 0、中央で 1)。tri < d の間 High
  const fc = c.fcAct;
  const swOn = sw && switching;
  const tri = (t) => { const u = mod(t * fc, 1); return u < 0.5 ? 2 * u : 2 - 2 * u; };
  const leg = (k) => swOn ? (t) => (tri(t) < duty(t)[k] ? VDD : 0) : (t) => duty(t)[k] * VDD;
  const tbPeriod = swOn ? 1 / fc : period;
  const legSpan = (k, v) => swOn
    ? (a, b) => (b - a >= 1 / fc ? [0, VDD] : spanSample(v, a, b, 8))
    : (a, b) => spanSample(v, a, b, 4);

  // 平均表示は重ねる。スイッチング表示は矩形波が重なって見えないので縦に並べる
  const legPos = sw ? (legsN === 3 ? [2.2, 0.3, -1.6] : [2.2, 0.3]) : [0.5, 0.5, 0.5];
  const swProps = (avg) => (swOn ? { fsw: fc, fswMargin, avg } : { fsw: 0, avg: null });
  const chans = [];
  for (let k = 0; k < legsN; k++) {
    const v = leg(k);
    chans.push({ id: String(k + 1), label: names[k], color: COLORS[k + 1], vdiv: sw ? 2 : 1, pos: legPos[k], v,
                 span: legSpan(k, v), period, tbPeriod, active: s.active, ...swProps((t) => duty(t)[k] * VDD) });
  }
  const vb = s.vbus;
  const line = (a, b) => {
    const va = chans[a].v, vbb = chans[b].v;
    return (t) => ((va(t) - vbb(t)) / VDD) * vb;
  };
  const lineAvg = (a, b) => (t) => { const d = duty(t); return (d[a] - d[b]) * vb; };
  const lineSpan = (v) => swOn ? (a, b) => (b - a >= 1 / fc ? [-vb, vb] : spanSample(v, a, b, 8)) : (a, b) => spanSample(v, a, b, 4);
  const vm = line(0, 1);
  const m = {
    id: "M", label: s.mode === "1P" ? "A−B" : "U−V", color: COLORS.M,
    vdiv: sw ? niceCeil(vb / 0.6) : niceCeil(vb / 2), pos: sw ? (legsN === 3 ? -3.1 : -2.2) : -2, v: vm, span: lineSpan(vm),
    period, tbPeriod, active: s.active, extra: [], ...swProps(lineAvg(0, 1)),
  };
  if (st.mAll && legsN === 3) {
    for (const [a, b, col] of [[1, 2, "#8f5bd6"], [2, 0, "#e0a3ff"]]) {
      const v = line(a, b);
      m.extra.push({ color: col, v, span: lineSpan(v), ...swProps(lineAvg(a, b)) });
    }
  }
  chans.push(m);
  if (s.kind === "OFF") for (const ch of chans) ch.off = true;

  let defaultTdiv = 1e-3;
  if (swOn && !period) defaultTdiv = niceCeil(3 / fc / 10);
  return { chans, note, defaultTdiv, phasor: s.kind === "DC" && s.mode === "3P" ? { theta: s.theta, rev: s.rev } : null };
}

// st = { mode: "gen"|"inv", ...各状態 }
export function buildChannels(st) {
  const r = st.mode === "inv" ? invChannels(st) : genChannels(st);
  return { channels: r.chans, note: r.note, defaultTdiv: r.defaultTdiv || 1e-3, phasor: r.phasor || null };
}
