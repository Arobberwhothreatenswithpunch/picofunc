// オシロ風の描画 (pc/scope.py の Scope クラスの移植)
import { VDD, niceCeil, fmtTime, fmtHz, waveIdeal, waveRc, invDuties, INV } from "./sim.js";

const C = {
  pane: "#11161d", grid: "#222b36", axis: "#3a4656",
  text: "#c9d1d9", dim: "#7d8896",
  ch1: "#f2cc60", ch1b: "#a07e2c",
  p: "#56c8f5", n: "#f07ab0", diff: "#7ee787",
  on: "#3fb950", off: "#7d8896",
};
const MONO = "ui-monospace, Consolas, 'Roboto Mono', monospace";
const SANS = "system-ui, 'Yu Gothic UI', 'Noto Sans JP', sans-serif";
const B_LANE = 4.5;   // CH1 反転出力を表示する縦位置オフセット [V]

export class Scope {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(Math.round(r.width), 200), h = Math.max(Math.round(r.height), 200);
    if (this.cv.width !== w * dpr || this.cv.height !== h * dpr) {
      this.cv.width = w * dpr;
      this.cv.height = h * dpr;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    this.small = w < 520;
    this.fs = this.small ? 10 : 12;
  }

  _text(s, x, y, { color = C.text, align = "left", bold = false, mono = true } = {}) {
    const c = this.ctx;
    c.font = `${bold ? "bold " : ""}${this.fs}px ${mono ? MONO : SANS}`;
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = "middle";
    c.fillText(s, x, y);
    return c.measureText(s).width;
  }

  _pane(x0, y0, x1, y1, vmin, vmax, vdiv, tdiv, title, active, unit = "V") {
    const c = this.ctx;
    const ML = this.small ? 30 : 42, MR = 8, MT = 22, MB = 18;
    c.fillStyle = C.pane;
    c.fillRect(x0, y0, x1 - x0, y1 - y0);
    const px0 = x0 + ML, py0 = y0 + MT, px1 = x1 - MR, py1 = y1 - MB;
    const w = px1 - px0, h = py1 - py0;
    c.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = Math.round(px0 + w * i / 10) + 0.5;
      c.strokeStyle = C.grid;
      c.setLineDash(i % 5 ? [1, 3] : []);
      c.beginPath(); c.moveTo(x, py0); c.lineTo(x, py1); c.stroke();
    }
    const ndiv = Math.round((vmax - vmin) / vdiv);
    for (let i = 0; i <= ndiv; i++) {
      const v = vmin + i * vdiv;
      const y = Math.round(py1 - h * i / ndiv) + 0.5;
      const zero = Math.abs(v) < 1e-9;
      c.strokeStyle = zero ? C.axis : C.grid;
      c.setLineDash(zero ? [] : [1, 3]);
      c.beginPath(); c.moveTo(px0, y); c.lineTo(px1, y); c.stroke();
      this._text(`${+v.toFixed(3)}${unit}`, px0 - 4, y, { color: C.dim, align: "right" });
    }
    c.setLineDash([]);
    c.strokeStyle = C.axis;
    c.strokeRect(px0 + 0.5, py0 + 0.5, w, h);

    const tw = this._text(title, x0 + 8, y0 + 11, { bold: true });
    const [st, col] = active ? ["● 出力中", C.on] : ["○ プレビュー", C.off];
    this._text(st, x0 + 8 + tw + 10, y0 + 11, { color: col, mono: false });
    this._text(`${fmtTime(tdiv)}/div`, px1, py1 + 10, { color: C.dim, align: "right" });

