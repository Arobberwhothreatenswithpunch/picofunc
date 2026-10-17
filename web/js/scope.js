// オシロ風の描画 (pc/scope.py の Scope クラスの移植)
import { VDD, niceCeil, fmtTime, fmtHz, waveIdeal, waveRc } from "./sim.js";

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

  _pane(x0, y0, x1, y1, vmin, vmax, vdiv, tdiv, title, active) {
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
      this._text(`${v}V`, px0 - 4, y, { color: C.dim, align: "right" });
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
}