    const map = (t, v) => [px0 + t / (tdiv * 10) * w, py1 - (v - vmin) / (vmax - vmin) * h];
    return { map, box: [px0, py0, px1, py1], legendRight: px1, legendY: y0 + 11 };
  }

  _trace(p, ts, vs, color, width) {
    const [px0, py0, px1, py1] = p.box;
    let pts = [];
    for (let i = 0; i < ts.length; i++) {
      const [x, y] = p.map(ts[i], vs[i]);
      if (x <= px1 + 1) pts.push([x, y]);
    }
    if (pts.length > 2 * (px1 - px0)) {
      // 1ピクセル列ごとに min/max へ間引き (エンベロープ表示)
      const cols = new Map();
      for (const [x, y] of pts) {
        const k = Math.floor(x);
        const m = cols.get(k);
        if (m) { if (y < m[0]) m[0] = y; if (y > m[1]) m[1] = y; } else cols.set(k, [y, y]);
      }
      pts = [];
      for (const k of [...cols.keys()].sort((a, b) => a - b)) {
        const [lo, hi] = cols.get(k);
        pts.push([k, lo], [k, hi]);
      }
    }
    if (pts.length < 2) return;
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(px0, py0 - 1, px1 - px0, py1 - py0 + 2);
    c.clip();
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.stroke();
    c.restore();
  }

  _legend(p, items) {
    if (this.small && items.length > 2) items = items.map(([l, col]) => [l.split(" ")[0], col]);
    let x = p.legendRight;
    const c = this.ctx;
    for (const [label, color] of [...items].reverse()) {
      const w = this._text(label, x, p.legendY, { align: "right", mono: false });
      x -= w + 4;
      c.strokeStyle = color; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x - 14, p.legendY); c.lineTo(x, p.legendY); c.stroke();
      x -= 24;
    }
  }

  // s = { pwm, pwmActive, showB, wave, waveActive, waveMode, rc, show:{p,n,diff} }
  draw(s) {
    this._resize();
    const c = this.ctx, W = this.W, H = this.H;
    c.clearRect(0, 0, W, H);
    const split = Math.round(H * 0.40);

    // ---------- CH1 ----------
    const { pwm } = s;
    let tdiv = niceCeil(pwm.period * 3 / 10);
    let tw = tdiv * 10;
    let p = this._pane(0, 0, W, split - 3, s.showB ? -5 : -1, 4, 1, tdiv,
                       `CH1 PWM  ${fmtHz(pwm.f)}  ${pwm.duty.toFixed(3)}%`, s.pwmActive);
    let ts = [], va = [];
    const T = pwm.period, th = pwm.high;
    for (let k = 0; k * T <= tw; k++) {
      const t0 = k * T;
      ts.push(t0, t0 + th, t0 + th, t0 + T);
      va.push(VDD, VDD, 0, 0);
    }
    if (pwm.duty <= 0) { ts = [0, tw]; va = [0, 0]; }
    else if (pwm.duty >= 100) { ts = [0, tw]; va = [VDD, VDD]; }
    if (s.showB) this._trace(p, ts, va.map((v) => VDD - v - B_LANE), C.ch1b, 1.6);
    this._trace(p, ts, va, C.ch1, 1.8);
    let info = `T=${fmtTime(T)}  High=${fmtTime(th)}  ${pwm.mode}`;
    if (pwm.mode === "HW") info += `  分解能 ${pwm.steps} 段`;
    this._text(info, p.box[0], split - 12, { color: C.dim, mono: false });
    this._legend(p, [["GPIO0", C.ch1], ...(s.showB ? [[`GPIO1 (反転, ${-B_LANE}V 位置)`, C.ch1b]] : [])]);

    // ---------- CH2 ----------
    const { wave } = s;
    tdiv = niceCeil(3 / wave.f / 10);
    tw = tdiv * 10;
    const rcMode = s.waveMode === "rc" && s.rc > 0;
    p = this._pane(0, split + 3, W, H, -4, 4, 1, tdiv,
                   `CH2 WAVE  ${fmtHz(wave.f)}  [${rcMode ? "RC後" : "理想"}]`, s.waveActive);
    const r = rcMode ? waveRc(wave, s.rc, tw) : waveIdeal(wave, tw);
    const diff = r.vp.map((a, i) => a - r.vn[i]);
    if (s.show.p) this._trace(p, r.ts, r.vp, C.p, 1.3);
    if (s.show.n) this._trace(p, r.ts, r.vn, C.n, 1.3);
    if (s.show.diff) this._trace(p, r.ts, diff, C.diff, 1.9);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < r.ts.length; i++) {
      if (r.ts[i] > tw) break;
      if (diff[i] < lo) lo = diff[i];
      if (diff[i] > hi) hi = diff[i];
    }
    const vpp = isFinite(lo) ? hi - lo : 0;
    info = `差動 Vpp=${vpp.toFixed(3)} V  ${wave.n}点/周期  更新 ${fmtHz(wave.fs)}`;
    if (rcMode) info += `  fc=${fmtHz(1 / (2 * Math.PI * s.rc))}`;
    this._text(info, p.box[0], H - 9, { color: C.dim, mono: false });
    this._legend(p, [["p", "+ GP2"], ["n", "− GP3"], ["diff", "差動"]]
      .filter(([k]) => s.show[k]).map(([k, l]) => [l, C[k]]));
    return { vpp };
  }

  // ================= inverter view =================
  // s = { mode, c(calcInverter), f, m, rev, vbus, kind: RUN|DC|AUDIO, theta(rad), active, audio }
  drawInverter(s) {
    this._resize();
    const c = this.ctx, W = this.W, H = this.H;
    c.clearRect(0, 0, W, H);
    const split = Math.round(H * 0.5);
    if (s.kind === "AUDIO") return this._drawInvAudio(s, split);

    const legs = s.mode === "1P" ? ["A (GP4)", "B (GP6)"] : ["U (GP4)", "V (GP6)", "W (GP8)"];
    const cols = [C.ch1, C.p, C.n];
    const dc = s.kind === "DC";
    const tdiv = niceCeil((dc ? 0.01 : 2 / s.f) / 10), tw = tdiv * 10;
    const ratio = s.c.fcAct / s.f;
    const title = dc ? `INV ${s.mode} 直流励磁 θ=${Math.round(s.theta * 180 / Math.PI)}° m=${s.m.toFixed(2)}`
                     : `INV ${s.mode} ${fmtHz(s.f)} m=${s.m.toFixed(2)}`;
    let p = this._pane(0, 0, W, split - 3, 0, 1, 0.25, tdiv, title, s.active, "");

    // carrier triangle (phase-correct: 0 at period start, 1 at the middle)
    const nCar = tw * s.c.fcAct;
    if (nCar <= 150) {
      const ts = [], vs = [];
      for (let k = 0; k <= nCar; k++) { const t0 = k / s.c.fcAct; ts.push(t0, t0 + 0.5 / s.c.fcAct); vs.push(0, 1); }
      this._trace(p, ts, vs, "#3a4656", 1);
    }
    // duty limits
    c.save();
    c.setLineDash([4, 4]); c.strokeStyle = "rgba(248,81,73,.6)"; c.lineWidth = 1;
    for (const d of [s.c.dLo, s.c.dHi]) {
      const y = p.map(0, d)[1];
      c.beginPath(); c.moveTo(p.box[0], y); c.lineTo(p.box[2], y); c.stroke();
    }
    c.restore();

    const N = 600, ts = [], legsV = legs.map(() => []);
    for (let i = 0; i <= N; i++) {
      const t = i / N * tw;
      const th = dc ? s.theta : 2 * Math.PI * s.f * t;
      const d = invDuties(s.mode, s.m, th, s.rev, s.c);
      ts.push(t);
      d.forEach((v, k) => legsV[k].push(v));
    }
    legsV.forEach((v, k) => this._trace(p, ts, v, cols[k], 1.6));
    let info = `fc=${fmtHz(s.c.fcAct)}  duty ${(s.c.dLo * 100).toFixed(1)}–${(s.c.dHi * 100).toFixed(1)}%`;
    if (!dc) info += `  fc/f=${ratio.toFixed(1)}`;
    this._text(info, p.box[0], split - 12, { color: !dc && ratio < INV.RATIO ? "#f85149" : C.dim, mono: false });
    if (!dc && ratio < INV.RATIO) this._text("⚠ キャリアが基本波の8倍未満", p.box[2], p.box[1] + 12, { color: "#f85149", align: "right", mono: false });
    if (!dc && nCar > 150) this._text("キャリア省略表示", p.box[2], p.box[3] - 10, { color: C.dim, align: "right", mono: false });
    this._legend(p, legs.map((l, k) => [l, cols[k]]));

    // ---- line voltages (average over a carrier period) ----
    const vdiv = niceCeil(s.vbus / 4);
    p = this._pane(0, split + 3, W, H, -4 * vdiv, 4 * vdiv, vdiv, tdiv,
                   s.mode === "1P" ? "出力電圧 A−B (平均)" : "線間電圧 (平均)", s.active);
    const pairs = s.mode === "1P" ? [[0, 1, "A−B"]] : [[0, 1, "U−V"], [1, 2, "V−W"], [2, 0, "W−U"]];
    let vpk = 0;
    pairs.forEach(([a, b], k) => {
      const v = legsV[a].map((x, i) => (x - legsV[b][i]) * s.vbus);
      for (const x of v) vpk = Math.max(vpk, Math.abs(x));
      this._trace(p, ts, v, [C.diff, C.ch1b, "#a371f7"][k], k ? 1.2 : 1.8);
    });
    info = dc ? `直流  最大 ${vpk.toFixed(2)} V (母線 ${s.vbus} V)`
              : `Vpk=${vpk.toFixed(2)} V  Vrms≈${(vpk / Math.SQRT2).toFixed(2)} V  (母線 ${s.vbus} V)`;
    this._text(info, p.box[0], H - 9, { color: C.dim, mono: false });
    this._legend(p, pairs.map(([, , l], k) => [l, [C.diff, C.ch1b, "#a371f7"][k]]));

    if (dc && s.mode === "3P") this._phasor(p, s.theta, s.rev);
  }

  // 3P space vector: v = sum v_k e^{j k 120deg} -> angle (theta - 90deg)
  _phasor(p, theta, rev) {
    const c = this.ctx;
    const r = Math.min(40, (p.box[3] - p.box[1]) / 3);
    const cx = p.box[2] - r - 12, cy = p.box[1] + r + 12;
    c.save();
    c.fillStyle = "rgba(13,17,23,.85)";
    c.beginPath(); c.arc(cx, cy, r + 8, 0, 2 * Math.PI); c.fill();
    c.strokeStyle = "#3a4656"; c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, r, 0, 2 * Math.PI); c.stroke();
    const axes = rev ? [["U", 0], ["W", 120], ["V", 240]] : [["U", 0], ["V", 120], ["W", 240]];
    for (const [n, a] of axes) {
      const t = -a * Math.PI / 180;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + r * Math.cos(t), cy + r * Math.sin(t)); c.stroke();
      this._text(n, cx + (r + 6) * Math.cos(t), cy + (r + 6) * Math.sin(t), { color: C.dim, align: "center" });
    }
    const a = -(theta - Math.PI / 2);
    c.strokeStyle = C.diff; c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + r * 0.9 * Math.cos(a), cy + r * 0.9 * Math.sin(a)); c.stroke();
    c.restore();
    this._text("磁界の向き", cx, cy + r + 14, { color: C.dim, align: "center", mono: false });
  }

  _drawInvAudio(s, split) {
    const a = s.audio;
    const H = this.H, W = this.W;
    if (!a) {
      const p = this._pane(0, 0, W, H, -1, 1, 0.5, 0.1, "INV 1P オーディオ", s.active, "");
      this._text("音声ファイルが未選択です", (p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2,
                 { color: C.dim, align: "center", mono: false });
      return;
    }
    const tdiv = niceCeil(a.dur / 10);
    let p = this._pane(0, 0, W, split - 3, -1, 1, 0.5, tdiv, `INV 1P 音声: ${a.name}`, s.active, "");
    const ts = [], vs = [];
    a.env.forEach(([lo, hi], i) => { const t = (i / a.env.length) * a.dur; ts.push(t, t); vs.push(lo, hi); });
    this._trace(p, ts, vs, C.p, 1);
    const c = this.ctx;
    if (a.pos >= 0) {
      const x = p.map(a.pos * a.dur, 0)[0];
      c.strokeStyle = C.ch1; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x, p.box[1]); c.lineTo(x, p.box[3]); c.stroke();
    }
    this._text(`fs=${fmtHz(a.fs)}  帯域 ${fmtHz(a.bw)}  長さ ${a.dur.toFixed(1)} s`, p.box[0], split - 12,
               { color: C.dim, mono: false });

    const vdiv = niceCeil(s.vbus / 4);
    p = this._pane(0, split + 3, W, H, -4 * vdiv, 4 * vdiv, vdiv, tdiv, "出力電圧 A−B (平均)", s.active);
    this._trace(p, ts, vs.map((v) => v * s.m * s.vbus), C.diff, 1);
    this._text(`最大 ±${(s.m * s.vbus).toFixed(1)} V (音量 m=${s.m.toFixed(2)}, 母線 ${s.vbus} V)`, p.box[0], H - 9,
               { color: C.dim, mono: false });
  }
}
